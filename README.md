# Classical Playlist Recommender

AI-powered classical music recommendations tailored to your Spotify playlists, powered by Claude Sonnet.

## Features

- 🎵 Sign in with Spotify OAuth
- 🔍 Analyze your classical music playlists
- 🎼 Get personalized recommendations from Claude
- 📚 Understand composition style, period, and mood
- 🎯 Classical-music-specific analysis (handles composers, movements, versions)

## Tech Stack

**Frontend:** React + Vite + Axios  
**Backend:** Node.js + Express  
**AI:** Claude Sonnet API  
**Auth:** Spotify OAuth 2.0

## Setup Instructions

### Prerequisites

- Node.js 16+
- Spotify Developer Account (free)
- Claude API Key

### 1. Get Spotify Credentials

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Log in or create an account
3. Create a new app
4. Accept the terms and create
5. Copy your **Client ID** and **Client Secret**
6. Go to "Edit Settings" and set Redirect URI to:
   ```
   http://127.0.0.1:5000/api/auth/callback
   ```
   (Note: Spotify requires `127.0.0.1` instead of `localhost` for security)

### 2. Get Claude API Key

1. Go to [Anthropic Console](https://console.anthropic.com)
2. Navigate to API Keys
3. Create a new API key
4. Copy it (you'll only see it once)

### 3. Setup Backend

```bash
cd backend
cp .env.example .env
```

Edit `backend/.env` with your credentials:
```
PORT=5000
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
SPOTIFY_REDIRECT_URI=http://localhost:5000/api/auth/callback
CLAUDE_API_KEY=your_claude_api_key
FRONTEND_URL=http://localhost:3000
```

Install and start backend:
```bash
npm install
npm start
```

Or add to `package.json`:
```json
"scripts": {
  "start": "node server.js",
  "dev": "nodemon server.js"
}
```

### 4. Setup Frontend

```bash
cd frontend
npm install
npm run dev
```

Visit `http://localhost:3000` in your browser.

## Usage

1. Click **"Sign in with Spotify"**
2. Authorize the app
3. **Select a classical playlist** from the dropdown
4. Click **"Analyze Playlist"**
5. Claude analyzes the playlist's vibe and mood
6. Choose **"Get Recommendations"** to see 15 suggested tracks
7. Search the recommendations on Spotify and add them!

## Project Structure

```
.
├── backend/
│   ├── server.js          # Express server + API endpoints
│   ├── package.json
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── App.jsx        # Main React component
│   │   ├── main.jsx       # Entry point
│   │   └── index.css      # Styling
│   ├── index.html
│   ├── vite.config.js
│   └── package.json
└── README.md
```

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auth/login` | GET | Get Spotify login URL |
| `/api/auth/callback` | GET | OAuth callback from Spotify |
| `/api/playlists` | GET | Get user's playlists |
| `/api/analyze` | POST | Analyze playlist vibe with Claude |
| `/api/recommend` | POST | Generate recommendations |

## Costs

- **Spotify API:** Free tier covers typical usage
- **Claude API:** ~$0.04-0.06 per analysis (Sonnet pricing)
- **Hosting:** Free tier options (Vercel, Railway, Render)

## Roadmap

- [ ] Cache analyses to reduce API costs
- [ ] Save favorite analyses
- [ ] Share recommendations
- [ ] "Go Deeper" feature (explore taste patterns)
- [ ] Mobile app

## Troubleshooting

**"Failed to start login"**
- Check that backend is running on port 5000
- Verify SPOTIFY_CLIENT_ID is correct

**"No playlists found"**
- Create a playlist on Spotify first
- Make sure Spotify account has at least one playlist

**"Authentication failed"**
- Verify SPOTIFY_CLIENT_SECRET is correct
- Check that redirect URI in Spotify dashboard matches `.env`

**"Failed to analyze playlist"**
- Verify CLAUDE_API_KEY is correct
- Check API usage limits in Anthropic Console

## License

MIT
