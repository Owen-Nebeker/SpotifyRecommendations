const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

// Development only - disable SSL cert verification for Spotify OAuth
if (process.env.NODE_ENV !== 'production') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://127.0.0.1:3000',
  credentials: true,
}));
app.use(bodyParser.json());

const client = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

// Spotify API base URL
const SPOTIFY_API_URL = 'https://api.spotify.com/v1';
const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/api/token';

// Store tokens in-memory (use proper session store in production)
const userSessions = new Map();

// Generate random state for OAuth
function generateState() {
  return Math.random().toString(36).substring(7);
}

// Spotify OAuth: Get login URL
app.get('/api/auth/login', (req, res) => {
  const state = generateState();
  const params = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
    scope: 'playlist-read-private playlist-read-collaborative',
    state,
  });

  const loginUrl = `https://accounts.spotify.com/authorize?${params}`;
  res.json({ loginUrl });
});

// Spotify OAuth: Callback handler (redirect from Spotify)
app.get('/api/auth/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect(`${process.env.FRONTEND_URL}?error=${error}`);
  }

  if (!code) {
    return res.redirect(`${process.env.FRONTEND_URL}?error=no_code`);
  }

  try {
    const tokenResponse = await axios.post(SPOTIFY_AUTH_URL, null, {
      params: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
        client_id: process.env.SPOTIFY_CLIENT_ID,
        client_secret: process.env.SPOTIFY_CLIENT_SECRET,
      },
    });

    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    const sessionId = generateState();

    userSessions.set(sessionId, {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + expires_in * 1000,
    });

    res.redirect(`${process.env.FRONTEND_URL}?sessionId=${sessionId}`);
  } catch (error) {
    console.error('OAuth error:', error.response?.data || error.message);
    res.redirect(`${process.env.FRONTEND_URL}?error=auth_failed`);
  }
});

// Spotify OAuth: Callback handler (POST version for testing)
app.post('/api/auth/callback', async (req, res) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: 'No authorization code' });
  }

  try {
    const tokenResponse = await axios.post(SPOTIFY_AUTH_URL, null, {
      params: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
        client_id: process.env.SPOTIFY_CLIENT_ID,
        client_secret: process.env.SPOTIFY_CLIENT_SECRET,
      },
    });

    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    const sessionId = generateState();

    userSessions.set(sessionId, {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + expires_in * 1000,
    });

    res.json({ sessionId, expiresIn: expires_in });
  } catch (error) {
    console.error('OAuth error:', error.response?.data || error.message);
    res.status(401).json({ error: 'Authentication failed' });
  }
});

// Get user's playlists
app.get('/api/playlists', async (req, res) => {
  const { sessionId } = req.query;
  const session = userSessions.get(sessionId);

  if (!session) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  try {
    const response = await axios.get(`${SPOTIFY_API_URL}/me/playlists`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      params: { limit: 50 },
    });

    if (!response.data || !Array.isArray(response.data.items)) {
      return res.status(500).json({ error: 'Invalid Spotify response' });
    }

    // Diagnostic: log the shape of the first playlist so we can see what Spotify returns
    if (response.data.items.length > 0) {
      const sample = response.data.items[0];
      console.log('Sample playlist from Spotify:', JSON.stringify({
        name: sample?.name,
        tracks: sample?.tracks,
        keys: sample ? Object.keys(sample) : null,
      }, null, 2));
    }

    const playlists = response.data.items.filter(p => p !== null).map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      imageUrl: p.images?.[0]?.url,
      trackCount: p.tracks?.total || 0,
    }));

    res.json({ playlists });
  } catch (error) {
    console.error('Playlists error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

// Get full playlist tracks (paginated)
async function getAllPlaylistTracks(accessToken, playlistId) {
  const allTracks = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const response = await axios.get(
      `${SPOTIFY_API_URL}/playlists/${playlistId}/tracks`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { offset, limit },
      }
    );

    const tracks = response.data.items
      .filter(item => item.track !== null)
      .map(item => {
        const track = item.track;
        return {
          id: track.id,
          name: track.name,
          artists: track.artists.map(a => a.name),
          composer: track.artists?.[0]?.name,
          genres: track.album?.genres || [],
          duration: track.duration_ms,
          year: track.album?.release_date?.split('-')[0],
        };
      });

    allTracks.push(...tracks);

    if (response.data.next) {
      offset += limit;
    } else {
      break;
    }
  }

  return allTracks;
}

// Analyze playlist with Claude
app.post('/api/analyze', async (req, res) => {
  const { sessionId, playlistId, playlistName } = req.body;
  const session = userSessions.get(sessionId);

  if (!session) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  try {
    const tracks = await getAllPlaylistTracks(session.accessToken, playlistId);

    // Format tracks for Claude
    const trackList = tracks
      .slice(0, 200) // Limit to 200 tracks for context
      .map(t => `${t.name} - ${t.artists.join(', ')} (${t.year || 'Unknown year'})`)
      .join('\n');

    const prompt = `You are an expert classical music analyst. Analyze this classical music playlist and provide:

1. **Composition Period & Style**: What era(s) of classical music dominate?
2. **Key Themes**: What emotional or thematic threads connect the pieces?
3. **Performance Style**: Any notable patterns in conductor/orchestra choices or recording era?
4. **Overall Mood**: In 2-3 sentences, describe the listening experience and emotional arc.

Playlist Name: "${playlistName}"
Track Count: ${tracks.length}

Tracks:
${trackList}

Provide a brief, insightful analysis (150-200 words) focused on what makes this collection cohesive.`;

    const message = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const analysis = message.content[0].text;
    res.json({ analysis, trackCount: tracks.length });
  } catch (error) {
    const detail = error.response?.data?.error || error.error?.message || error.message || 'Unknown error';
    console.error('Analysis error:', detail);
    res.status(500).json({ error: `Failed to analyze playlist: ${JSON.stringify(detail)}` });
  }
});

// Get recommendations
app.post('/api/recommend', async (req, res) => {
  const { sessionId, playlistId } = req.body;
  const session = userSessions.get(sessionId);

  if (!session) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  try {
    const tracks = await getAllPlaylistTracks(session.accessToken, playlistId);

    // Format for Claude
    const trackList = tracks
      .slice(0, 150)
      .map(t => `${t.name} - ${t.artists.join(', ')}`)
      .join('\n');

    const composersSet = new Set(tracks.slice(0, 50).map(t => t.composer));
    const topComposers = Array.from(composersSet).slice(0, 10).join(', ');

    const prompt = `You are a classical music expert. Based on this playlist, recommend 15 classical music tracks that fit the same style and mood.

Key Composers in Playlist: ${topComposers}

Recent Tracks:
${trackList}

Please recommend 15 tracks in this format:
1. [Piece Name] - [Composer] - [Performer/Conductor if notable]
2. [Next recommendation...]
etc.

Focus on:
- Similar composition period and style
- Lesser-known works by featured composers
- Quality recordings/notable performers
- Thematic or harmonic connections to the playlist

Return ONLY the numbered list, no additional text.`;

    const message = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 800,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const recommendations = message.content[0].text;
    res.json({ recommendations });
  } catch (error) {
    const detail = error.response?.data?.error || error.error?.message || error.message || 'Unknown error';
    console.error('Recommendation error:', detail);
    res.status(500).json({ error: `Failed to generate recommendations: ${JSON.stringify(detail)}` });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
