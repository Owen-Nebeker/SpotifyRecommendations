import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import ReactMarkdown from 'react-markdown'

const API_URL = '/api'
const SESSION_STORAGE_KEY = 'spotify-classical-session'

function formatCount(count) {
  return `${Number(count || 0).toLocaleString()} tracks`
}

function getErrorMessage(err, fallback) {
  return err.response?.data?.error || fallback
}

function tryParseJson(value) {
  if (typeof value !== 'string') return null

  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function formatAnalysisMarkdown(value) {
  const analysis = typeof value === 'string' ? tryParseJson(value) || { markdown: value } : value
  if (!analysis) return ''

  if (typeof analysis.markdown === 'string' && analysis.markdown.trim()) {
    if (analysis.markdown.trim().startsWith('{')) {
      const parsedMarkdown = tryParseJson(analysis.markdown)
      return parsedMarkdown
        ? formatAnalysisMarkdown(parsedMarkdown)
        : '### Taste Profile\n\n- Claude returned a partial analysis response.\n- Run the analysis again to refresh this section in clean Markdown.'
    }
    return analysis.markdown
  }

  if (typeof analysis.summary === 'string' && analysis.summary.trim().startsWith('{')) {
    const parsedSummary = tryParseJson(analysis.summary)
    if (parsedSummary) {
      return formatAnalysisMarkdown(parsedSummary)
    }
    return '### Taste Profile\n\n- Claude returned a partial analysis response.\n- Run the analysis again to refresh this section in clean Markdown.'
  }

  const lines = ['### Taste Profile']
  if (analysis.summary) {
    lines.push('', analysis.summary)
  }

  if (analysis.dominantSignals?.length) {
    lines.push('', '### Dominant Signals')
    analysis.dominantSignals.forEach(signal => {
      lines.push(`- **${signal.label}:** ${signal.value}`)
    })
  }

  const shape = [
    ...(analysis.periods || []).map(period => `Period: ${period}`),
    ...(analysis.instrumentation || []).map(item => `Instrumentation: ${item}`),
    analysis.mood,
    analysis.listeningArc,
  ].filter(Boolean)

  if (shape.length) {
    lines.push('', '### Shape')
    shape.forEach(item => lines.push(`- ${item}`))
  }

  if (analysis.recommendationStrategy) {
    lines.push('', '### Recommendation Direction', `- ${analysis.recommendationStrategy}`)
  }

  return lines.join('\n')
}

function PlaylistArtwork({ src, name }) {
  if (!src) {
    return <div className="artwork artwork-empty" aria-hidden="true">CR</div>
  }

  return <img className="artwork" src={src} alt={`${name} cover`} />
}

function WeightList({ weights = [] }) {
  if (!weights.length) return null

  return (
    <div className="weight-list">
      {weights.map(weight => (
        <div className="weight-row" key={weight.label}>
          <div className="weight-topline">
            <span>{weight.label}</span>
            <strong>{weight.weight}%</strong>
          </div>
          <div className="weight-track" aria-hidden="true">
            <div style={{ width: `${weight.weight}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function SignalList({ signals = [] }) {
  if (!signals.length) return null

  return (
    <div className="signal-list">
      {signals.map((signal, index) => (
        <div className="signal" key={`${signal.label}-${index}`}>
          <div className="signal-label">{signal.label}</div>
          <div className="signal-value">{signal.value}</div>
          {signal.confidence && <span className={`confidence confidence-${signal.confidence}`}>{signal.confidence}</span>}
        </div>
      ))}
    </div>
  )
}

function RecommendationCard({ rec, index, status, onAdd }) {
  const addLabel = status === 'added'
    ? 'Added'
    : status === 'adding'
      ? 'Adding'
      : status === 'error'
        ? 'Retry'
        : 'Add'

  return (
    <article className="rec-card">
      {rec.albumArt ? (
        <img src={rec.albumArt} alt="" className="rec-art" />
      ) : (
        <div className="rec-art rec-art-empty" aria-hidden="true">{index + 1}</div>
      )}
      <div className="rec-main">
        <div className="rec-kicker">
          <span>Recommendation {index + 1}</span>
        </div>
        <h3>{rec.piece}</h3>
        <p className="rec-credit">
          {rec.composer}
          {rec.performer && <span> | {rec.performer}</span>}
        </p>
        {rec.why && <p className="rec-why">{rec.why}</p>}
        {!!rec.matchedWeights?.length && (
          <div className="chip-row">
            {rec.matchedWeights.map(weight => <span className="chip" key={weight}>{weight}</span>)}
          </div>
        )}
        {rec.trackName && (
          <p className="spotify-match">
            Spotify match: {rec.trackName} by {rec.trackArtists}
          </p>
        )}
      </div>
      <div className="rec-actions">
        {rec.uri ? (
          <button
            className="small-button"
            type="button"
            onClick={() => onAdd(index, rec.uri)}
            disabled={status === 'adding' || status === 'added'}
          >
            {addLabel}
          </button>
        ) : (
          <span className="no-match">No match</span>
        )}
        {rec.url && (
          <a className="text-link" href={rec.url} target="_blank" rel="noreferrer">
            Open in Spotify
          </a>
        )}
      </div>
    </article>
  )
}

export default function App() {
  const [view, setView] = useState('login')
  const [sessionId, setSessionId] = useState(null)
  const [playlists, setPlaylists] = useState([])
  const [selectedPlaylist, setSelectedPlaylist] = useState(null)
  const [analysis, setAnalysis] = useState(null)
  const [recommendations, setRecommendations] = useState([])
  const [weights, setWeights] = useState([])
  const [addStatus, setAddStatus] = useState({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const selectedTrackLabel = useMemo(() => {
    if (!selectedPlaylist) return ''
    return `${selectedPlaylist.name} | ${formatCount(selectedPlaylist.trackCount)}`
  }, [selectedPlaylist])

  const analysisMarkdown = useMemo(() => formatAnalysisMarkdown(analysis), [analysis])

  const handleLoadPlaylists = async (sid) => {
    setLoading(true)
    setError(null)

    try {
      const response = await axios.get(`${API_URL}/playlists`, {
        params: { sessionId: sid },
      })
      setPlaylists(response.data.playlists || [])
      setView('select')
    } catch (err) {
      sessionStorage.removeItem(SESSION_STORAGE_KEY)
      setSessionId(null)
      setView('login')
      setError(getErrorMessage(err, 'Failed to load playlists. Sign in again.'))
    } finally {
      setLoading(false)
    }
  }

  const handleLogin = async () => {
    setLoading(true)
    setError(null)

    try {
      const response = await axios.get(`${API_URL}/auth/login`)
      window.location.href = response.data.loginUrl
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to start Spotify login.'))
      setLoading(false)
    }
  }

  const handleLogout = () => {
    sessionStorage.removeItem(SESSION_STORAGE_KEY)
    setSessionId(null)
    setPlaylists([])
    setSelectedPlaylist(null)
    setAnalysis(null)
    setRecommendations([])
    setWeights([])
    setAddStatus({})
    setError(null)
    setView('login')
  }

  const handleAnalyze = async () => {
    if (!selectedPlaylist) return

    setLoading(true)
    setError(null)
    setAnalysis(null)
    setRecommendations([])
    setAddStatus({})
    setView('analyzing')

    try {
      const response = await axios.post(`${API_URL}/analyze`, {
        sessionId,
        playlistId: selectedPlaylist.id,
        playlistName: selectedPlaylist.name,
      })
      setAnalysis(response.data.analysis)
      setView('results')
    } catch (err) {
      setView('select')
      setError(getErrorMessage(err, 'Failed to analyze playlist.'))
    } finally {
      setLoading(false)
    }
  }

  const handleGetRecommendations = async () => {
    if (!selectedPlaylist) return

    setLoading(true)
    setError(null)
    setRecommendations([])
    setWeights([])

    try {
      const response = await axios.post(`${API_URL}/recommend`, {
        sessionId,
        playlistId: selectedPlaylist.id,
      })
      const nextRecommendations = response.data.recommendations || []
      setRecommendations(nextRecommendations)
      setWeights(response.data.weights || [])
      setAddStatus({})
      if (!nextRecommendations.length) {
        setError('No recommendations were returned. Try generating them again.')
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to generate recommendations.'))
    } finally {
      setLoading(false)
    }
  }

  const handleAddTrack = async (index, uri) => {
    setAddStatus(prev => ({ ...prev, [index]: 'adding' }))
    setError(null)

    try {
      await axios.post(`${API_URL}/playlist/add`, {
        sessionId,
        playlistId: selectedPlaylist.id,
        uri,
      })
      setAddStatus(prev => ({ ...prev, [index]: 'added' }))
    } catch (err) {
      setAddStatus(prev => ({ ...prev, [index]: 'error' }))
      setError(getErrorMessage(err, 'Failed to add track.'))
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const sid = params.get('sessionId')
    const errMsg = params.get('error')

    if (errMsg) {
      setError(`Authentication error: ${errMsg}`)
      window.history.replaceState({}, document.title, window.location.pathname)
      return
    }

    if (sid) {
      sessionStorage.setItem(SESSION_STORAGE_KEY, sid)
      setSessionId(sid)
      handleLoadPlaylists(sid)
      window.history.replaceState({}, document.title, window.location.pathname)
      return
    }

    const storedSession = sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (storedSession) {
      setSessionId(storedSession)
      handleLoadPlaylists(storedSession)
    }
  }, [])

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Spotify plus Claude</p>
          <h1>Classical Playlist Recommender</h1>
        </div>
        {sessionId && (
          <button className="ghost-button" type="button" onClick={handleLogout}>
            Sign out
          </button>
        )}
      </header>

      {error && <div className="error-banner">{error}</div>}

      {view === 'login' && (
        <section className="intro-grid">
          <div className="intro-copy">
            <h2>Score a playlist like a classical listener.</h2>
            <p>
              Pick one of your Spotify playlists, let Claude read the repertoire profile,
              then generate recommendations using your composer, instrumentation, movement,
              recording, discovery, and hygiene weights.
            </p>
            <button type="button" onClick={handleLogin} disabled={loading}>
              {loading ? 'Connecting' : 'Sign in with Spotify'}
            </button>
          </div>
          <div className="weight-panel">
            <h2>Recommendation weights</h2>
            <WeightList weights={[
              { label: 'Composer/school', weight: 28 },
              { label: 'Work type/instrumentation', weight: 24 },
              { label: 'Movement/vibe', weight: 20 },
              { label: 'Performer/recording', weight: 13 },
              { label: 'Serendipity/anti-popularity', weight: 8 },
              { label: 'Quality/discovery/hygiene', weight: 7 },
            ]} />
          </div>
        </section>
      )}

      {view === 'select' && (
        <section className="workspace">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Playlist input</p>
              <h2>Select a playlist</h2>
            </div>
            <button type="button" onClick={handleAnalyze} disabled={!selectedPlaylist || loading}>
              {loading ? 'Analyzing' : 'Analyze playlist'}
            </button>
          </div>

          {playlists.length ? (
            <div className="playlist-grid">
              {playlists.map(playlist => (
                <button
                  className={`playlist-tile ${selectedPlaylist?.id === playlist.id ? 'selected' : ''}`}
                  type="button"
                  key={playlist.id}
                  onClick={() => setSelectedPlaylist(playlist)}
                >
                  <PlaylistArtwork src={playlist.imageUrl} name={playlist.name} />
                  <span className="playlist-name">{playlist.name}</span>
                  <span className="playlist-meta">
                    {formatCount(playlist.trackCount)}
                    {playlist.ownerName && ` | ${playlist.ownerName}`}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-state">No playlists were returned for this account.</div>
          )}
        </section>
      )}

      {view === 'analyzing' && (
        <section className="status-panel">
          <p className="eyebrow">Claude analysis</p>
          <h2>{selectedTrackLabel}</h2>
          <div className="meter" aria-hidden="true">
            <span />
          </div>
          <p>Reading composer, form, recording, and movement-level signals.</p>
        </section>
      )}

      {view === 'results' && analysis && (
        <section className="workspace">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Analysis</p>
              <h2>{selectedTrackLabel}</h2>
            </div>
            <div className="button-row">
              <button className="ghost-button" type="button" onClick={() => setView('select')}>
                Back
              </button>
              <button type="button" onClick={handleGetRecommendations} disabled={loading}>
                {loading ? 'Scoring' : 'Get recommendations'}
              </button>
            </div>
          </div>

          <div className="analysis-grid">
            <article className="analysis-panel wide">
              <p className="panel-label">Taste profile</p>
              <div className="chat-output">
                <ReactMarkdown>{analysisMarkdown}</ReactMarkdown>
              </div>
            </article>
          </div>

          {loading && (
            <div className="progress-note">
              Scoring recommendations against composer, instrumentation, movement, recording, and discovery weights.
            </div>
          )}

          {!!recommendations.length && (
            <div className="recommendation-layout">
              <aside className="weight-panel sticky">
                <p className="panel-label">Applied weights</p>
                <WeightList weights={weights} />
              </aside>
              <div className="rec-list">
                {recommendations.map((rec, index) => (
                  <RecommendationCard
                    key={`${rec.piece}-${rec.composer}-${index}`}
                    rec={rec}
                    index={index}
                    status={addStatus[index]}
                    onAdd={handleAddTrack}
                  />
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </main>
  )
}
