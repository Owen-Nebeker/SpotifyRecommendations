const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

// Development only - disable SSL cert verification for Spotify OAuth
if (process.env.NODE_ENV !== 'production') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const app = express();
const PORT = process.env.PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://127.0.0.1:3000';
const SPOTIFY_REDIRECT_URI =
  process.env.SPOTIFY_REDIRECT_URI || `http://127.0.0.1:${PORT}/api/auth/callback`;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

const allowedOrigins = new Set([
  FRONTEND_URL,
  'http://127.0.0.1:3000',
  'http://localhost:3000',
]);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

const client = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

// Spotify API base URL
const SPOTIFY_API_URL = 'https://api.spotify.com/v1';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_WINDOW_MS = 60 * 1000;

// Store tokens in-memory (use proper session store in production)
const userSessions = new Map();
const pendingOAuthStates = new Map();

// Claude responses may include non-text blocks (e.g. thinking) before the
// text block, so don't assume content[0] is the text.
function extractText(message) {
  if (typeof message?.output_text === 'string') {
    return message.output_text;
  }

  if (!Array.isArray(message?.content)) {
    return '';
  }

  return message.content
    .map(block => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text' && typeof block.text === 'string') return block.text;
      if (typeof block?.text === 'string') return block.text;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function describeClaudeMessage(message) {
  return {
    id: message?.id,
    model: message?.model,
    stopReason: message?.stop_reason,
    contentTypes: Array.isArray(message?.content)
      ? message.content.map(block => block?.type || typeof block)
      : [],
    usage: message?.usage,
  };
}

// Generate random state for OAuth
function generateState() {
  return crypto.randomBytes(24).toString('hex');
}

function consumeOAuthState(state) {
  const expiresAt = pendingOAuthStates.get(state);
  pendingOAuthStates.delete(state);
  return Boolean(expiresAt && expiresAt > Date.now());
}

function cleanupOAuthStates() {
  const now = Date.now();
  for (const [state, expiresAt] of pendingOAuthStates.entries()) {
    if (expiresAt <= now) {
      pendingOAuthStates.delete(state);
    }
  }
}

function missingEnv(keys) {
  return keys.filter(key => !process.env[key]);
}

function spotifyAuthHeader() {
  const credentials = `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

async function exchangeSpotifyCode(code) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: SPOTIFY_REDIRECT_URI,
  });

  const tokenResponse = await axios.post(SPOTIFY_TOKEN_URL, form.toString(), {
    headers: {
      Authorization: spotifyAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  return tokenResponse.data;
}

async function refreshSpotifyToken(session) {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
  });

  const tokenResponse = await axios.post(SPOTIFY_TOKEN_URL, form.toString(), {
    headers: {
      Authorization: spotifyAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  const { access_token, refresh_token, expires_in } = tokenResponse.data;
  session.accessToken = access_token;
  session.refreshToken = refresh_token || session.refreshToken;
  session.expiresAt = Date.now() + expires_in * 1000;

  return session.accessToken;
}

async function getValidAccessToken(sessionId) {
  const session = userSessions.get(sessionId);

  if (!session) {
    const error = new Error('Invalid session');
    error.status = 401;
    throw error;
  }

  if (session.expiresAt - Date.now() <= TOKEN_REFRESH_WINDOW_MS) {
    try {
      await refreshSpotifyToken(session);
    } catch (refreshError) {
      userSessions.delete(sessionId);
      const error = new Error('Session expired. Please sign in again.');
      error.status = 401;
      error.cause = refreshError;
      throw error;
    }
  }

  return session.accessToken;
}

function authRedirect(error) {
  const params = new URLSearchParams({ error });
  return `${FRONTEND_URL}?${params}`;
}

function parseClaudeJson(text, fallback) {
  if (!text) return fallback;

  const cleaned = stripCodeFence(text);
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  const start = [firstBrace, firstBracket].filter(index => index >= 0).sort((a, b) => a - b)[0];

  if (start === undefined) {
    return fallback;
  }

  const endChar = cleaned[start] === '[' ? ']' : '}';
  const end = cleaned.lastIndexOf(endChar);

  if (end < start) {
    return fallback;
  }

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (error) {
    console.error('Claude JSON parse error:', error.message);
    return fallback;
  }
}

function stripCodeFence(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json|markdown|md)?\s*/i, '')
    .replace(/\s*```$/i, '');
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const ROMAN_NUMERALS = new Map([
  ['i', '1'],
  ['ii', '2'],
  ['iii', '3'],
  ['iv', '4'],
  ['v', '5'],
  ['vi', '6'],
  ['vii', '7'],
  ['viii', '8'],
  ['ix', '9'],
  ['x', '10'],
]);

const CLASSICAL_TITLE_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'arr',
  'arranged',
  'by',
  'catalog',
  'de',
  'der',
  'des',
  'die',
  'du',
  'et',
  'excerpt',
  'flat',
  'for',
  'from',
  'in',
  'la',
  'le',
  'les',
  'live',
  'major',
  'minor',
  'movement',
  'mvt',
  'no',
  'nr',
  'of',
  'on',
  'op',
  'opus',
  'or',
  'part',
  'remastered',
  'sharp',
  'the',
  'to',
  'transcribed',
  'version',
  'with',
]);

