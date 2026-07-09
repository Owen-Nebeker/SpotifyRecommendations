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

// Claude responses may include non-text blocks (e.g. thinking) before the
// text block, so don't assume content[0] is the text.
function extractText(message) {
  const block = message.content.find(b => b.type === 'text');
  return block ? block.text : '';
}

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
    scope: 'playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private',
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

    // Spotify's Feb 2026 API migration renamed the playlist "tracks" field to "items".
    // Support both shapes in case of transition-period responses.
    const playlists = response.data.items.filter(p => p !== null).map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      imageUrl: p.images?.[0]?.url,
      trackCount: p.items?.total ?? p.tracks?.total ?? 0,
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
    // Feb 2026 Spotify API migration: /playlists/{id}/tracks was replaced by
    // /playlists/{id}/items, and each entry's "track" field was renamed "item".
    const response = await axios.get(
      `${SPOTIFY_API_URL}/playlists/${playlistId}/items`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { offset, limit },
      }
    );

    const tracks = response.data.items
      .map(entry => entry.item ?? entry.track)
      .filter(track => track != null)
      .map(track => ({
        id: track.id,
        name: track.name,
        artists: (track.artists || []).map(a => a.name),
        composer: track.artists?.[0]?.name,
        genres: track.album?.genres || [],
        duration: track.duration_ms,
        year: track.album?.release_date?.split('-')[0],
      }));

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

    const prompt = `You are an expert classical music analyst. Analyze this classical music playlist and cover:

1. **Composition Period & Style**: What era(s) of classical music dominate?
2. **Key Themes**: What emotional or thematic threads connect the pieces?
3. **Performance Style**: Any notable patterns in conductor/orchestra choices or recording era?
4. **Overall Mood**: In 2-3 sentences, describe the listening experience and emotional arc.

Playlist Name: "${playlistName}"
Track Count: ${tracks.length}

Tracks:
${trackList}

Format your response as clean Markdown: a "### " header for each of the four sections, with short bullet points under each (bold key terms like composer names and musical terms). No top-level title, no preamble — start directly with the first section header. Keep the whole analysis under 250 words and make sure it is complete (do not trail off).`;

    const message = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const analysis = extractText(message);
    res.json({ analysis, trackCount: tracks.length });
  } catch (error) {
    const detail = error.response?.data?.error || error.error?.message || error.message || 'Unknown error';
    console.error('Analysis error:', detail);
    res.status(500).json({ error: `Failed to analyze playlist: ${JSON.stringify(detail)}` });
  }
});

// Recommendation weighting rubric (verbatim — do not edit)
const CLASSICAL_REC_WEIGHTS = `<Classical-rec weights: Composer/school 28%: first listed artist = composer; normalize/fact-check name; infer era/sub-era, national school, harmonic language, and adjacent composers; trust repeated patterns over one-offs. Work type/instrumentation 24%: match actual forces/form—solo piano, chamber, quartet, concerto, symphony, opera/lieder, choral/sacred, ballet, early/HIP, etc.; ensemble size/timbre matters more than generic “classical.” Movement/vibe 20%: tempo/marking, affect, texture, intensity, lyricism vs virtuosity/drama, sacred/dance/pastoral/tragic, tonal/modernist, long/miniature; match liked movements even across different composers. Performer/recording 13%: secondary artists = performers/conductors/ensembles/singers; weight heavily only if repeated; otherwise pick esteemed, style-appropriate recordings, noting HIP vs modern when relevant. Serendipity/anti-popularity 8%: include 1–2 tasteful adventurous picks when possible—lesser-known works by liked composers, adjacent niche composers/schools, unusual forms, neglected movements, or elite recordings outside the obvious canon; avoid generic popularity defaults unless strongly supported by the playlist. Quality/discovery/hygiene 7%: recommend elite adjacent works, not generic greatest hits; avoid exact works/movements already in playlist; normalize full work/movement/catalog duplicates; alternate recordings only when the performer is the point; make most picks close-fit elite choices, but include a small “adventurous” slice that is clearly justified by the user’s taste rather than by general classical popularity.>`;

