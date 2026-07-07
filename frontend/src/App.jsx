import { useState, useEffect } from 'react'
import axios from 'axios'

const API_URL = '/api'

export default function App() {
  const [state, setState] = useState('login') // login, select, analyzing, view
  const [sessionId, setSessionId] = useState(null)
  const [playlists, setPlaylists] = useState([])
  const [selectedPlaylist, setSelectedPlaylist] = useState(null)
  const [analysis, setAnalysis] = useState(null)
  const [recommendations, setRecommendations] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Start Spotify login
  const handleLogin = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await axios.get(`${API_URL}/auth/login`)
      const { loginUrl } = response.data
      window.location.href = loginUrl
    } catch (err) {
      setError('Failed to start login. Check your backend.')
      console.error(err)
      setLoading(false)
    }
  }

  // Load playlists after login
  const handleLoadPlaylists = async (sid) => {
    setLoading(true)
    setError(null)
    try {
      const response = await axios.get(`${API_URL}/playlists`, {
        params: { sessionId: sid },
      })
      setPlaylists(response.data.playlists)
    } catch (err) {
      setError('Failed to load playlists. Check your session.')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  // Analyze selected playlist
  const handleAnalyze = async () => {
    if (!selectedPlaylist) return

    setLoading(true)
    setError(null)
    setState('analyzing')
    setAnalysis(null)
    setRecommendations(null)

    try {
      const response = await axios.post(`${API_URL}/analyze`, {
        sessionId,
        playlistId: selectedPlaylist.id,
        playlistName: selectedPlaylist.name,
      })
      setAnalysis(response.data.analysis)
      setState('view')
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to analyze playlist.')
      console.error(err)
      setState('select')
    } finally {
      setLoading(false)
    }
  }

  // Get recommendations
  const handleGetRecommendations = async () => {
    setLoading(true)
    setError(null)

    try {
      const response = await axios.post(`${API_URL}/recommend`, {
        sessionId,
        playlistId: selectedPlaylist.id,
      })
      setRecommendations(response.data.recommendations)
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate recommendations.')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  // Handle OAuth callback from Spotify redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const sid = params.get('sessionId')
    const errMsg = params.get('error')

    if (sid && !sessionId) {
      setSessionId(sid)
      setState('select')
      handleLoadPlaylists(sid)
      window.history.replaceState({}, document.title, window.location.pathname)
    }

    if (errMsg) {
      setError(`Authentication error: ${errMsg}`)
      window.history.replaceState({}, document.title, window.location.pathname)
    }
  }, [])

  return (
    <div className="container">
      {state === 'login' && (
        <div className="card">
          <h1>🎵 Classical Playlist Recommender</h1>
          <p style={{ marginBottom: '1.5rem', fontSize: '1.05rem', color: '#666' }}>
            Get AI-powered recommendations tailored to your classical music taste.
          </p>
          <button onClick={handleLogin} disabled={loading}>
            {loading ? 'Connecting...' : 'Sign in with Spotify'}
          </button>
          {error && <div className="error">{error}</div>}
        </div>
      )}

      {state === 'select' && (
        <div className="card">
          <h1>🎵 Select a Playlist</h1>
          <p style={{ marginBottom: '1.5rem', color: '#666' }}>
            Choose a classical music playlist to analyze and get recommendations.
          </p>

          {playlists.length > 0 ? (
            <div>
              <select
                onChange={(e) => {
                  const pid = e.target.value
                  const playlist = playlists.find(p => p.id === pid)
                  setSelectedPlaylist(playlist)
                }}
                value={selectedPlaylist?.id || ''}
              >
                <option value="">-- Select a playlist --</option>
                {playlists.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.trackCount} tracks)
                  </option>
                ))}
              </select>

              {selectedPlaylist && (
                <div className="analysis-text" style={{ marginTop: '1rem' }}>
                  <strong>{selectedPlaylist.name}</strong>
                  <p style={{ marginTop: '0.5rem', fontSize: '0.9rem' }}>
                    {selectedPlaylist.trackCount} tracks
                    {selectedPlaylist.description && ` • ${selectedPlaylist.description}`}
                  </p>
                </div>
              )}

              <button
                onClick={handleAnalyze}
                disabled={!selectedPlaylist || loading}
                style={{ marginTop: '1.5rem' }}
              >
                {loading ? 'Analyzing...' : 'Analyze Playlist'}
              </button>
            </div>
          ) : (
            <div className="error">
              No playlists found. Try creating one on Spotify first.
            </div>
          )}

          {error && <div className="error">{error}</div>}
        </div>
      )}

      {state === 'analyzing' && (
        <div className="card">
          <h1>🔍 Analyzing Your Playlist</h1>
          <p style={{ marginBottom: '1rem', color: '#666' }}>
            Claude is examining your classical music taste...
          </p>
          <div style={{ textAlign: 'center' }}>
            <div className="loading" style={{ fontSize: '3rem' }}>⏳</div>
            <p style={{ marginTop: '1rem', color: '#999' }}>
              This may take a moment
            </p>
          </div>
        </div>
      )}

      {state === 'view' && (
        <div className="card">
          <h1>📊 Playlist Analysis</h1>

          <div className="analysis-text">
            {analysis}
          </div>

          <div className="button-group">
            <button className="secondary" onClick={() => {
              setState('select')
              setAnalysis(null)
              setRecommendations(null)
            }}>
              ← Select Another Playlist
            </button>
            <button onClick={handleGetRecommendations} disabled={loading}>
              {loading ? 'Generating...' : '✨ Get Recommendations'}
            </button>
          </div>

          {recommendations && (
            <div style={{ marginTop: '2rem' }}>
              <h2>🎼 Recommended Tracks</h2>
              <div className="analysis-text">
                <ol style={{ paddingLeft: '1.5rem', whiteSpace: 'pre-wrap' }}>
                  {recommendations}
                </ol>
              </div>
              <p style={{ marginTop: '1rem', fontSize: '0.9rem', color: '#999' }}>
                💡 Tip: Search these titles on Spotify to add them to your playlist!
              </p>
            </div>
          )}

          {error && <div className="error">{error}</div>}
        </div>
      )}
    </div>
  )
}