function normalizeRomanNumerals(text) {
  return text
    .split(/\s+/)
    .map(token => ROMAN_NUMERALS.get(token) || token)
    .join(' ');
}

function extractCatalogKeys(value) {
  const text = normalizeRomanNumerals(normalizeText(value));
  const keys = new Set();
  const patterns = [
    [/\b(?:op|opus)\s*(\d+[a-z]?)\s*(?:(?:no|nr|n)\s*(\d+[a-z]?))?/g, match => `op-${match[1]}${match[2] ? `-${match[2]}` : ''}`],
    [/\b(?:d)\s*(\d+[a-z]?)\b/g, match => `d-${match[1]}`],
    [/\b(?:k|kv)\s*(\d+[a-z]?)\b/g, match => `k-${match[1]}`],
    [/\bbwv\s*(\d+[a-z]?)\b/g, match => `bwv-${match[1]}`],
    [/\brv\s*(\d+[a-z]?)\b/g, match => `rv-${match[1]}`],
    [/\bhob\s*([a-z]+)?\s*(\d+[a-z]?)\b/g, match => `hob-${match[1] || ''}-${match[2]}`],
    [/\bs\s*(\d+[a-z]?)\b/g, match => `s-${match[1]}`],
  ];

  for (const [pattern, formatter] of patterns) {
    for (const match of text.matchAll(pattern)) {
      keys.add(formatter(match));
    }
  }

  return keys;
}

function removeCatalogPhrases(value) {
  return normalizeRomanNumerals(normalizeText(value))
    .replace(/\b(?:op|opus)\s*\d+[a-z]?(?:\s*(?:no|nr|n)\s*\d+[a-z]?)?/g, ' ')
    .replace(/\b(?:d|k|kv|bwv|rv|s)\s*\d+[a-z]?\b/g, ' ')
    .replace(/\bhob\s*[a-z]*\s*\d+[a-z]?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeClassicalTitle(title, composer = '') {
  const composerTokens = new Set(normalizeText(composer).split(/\s+/).filter(Boolean));
  return removeCatalogPhrases(title)
    .split(/\s+/)
    .filter(token => (
      token &&
      (token.length > 1 || /^\d+$/.test(token)) &&
      !CLASSICAL_TITLE_STOPWORDS.has(token) &&
      !composerTokens.has(token)
    ));
}

function buildWorkIdentity(title, composer = '') {
  const normalizedTitle = normalizeRomanNumerals(normalizeText(title));
  const normalizedComposer = normalizeText(composer);
  const composerTokens = normalizedComposer.split(/\s+/).filter(Boolean);
  const composerLast = composerTokens[composerTokens.length - 1] || '';
  const titleTokens = tokenizeClassicalTitle(title, composer);

  return {
    catalogKeys: extractCatalogKeys(`${title} ${composer}`),
    composerKey: normalizedComposer,
    composerLast,
    display: `${composer ? `${composer} - ` : ''}${title}`,
    normalizedTitle,
    titleTokenSet: new Set(titleTokens),
    titleTokens,
  };
}

function composersCompatible(left, right) {
  if (!left.composerKey || !right.composerKey) {
    return Boolean(
      left.composerLast &&
      (right.normalizedTitle.includes(left.composerLast) || right.composerKey.includes(left.composerLast))
    ) || Boolean(
      right.composerLast &&
      (left.normalizedTitle.includes(right.composerLast) || left.composerKey.includes(right.composerLast))
    );
  }

  return (
    left.composerKey === right.composerKey ||
    (left.composerLast && right.composerKey.includes(left.composerLast)) ||
    (right.composerLast && left.composerKey.includes(right.composerLast)) ||
    (left.composerLast && right.normalizedTitle.includes(left.composerLast)) ||
    (right.composerLast && left.normalizedTitle.includes(right.composerLast))
  );
}

function getSetIntersection(left, right) {
  return [...left].filter(item => right.has(item));
}

function titleOverlap(left, right) {
  if (!left.titleTokens.length || !right.titleTokens.length) {
    return { shared: 0, smallerShare: 0 };
  }

  const shared = getSetIntersection(left.titleTokenSet, right.titleTokenSet).length;
  const smallerShare = shared / Math.min(left.titleTokenSet.size, right.titleTokenSet.size);
  return { shared, smallerShare };
}

function isSameClassicalWork(left, right) {
  const composerMatch = composersCompatible(left, right);
  const sharedCatalogKeys = getSetIntersection(left.catalogKeys, right.catalogKeys);
  const { shared, smallerShare } = titleOverlap(left, right);

  if (sharedCatalogKeys.length && composerMatch) {
    return true;
  }

  if (sharedCatalogKeys.length && shared >= 1 && smallerShare >= 0.4) {
    return true;
  }

  if (composerMatch && shared >= 2 && smallerShare >= 0.7) {
    return true;
  }

  if (shared >= 3 && smallerShare >= 0.85) {
    return true;
  }

  const leftTitle = left.titleTokens.join(' ');
  const rightTitle = right.titleTokens.join(' ');
  return Boolean(
    composerMatch &&
    leftTitle.length >= 12 &&
    rightTitle.length >= 12 &&
    (leftTitle.includes(rightTitle) || rightTitle.includes(leftTitle))
  );
}

function buildExistingWorkIndex(tracks) {
  return tracks.map(track => buildWorkIdentity(track.name, track.composer));
}

function isExistingWorkRecommendation(rec, existingWorkIndex) {
  const identity = buildWorkIdentity(rec.piece, rec.composer);
  return existingWorkIndex.some(existing => isSameClassicalWork(identity, existing));
}

function filterExistingWorkRecommendations(recs, existingWorkIndex) {
  const filtered = [];
  const removed = [];

  for (const rec of recs) {
    if (isExistingWorkRecommendation(rec, existingWorkIndex)) {
      removed.push(`${rec.composer} - ${rec.piece}`);
    } else {
      filtered.push(rec);
    }
  }

  if (removed.length) {
    console.info(`Duplicate work filter removed ${removed.length}: ${removed.join(' | ')}`);
  }

  return filtered;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return 'unknown duration';
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

// Spotify OAuth: Get login URL
app.get('/api/auth/login', (req, res) => {
  const missing = missingEnv(['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET']);
  if (missing.length) {
    return res.status(500).json({ error: `Missing backend env vars: ${missing.join(', ')}` });
  }

  cleanupOAuthStates();
  const state = generateState();
  pendingOAuthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);

  const params = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: 'playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private',
    state,
  });

  const loginUrl = `${SPOTIFY_AUTHORIZE_URL}?${params}`;
  res.json({ loginUrl });
});