// Parse Claude's numbered list into structured recommendations
function parseRecommendations(text) {
  const recs = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*\d+\.\s*(.+)$/);
    if (!m) continue;
    const parts = m[1].split(' - ').map(s => s.trim());
    recs.push({
      piece: parts[0] || '',
      composer: parts[1] || '',
      performer: parts.slice(2).join(' - ') || '',
    });
  }
  return recs;
}

// Look up a recommended piece on Spotify (album art, link, URI)
async function searchSpotifyTrack(accessToken, rec) {
  try {
    const q = [rec.piece, rec.composer].filter(Boolean).join(' ');
    const resp = await axios.get(`${SPOTIFY_API_URL}/search`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { q, type: 'track', limit: 1 },
    });
    const track = resp.data?.tracks?.items?.[0];
    if (!track) return null;
    return {
      trackId: track.id,
      trackName: track.name,
      trackArtists: (track.artists || []).map(a => a.name).join(', '),
      albumArt: track.album?.images?.[1]?.url || track.album?.images?.[0]?.url || null,
      url: track.external_urls?.spotify || null,
      uri: track.uri,
    };
  } catch (error) {
    console.error('Spotify search error for', rec.piece, '-', error.response?.status || error.message);
    return null;
  }
}

// Get recommendations
app.post('/api/recommend', async (req, res) => {
  const { sessionId, playlistId } = req.body;
  const session = userSessions.get(sessionId);

  if (!session) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  try {
    const tracks = await getAllPlaylistTracks(session.accessToken, playlistId);

    const trackList = tracks
      .slice(0, 150)
      .map(t => `${t.name} - ${t.artists.join(', ')}`)
      .join('\n');

    const prompt = `You are a classical music expert recommendation engine. Recommend 15 classical music tracks based on the playlist below.

Score and select candidates using EXACTLY this weighting rubric:

${CLASSICAL_REC_WEIGHTS}

Playlist tracks (title - artists, where the first artist is the composer):
${trackList}

Return ONLY a numbered list of 15 recommendations, one per line, in exactly this format (three fields separated by " - "):
1. Piece Name - Composer - Performer/Conductor

No brackets, no extra commentary, no headers.`;

    const message = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1200,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const rawText = extractText(message);
    const parsed = parseRecommendations(rawText);

    // Enrich each recommendation with real Spotify track data (album art, link, URI)
    const recommendations = await Promise.all(
      parsed.map(async rec => {
        const match = await searchSpotifyTrack(session.accessToken, rec);
        return { ...rec, ...(match || {}) };
      })
    );

    res.json({ recommendations });
  } catch (error) {
    const detail = error.response?.data?.error || error.error?.message || error.message || 'Unknown error';
    console.error('Recommendation error:', detail);
    res.status(500).json({ error: `Failed to generate recommendations: ${JSON.stringify(detail)}` });
  }
});

// Add a recommended track to the user's playlist
app.post('/api/playlist/add', async (req, res) => {
  const { sessionId, playlistId, uri } = req.body;
  const session = userSessions.get(sessionId);

  if (!session) {
    return res.status(401).json({ error: 'Invalid session' });
  }
  if (!playlistId || !uri) {
    return res.status(400).json({ error: 'Missing playlistId or uri' });
  }

  try {
    await axios.post(
      `${SPOTIFY_API_URL}/playlists/${playlistId}/items`,
      { uris: [uri] },
      {
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
    res.json({ success: true });
  } catch (error) {
    const detail = error.response?.data?.error || error.message || 'Unknown error';
    console.error('Add track error:', detail);
    res.status(500).json({ error: `Failed to add track: ${JSON.stringify(detail)}` });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