// Spotify OAuth: Callback handler (redirect from Spotify)
app.get('/api/auth/callback', async (req, res) => {
  const { code, error, state } = req.query;

  if (error) {
    return res.redirect(authRedirect(String(error)));
  }

  if (!code) {
    return res.redirect(authRedirect('no_code'));
  }

  if (!state || !consumeOAuthState(String(state))) {
    return res.redirect(authRedirect('invalid_state'));
  }

  try {
    const { access_token, refresh_token, expires_in } = await exchangeSpotifyCode(code);
    const sessionId = generateState();

    userSessions.set(sessionId, {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + expires_in * 1000,
    });

    res.redirect(`${FRONTEND_URL}?sessionId=${sessionId}`);
  } catch (error) {
    console.error('OAuth error:', error.response?.data || error.message);
    res.redirect(authRedirect('auth_failed'));
  }
});

// Spotify OAuth: Callback handler (POST version for testing)
app.post('/api/auth/callback', async (req, res) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: 'No authorization code' });
  }

  try {
    const { access_token, refresh_token, expires_in } = await exchangeSpotifyCode(code);
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

async function getAllUserPlaylists(accessToken) {
  const allPlaylists = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const response = await axios.get(`${SPOTIFY_API_URL}/me/playlists`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { limit, offset },
    });

    if (!response.data || !Array.isArray(response.data.items)) {
      throw new Error('Invalid Spotify playlists response');
    }

    allPlaylists.push(...response.data.items.filter(Boolean));

    if (!response.data.next) {
      break;
    }
    offset += limit;
  }

  return allPlaylists;
}

// Get user's playlists
app.get('/api/playlists', async (req, res) => {
  try {
    const accessToken = await getValidAccessToken(req.query.sessionId);
    const playlistItems = await getAllUserPlaylists(accessToken);

    const playlists = playlistItems.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      imageUrl: p.images?.[0]?.url,
      trackCount: p.items?.total ?? p.tracks?.total ?? 0,
      ownerName: p.owner?.display_name || p.owner?.id || '',
      spotifyUrl: p.external_urls?.spotify || null,
    }));

    res.json({ playlists });
  } catch (error) {
    console.error('Playlists error:', error.response?.data || error.message);
    res.status(error.status || 500).json({ error: error.message || 'Failed to fetch playlists' });
  }
});

// Get full playlist tracks (paginated)
async function getAllPlaylistTracks(accessToken, playlistId) {
  const allTracks = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const response = await axios.get(
      `${SPOTIFY_API_URL}/playlists/${playlistId}/items`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { offset, limit, additional_types: 'track' },
      }
    );

    const tracks = response.data.items
      .map(entry => entry.item ?? entry.track)
      .filter(track => track != null && track.type === 'track' && track.id)
      .map(track => ({
        id: track.id,
        uri: track.uri,
        name: track.name,
        artists: (track.artists || []).map(a => a.name),
        composer: track.artists?.[0]?.name || 'Unknown composer',
        performers: (track.artists || []).slice(1).map(a => a.name),
        album: track.album?.name || '',
        albumArt: track.album?.images?.[1]?.url || track.album?.images?.[0]?.url || null,
        spotifyUrl: track.external_urls?.spotify || null,
        duration: track.duration_ms,
        year: track.album?.release_date?.split('-')[0],
        popularity: track.popularity,
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

function formatTrackForPrompt(track, index) {
  const performerText = track.performers.length ? track.performers.join(', ') : 'not listed';
  const yearText = track.year || 'unknown year';
  const albumText = track.album || 'unknown album';
  return [
    `${index + 1}. ${track.name}`,
    `first_artist_as_composer=${track.composer}`,
    `secondary_artists_as_performers=${performerText}`,
    `album=${albumText}`,
    `year=${yearText}`,
    `duration=${formatDuration(track.duration)}`,
  ].join(' | ');
}

function fallbackAnalysis(playlistName, tracks, rawText = '') {
  const cleaned = stripCodeFence(rawText);
  const safeText = cleaned && !cleaned.trim().startsWith('{')
    ? cleaned
    : `### Taste Profile

- Claude returned a partial response for **${playlistName}**.
- The playlist still loaded successfully with **${tracks.length} tracks**.
- Try analyzing again to refresh the written profile.`;

  return {
    markdown: safeText,
    summary: `Analysis generated for ${playlistName}.`,
    dominantSignals: [],
    periods: [],
    instrumentation: [],
    mood: '',
    listeningArc: '',
    recommendationStrategy: 'Use the weighted classical recommendation rubric against the selected playlist.',
    trackCount: tracks.length,
  };
}

// Analyze playlist with Claude
app.post('/api/analyze', async (req, res) => {
  const { sessionId, playlistId, playlistName } = req.body;

  try {
    const missing = missingEnv(['CLAUDE_API_KEY']);
    if (missing.length) {
      return res.status(500).json({ error: `Missing backend env vars: ${missing.join(', ')}` });
    }

    const accessToken = await getValidAccessToken(sessionId);
    const tracks = await getAllPlaylistTracks(accessToken, playlistId);
    console.info(`Analyze request: playlist=${playlistId} tracks=${tracks.length}`);

    const trackList = tracks
      .slice(0, 200)
      .map(formatTrackForPrompt)
      .join('\n');

    const prompt = `You are an expert classical music analyst. Analyze this playlist for recommendation planning.

Use the user's weighting rubric as the analysis lens, but do not recommend tracks yet:
${CLASSICAL_REC_WEIGHTS}

Playlist Name: "${playlistName}"
Track Count: ${tracks.length}

Tracks, where first_artist_as_composer follows the user's classical metadata rule:
${trackList}

Return clean Markdown only. Do not return JSON.
Use exactly these sections:
### Taste Profile
- 2-3 bullets on the core repertoire pattern.
### Dominant Signals
- 4-6 bullets. Start each bullet with a bold weighting category.
### Recommendation Direction
- 2 bullets describing what the recommendation engine should favor.

Keep the whole response under 325 words and complete every bullet.`;

    const message = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1200,
      thinking: { type: 'disabled' },
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const rawText = extractText(message);
    const analysis = fallbackAnalysis(playlistName, tracks, rawText);
    analysis.trackCount = tracks.length;

    res.json({ analysis, trackCount: tracks.length });
  } catch (error) {
    const detail = error.response?.data?.error || error.error?.message || error.message || 'Unknown error';
    console.error('Analysis error:', detail);
    res.status(error.status || 500).json({ error: `Failed to analyze playlist: ${JSON.stringify(detail)}` });
  }
});

// Recommendation weighting rubric (verbatim — do not edit)
const CLASSICAL_REC_WEIGHTS = `<Classical-rec weights: Composer/school 28%: first listed artist = composer; normalize/fact-check name; infer era/sub-era, national school, harmonic language, and adjacent composers; trust repeated patterns over one-offs. Work type/instrumentation 24%: match actual forces/form—solo piano, chamber, quartet, concerto, symphony, opera/lieder, choral/sacred, ballet, early/HIP, etc.; ensemble size/timbre matters more than generic “classical.” Movement/vibe 20%: tempo/marking, affect, texture, intensity, lyricism vs virtuosity/drama, sacred/dance/pastoral/tragic, tonal/modernist, long/miniature; match liked movements even across different composers. Performer/recording 13%: secondary artists = performers/conductors/ensembles/singers; weight heavily only if repeated; otherwise pick esteemed, style-appropriate recordings, noting HIP vs modern when relevant. Serendipity/anti-popularity 8%: include 1–2 tasteful adventurous picks when possible—lesser-known works by liked composers, adjacent niche composers/schools, unusual forms, neglected movements, or elite recordings outside the obvious canon; avoid generic popularity defaults unless strongly supported by the playlist. Quality/discovery/hygiene 7%: recommend elite adjacent works, not generic greatest hits; avoid exact works/movements already in playlist; normalize full work/movement/catalog duplicates; alternate recordings only when the performer is the point; make most picks close-fit elite choices, but include a small “adventurous” slice that is clearly justified by the user’s taste rather than by general classical popularity.>`;

const CLASSICAL_WEIGHT_SUMMARY = [
  { label: 'Composer/school', weight: 28 },
  { label: 'Work type/instrumentation', weight: 24 },
  { label: 'Movement/vibe', weight: 20 },
  { label: 'Performer/recording', weight: 13 },
  { label: 'Serendipity/anti-popularity', weight: 8 },
  { label: 'Quality/discovery/hygiene', weight: 7 },
];

function normalizeRecommendation(rec) {
  const clean = value => String(value || '')
    .replace(/\*\*/g, '')
    .replace(/^["']|["']$/g, '')
    .trim();

  return {
    piece: clean(rec.piece || rec.work),
    composer: clean(rec.composer),
    performer: clean(rec.performer || rec.recording),
    why: clean(rec.why || rec.rationale),
    matchedWeights: Array.isArray(rec.matchedWeights)
      ? rec.matchedWeights.slice(0, 3).map(clean)
      : [],
    adventurous: Boolean(rec.adventurous),
    searchQuery: clean(rec.searchQuery),
  };
}

function parseRecommendationLine(line) {
  const match = line.match(/^\s*(?:\d+[\.)]|[-*])\s*(.+)$/);
  if (!match) return null;

  const body = match[1].trim();
  const pipeParts = body.split('|').map(part => part.trim()).filter(Boolean);
  if (pipeParts.length >= 5) {
    return normalizeRecommendation({
      piece: pipeParts[0],
      composer: pipeParts[1],
      performer: pipeParts[2],
      matchedWeights: pipeParts[3].split(',').map(part => part.trim()).filter(Boolean),
      why: pipeParts[4],
      adventurous: /^(yes|true|adventurous)$/i.test(pipeParts[5] || ''),
      searchQuery: [pipeParts[0], pipeParts[1], pipeParts[2]].filter(Boolean).join(' '),
    });
  }

  const dashParts = body.split(/\s+-\s+/).map(part => part.trim()).filter(Boolean);
  if (dashParts.length >= 3) {
    return normalizeRecommendation({
      piece: dashParts[0],
      composer: dashParts[1],
      performer: dashParts[2],
      why: dashParts.slice(3).join(' - '),
      searchQuery: dashParts.slice(0, 3).join(' '),
    });
  }

  return null;
}

// Parse Claude's recommendation JSON, with a numbered-list fallback for resilience.
function parseRecommendations(text) {
  const json = parseClaudeJson(text, null);
  let recs = [];

  if (Array.isArray(json)) {
    recs = json.map(normalizeRecommendation);
  }
  if (Array.isArray(json?.recommendations)) {
    recs = json.recommendations.map(normalizeRecommendation);
  }

  if (!recs.length) {
    recs = text
      .split('\n')
      .map(parseRecommendationLine)
      .filter(Boolean);
  }

  return recs.filter(rec => rec.piece && rec.composer);
}

function countBy(items, selector) {
  const counts = new Map();
  for (const item of items) {
    const key = selector(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function inferPlaylistProfile(tracks) {
  const composerCounts = countBy(tracks, track => track.composer);
  const topComposers = [...composerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name]) => name);
  const text = tracks
    .map(track => `${track.name} ${track.composer} ${track.artists.join(' ')} ${track.album}`)
    .join(' ')
    .toLowerCase();

  return {
    topComposers,
    hasLieder: /\b(lied|lieder|song|songs|mélodie|melodie|gesang|nacht|träume|traume|fischer-dieskau|bonney|gens)\b/.test(text),
    hasPiano: /\b(piano|nocturne|mazurka|ballade|prelude|impromptu|intermezzo|lyric pieces?)\b/.test(text),
    hasChamber: /\b(trio|quartet|quintet|sonata|cello|violin|viola|chamber)\b/.test(text),
    hasSlowVibe: /\b(adagio|andante|largo|larghetto|nocturne|night|nacht|dream|träume|traume|elegy|elegie|mélodie|melodie)\b/.test(text),
    hasFrench: /\b(fauré|faure|duparc|debussy|ravel|poulenc|mélodie|melodie)\b/.test(text),
    hasGermanRomantic: /\b(schubert|schumann|brahms|wolf|strauss|mendelssohn)\b/.test(text),
  };
}

const FALLBACK_RECOMMENDATION_POOL = [
  {
    piece: 'Nacht und Träume, D. 827',
    composer: 'Franz Schubert',
    performer: 'Dietrich Fischer-Dieskau, Gerald Moore',
    tags: ['Schubert', 'lieder', 'slow', 'German Romantic'],
    why: 'Directly extends the nocturnal Schubert lieder thread with an intimate voice-and-piano match.',
  },
  {
    piece: 'Piano Trio No. 2 in E-flat major, D. 929: II. Andante con moto',
    composer: 'Franz Schubert',
    performer: 'Beaux Arts Trio',
    tags: ['Schubert', 'chamber', 'slow', 'German Romantic'],
    why: 'Keeps the Schubert center while matching the playlist’s slow Romantic chamber-music weight.',
  },
  {
    piece: 'Mörike-Lieder: Verborgenheit',
    composer: 'Hugo Wolf',
    performer: 'Elisabeth Schwarzkopf, Gerald Moore',
    tags: ['Wolf', 'lieder', 'slow', 'German Romantic'],
    why: 'A close-fit Wolf song for inward, restrained lieder rather than large-scale drama.',
  },
  {
    piece: 'L’invitation au voyage',
    composer: 'Henri Duparc',
    performer: 'Véronique Gens, Roger Vignoles',
    tags: ['Duparc', 'lieder', 'French', 'slow'],
    why: 'Follows the French mélodie branch with the same dusk-toned lyric intensity.',
  },
  {
    piece: 'Après un rêve, Op. 7 No. 1',
    composer: 'Gabriel Fauré',
    performer: 'Barbara Bonney, Geoffrey Parsons',
    tags: ['Fauré', 'lieder', 'French', 'slow'],
    why: 'A concise French song recommendation for the playlist’s dream/night vocal profile.',
  },
  {
    piece: 'Intermezzo in A major, Op. 118 No. 2',
    composer: 'Johannes Brahms',
    performer: 'Radu Lupu',
    tags: ['Brahms', 'piano', 'slow', 'German Romantic'],
    why: 'Matches the late-Romantic inward piano-miniature preference without defaulting to another Chopin nocturne.',
  },
  {
    piece: 'Fantasiestücke, Op. 12: Des Abends',
    composer: 'Robert Schumann',
    performer: 'Martha Argerich',
    tags: ['Schumann', 'piano', 'slow', 'German Romantic'],
    why: 'A poetic piano miniature that fits the nocturnal lyricism and Romantic harmonic language.',
  },
  {
    piece: 'Lyric Pieces, Op. 54 No. 4: Notturno',
    composer: 'Edvard Grieg',
    performer: 'Emil Gilels',
    tags: ['Grieg', 'piano', 'slow', 'Nordic', 'adventurous'],
    why: 'A tasteful adjacent piano nocturne that adds discovery while staying close to the playlist’s mood.',
  },
  {
    piece: 'Piano Quintet in E-flat major, Op. 44: II. In modo d’una marcia',
    composer: 'Robert Schumann',
    performer: 'Martha Argerich, Kremer, Maisky, Bashmet',
    tags: ['Schumann', 'chamber', 'German Romantic'],
    why: 'Keeps the Romantic chamber emphasis but adds a slightly more dramatic ensemble color.',
  },
  {
    piece: 'Three Romances for Violin and Piano, Op. 22: No. 1',
    composer: 'Clara Schumann',
    performer: 'Isabelle Faust, Alexander Melnikov',
    tags: ['Schumann', 'chamber', 'German Romantic', 'adventurous'],
    why: 'A high-quality adjacent discovery for Schumann-centered Romantic intimacy.',
  },
  {
    piece: 'Beau soir',
    composer: 'Claude Debussy',
    performer: 'Renée Fleming, Jean-Yves Thibaudet',
    tags: ['Debussy', 'lieder', 'French', 'slow', 'adventurous'],
    why: 'Broadens the French song lane with a luminous evening mood rather than generic popularity.',
  },
  {
    piece: 'On an Overgrown Path: The Madonna of Frydek',
    composer: 'Leoš Janáček',
    performer: 'András Schiff',
    tags: ['piano', 'slow', 'adventurous'],
    why: 'A small adventurous piano pick with the same private, memory-haunted scale.',
  },
];

function scoreFallbackRecommendation(candidate, profile) {
  const normalizedComposer = normalizeText(candidate.composer);
  const topComposerText = profile.topComposers.map(normalizeText).join(' ');
  let score = 7; // quality/discovery/hygiene baseline

  if (profile.topComposers.some(composer => normalizedComposer.includes(normalizeText(composer)))) {
    score += 28;
  } else if (
    (profile.hasGermanRomantic && candidate.tags.includes('German Romantic')) ||
    (profile.hasFrench && candidate.tags.includes('French'))
  ) {
    score += 22;
  } else if (topComposerText && candidate.tags.some(tag => topComposerText.includes(normalizeText(tag)))) {
    score += 18;
  }

  if (
    (profile.hasLieder && candidate.tags.includes('lieder')) ||
    (profile.hasPiano && candidate.tags.includes('piano')) ||
    (profile.hasChamber && candidate.tags.includes('chamber'))
  ) {
    score += 24;
  }

  if (profile.hasSlowVibe && candidate.tags.includes('slow')) {
    score += 20;
  }

  if (candidate.tags.some(tag => ['Schubert', 'Wolf', 'Brahms', 'Schumann', 'Fauré', 'Duparc'].includes(tag))) {
    score += 8;
  }

  if (candidate.tags.includes('adventurous')) {
    score += 4;
  }

  return score;
}

function buildFallbackRecommendations(tracks, existingWorkIndex) {
  const profile = inferPlaylistProfile(tracks);
  let adventurousUsed = 0;

  return FALLBACK_RECOMMENDATION_POOL
    .filter(candidate => !isExistingWorkRecommendation(candidate, existingWorkIndex))
    .map(candidate => ({
      ...candidate,
      score: scoreFallbackRecommendation(candidate, profile),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(candidate => {
      const adventurous = candidate.tags.includes('adventurous') && adventurousUsed < 2;
      if (adventurous) adventurousUsed += 1;

      const matchedWeights = [
        'Composer/school',
        candidate.tags.some(tag => ['lieder', 'piano', 'chamber'].includes(tag)) && 'Work type/instrumentation',
        candidate.tags.includes('slow') && 'Movement/vibe',
        candidate.tags.includes('adventurous') && 'Serendipity/anti-popularity',
      ].filter(Boolean).slice(0, 3);

      return normalizeRecommendation({
        piece: candidate.piece,
        composer: candidate.composer,
        performer: candidate.performer,
        why: candidate.why,
        matchedWeights,
        adventurous,
        searchQuery: `${candidate.piece} ${candidate.composer} ${candidate.performer}`,
      });
    });
}

async function getClaudeRecommendationText(primaryPrompt, retryPrompt) {
  const firstMessage = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1800,
    thinking: { type: 'disabled' },
    messages: [
      {
        role: 'user',
        content: primaryPrompt,
      },
    ],
  });
  const firstText = extractText(firstMessage);

  if (firstText) {
    return { text: firstText, attempts: [describeClaudeMessage(firstMessage)] };
  }

  const secondMessage = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 900,
    thinking: { type: 'disabled' },
    messages: [
      {
        role: 'user',
        content: retryPrompt,
      },
    ],
  });

  return {
    text: extractText(secondMessage),
    attempts: [describeClaudeMessage(firstMessage), describeClaudeMessage(secondMessage)],
  };
}

// Look up a recommended piece on Spotify (album art, link, URI)
async function searchSpotifyTrack(accessToken, rec, existingTrackIds, existingWorkIndex) {
  try {
    const q = rec.searchQuery || [rec.piece, rec.composer, rec.performer].filter(Boolean).join(' ');
    const resp = await axios.get(`${SPOTIFY_API_URL}/search`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { q, type: 'track', limit: 5 },
    });
    const track = (resp.data?.tracks?.items || []).find(item => (
      !existingTrackIds.has(item.id) &&
      !isExistingWorkRecommendation({
        piece: item.name,
        composer: (item.artists || []).map(artist => artist.name).join(' '),
      }, existingWorkIndex)
    ));
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

  try {
    const missing = missingEnv(['CLAUDE_API_KEY']);
    if (missing.length) {
      return res.status(500).json({ error: `Missing backend env vars: ${missing.join(', ')}` });
    }

    const accessToken = await getValidAccessToken(sessionId);
    const tracks = await getAllPlaylistTracks(accessToken, playlistId);
    const existingTrackIds = new Set(tracks.map(track => track.id));
    const existingWorkIndex = buildExistingWorkIndex(tracks);
    console.info(`Recommendation request: playlist=${playlistId} tracks=${tracks.length}`);

    const trackList = tracks
      .slice(0, 150)
      .map(formatTrackForPrompt)
      .join('\n');

    const prompt = `You are a classical music expert recommendation engine. Recommend 8 classical music tracks based on the playlist below.

Score and select candidates using EXACTLY this weighting rubric:

${CLASSICAL_REC_WEIGHTS}

Playlist tracks, where first_artist_as_composer follows the user's metadata rule:
${trackList}

Avoid works or movements already represented in the playlist, even when Spotify lists a different performer, composer-in-title variant, opus/catalog ordering, translation, punctuation, or movement naming convention. Compare the underlying composition, not the Spotify track id. Favor close-fit elite adjacent choices, with 1-2 clearly justified adventurous picks.

Return ONLY 8 numbered lines. Do not return JSON, headers, or extra commentary.
Use exactly this pipe-delimited format:
1. Piece or movement | Composer | Performer/conductor/ensemble | Weight label, Weight label | One short reason tied to this playlist | yes/no

The weight labels must come from the rubric. Use yes only for the 1-2 adventurous picks.`;

    const retryTrackList = tracks
      .slice(0, 40)
      .map(track => `${track.name} | ${track.composer} | ${track.performers.join(', ') || 'not listed'}`)
      .join('\n');

    const retryPrompt = `Recommend 8 classical pieces for this playlist. Use the user's classical weights: composer/school, work type/instrumentation, movement/vibe, performer/recording, serendipity, quality/hygiene.

Playlist sample:
${retryTrackList}

Return 8 lines only in this exact format:
1. Piece | Composer | Performer | Weight label, Weight label | Short reason | yes/no`;

    const { text: rawText, attempts } = await getClaudeRecommendationText(prompt, retryPrompt);
    let parsed = filterExistingWorkRecommendations(parseRecommendations(rawText), existingWorkIndex).slice(0, 8);
    console.info(`Recommendation parse: parsed=${parsed.length} claudeAttempts=${JSON.stringify(attempts)}`);

    if (!parsed.length) {
      console.error('Recommendation parse produced no Claude results. Falling back locally. Claude text:', rawText.slice(0, 500));
      parsed = buildFallbackRecommendations(tracks, existingWorkIndex);
    } else if (parsed.length < 8) {
      const currentKeys = new Set(parsed.map(rec => normalizeText(`${rec.composer} ${rec.piece}`)));
      const fillers = buildFallbackRecommendations(tracks, existingWorkIndex)
        .filter(rec => !currentKeys.has(normalizeText(`${rec.composer} ${rec.piece}`)))
        .slice(0, 8 - parsed.length);
      parsed = [...parsed, ...fillers];
    }

    if (!parsed.length) {
      return res.status(502).json({
        error: 'No recommendations could be generated for this playlist.',
      });
    }

    // Enrich each recommendation with real Spotify track data (album art, link, URI)
    const recommendations = await Promise.all(
      parsed.map(async rec => {
        const match = await searchSpotifyTrack(accessToken, rec, existingTrackIds, existingWorkIndex);
        return { ...rec, ...(match || {}) };
      })
    );
    console.info(`Recommendation response: returned=${recommendations.length}`);

    res.json({ recommendations, weights: CLASSICAL_WEIGHT_SUMMARY });
  } catch (error) {
    const detail = error.response?.data?.error || error.error?.message || error.message || 'Unknown error';
    console.error('Recommendation error:', detail);
    res.status(error.status || 500).json({ error: `Failed to generate recommendations: ${JSON.stringify(detail)}` });
  }
});

// Add a recommended track to the user's playlist
app.post('/api/playlist/add', async (req, res) => {
  const { sessionId, playlistId, uri } = req.body;

  if (!playlistId || !uri) {
    return res.status(400).json({ error: 'Missing playlistId or uri' });
  }

  try {
    const accessToken = await getValidAccessToken(sessionId);
    await axios.post(
      `${SPOTIFY_API_URL}/playlists/${playlistId}/items`,
      { uris: [uri] },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
    res.json({ success: true });
  } catch (error) {
    const detail = error.response?.data?.error || error.message || 'Unknown error';
    console.error('Add track error:', detail);
    res.status(error.status || 500).json({ error: `Failed to add track: ${JSON.stringify(detail)}` });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
