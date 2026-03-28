import { useState, useCallback, useEffect } from 'react'
import './App.css'

// Vite dev-server proxies these to https://api.producthunt.com/v2/…
const OAUTH_URL = '/oauth/token'
const GRAPHQL_URL = '/graphql'

export const DEFAULT_CLIENT_ID = '_MIZlP5Bu_n3hmjXWZODgCvEeVokVjN3a4EMXUTCXBc'
export const DEFAULT_CLIENT_SECRET = 'c62u4KtG83ElLQTrExQGH47ffsgNWOetvj01vTSoEyQ'

// ── OAuth token cache (keyed by credential pair) ───────────────────────────────
const _tokenCache = {}
async function getAccessToken(clientId, clientSecret) {
  const key = `${clientId}::${clientSecret}`
  if (_tokenCache[key]) return _tokenCache[key]
  const res = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`Auth error ${res.status}: ${text}`)
  }
  const json = await res.json()
  if (!json.access_token) throw new Error('Invalid credentials — no access token returned.')
  _tokenCache[key] = json.access_token
  return _tokenCache[key]
}

const TOPICS_QUERY = `
  query GetTopics {
    topics(first: 100, order: FOLLOWERS_COUNT) {
      edges {
        node {
          id
          name
          slug
        }
      }
    }
  }
`

const POSTS_QUERY = `
  query GetFeaturedPosts($postedAfter: DateTime, $postedBefore: DateTime, $after: String, $topic: String) {
    posts(
      order: VOTES
      featured: true
      postedAfter: $postedAfter
      postedBefore: $postedBefore
      topic: $topic
      first: 50
      after: $after
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          name
          tagline
          thumbnail { url }
          votesCount
          commentsCount
          url
          featuredAt
          dailyRank
          topics {
            edges {
              node { name }
            }
          }
        }
      }
    }
  }
`

// ── API ────────────────────────────────────────────────────────────────────────

async function gql(query, variables = {}, clientId, clientSecret) {
  const token = await getAccessToken(clientId, clientSecret)
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`API error ${res.status}: ${text}`)
  }
  const json = await res.json()
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join(' | '))
  return json.data
}

async function fetchTopics(clientId, clientSecret) {
  const data = await gql(TOPICS_QUERY, {}, clientId, clientSecret)
  return data.topics.edges.map((e) => e.node)
}

async function fetchAllPosts(startDate, endDate, topic, clientId, clientSecret) {
  // PH runs on Pacific Time (UTC-8). Widen by 1 day on each side so we don't
  // miss products near the PT midnight boundary when the user's dates are in local time.
  const pad = (dateStr, deltaDays) => {
    const d = new Date(dateStr + 'T12:00:00Z')
    d.setUTCDate(d.getUTCDate() + deltaDays)
    return d.toISOString().substring(0, 10)
  }
  const paddedStart = pad(startDate, -1)
  const paddedEnd = pad(endDate, +1)

  let allPosts = []
  let hasNextPage = true
  let cursor = null

  while (hasNextPage) {
    const variables = {
      postedAfter: `${paddedStart}T00:00:00.000Z`,
      postedBefore: `${paddedEnd}T23:59:59.999Z`,
      after: cursor,
    }
    if (topic) variables.topic = topic

    const data = await gql(POSTS_QUERY, variables, clientId, clientSecret)
    const page = data.posts
    allPosts = allPosts.concat(page.edges.map((e) => e.node))
    hasNextPage = page.pageInfo.hasNextPage && allPosts.length < 500
    cursor = page.pageInfo.endCursor
  }

  return allPosts
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// Product Hunt runs on Pacific Time (UTC-8, ignoring DST for simplicity).
// Convert a UTC ISO string to a YYYY-MM-DD string in PT.
function toPacificDate(isoStr) {
  if (!isoStr) return ''
  const ms = new Date(isoStr).getTime() - 8 * 60 * 60 * 1000
  return new Date(ms).toISOString().substring(0, 10)
}

const RANK_LABEL = { 1: '1st', 2: '2nd', 3: '3rd' }

// Extract top-3 products per day using the API's `dailyRank` field.
// Only returns days within the user-selected date range (in PT).
function extractPotd(posts, startDate, endDate) {
  const byDay = {}
  for (const post of posts) {
    const day = toPacificDate(post.featuredAt)
    if (!day || day < startDate || day > endDate) continue
    if (!byDay[day]) byDay[day] = []
    byDay[day].push(post)
  }

  return Object.entries(byDay)
    .map(([date, dayPosts]) => {
      const sorted = dayPosts.sort((a, b) => (a.dailyRank ?? Infinity) - (b.dailyRank ?? Infinity))
      const top = sorted.filter((p) => p.dailyRank >= 1 && p.dailyRank <= 3)
      return { date, top }
    })
    .filter((d) => d.top.length > 0)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
}

function todayStr() {
  return new Date().toISOString().substring(0, 10)
}
function daysAgoStr(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().substring(0, 10)
}
function formatDay(dateStr) {
  // Parse as local date to avoid UTC-offset issues
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

// ── Components ─────────────────────────────────────────────────────────────────

function ProductCard({ post }) {
  const topics = post.topics?.edges?.map((e) => e.node.name) ?? []
  const initial = (post.name?.[0] ?? '?').toUpperCase()
  const rankLabel = RANK_LABEL[post.dailyRank]

  return (
    <a
      href={post.url}
      target="_blank"
      rel="noopener noreferrer"
      className="product-card"
    >
      {post.thumbnail?.url ? (
        <img src={post.thumbnail.url} alt={post.name} className="product-thumb" />
      ) : (
        <div className="product-thumb-placeholder">{initial}</div>
      )}

      <div className="product-info">
        <div className="product-name">
          {post.name}
          {rankLabel && <span className={`rank-badge rank-${post.dailyRank}`}>{rankLabel}</span>}
        </div>
        <div className="product-tagline">{post.tagline}</div>
        {topics.length > 0 && (
          <div className="product-topics">
            {topics.slice(0, 4).map((t) => (
              <span key={t} className="topic-tag">{t}</span>
            ))}
          </div>
        )}
      </div>

      <div className="product-votes">
        <span className="vote-arrow">▲</span>
        <span className="vote-count">{post.votesCount.toLocaleString()}</span>
        <span className="vote-label">votes</span>
      </div>
    </a>
  )
}

// ── App ────────────────────────────────────────────────────────────────────────

export default function App() {
  const [clientId, setClientId] = useState(DEFAULT_CLIENT_ID)
  const [clientSecret, setClientSecret] = useState(DEFAULT_CLIENT_SECRET)
  const [credStatus, setCredStatus] = useState('idle') // idle | connecting | ok | error
  const [credError, setCredError] = useState('')

  const [startDate, setStartDate] = useState(daysAgoStr(7))
  const [endDate, setEndDate] = useState(todayStr())
  const [topic, setTopic] = useState('')
  const [topics, setTopics] = useState([])
  const [topicsLoading, setTopicsLoading] = useState(true)
  const [status, setStatus] = useState('idle') // idle | loading | done | error
  const [days, setDays] = useState([])
  const [errorMsg, setErrorMsg] = useState('')

  const loadTopics = useCallback((id, secret) => {
    setTopicsLoading(true)
    setTopics([])
    fetchTopics(id, secret)
      .then(setTopics)
      .catch(() => {})
      .finally(() => setTopicsLoading(false))
  }, [])

  useEffect(() => {
    loadTopics(DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleConnect = useCallback(async () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      setCredError('Both Client ID and Client Secret are required.')
      setCredStatus('error')
      return
    }
    setCredStatus('connecting')
    setCredError('')
    try {
      await getAccessToken(clientId.trim(), clientSecret.trim())
      setCredStatus('ok')
      setDays([])
      setStatus('idle')
      loadTopics(clientId.trim(), clientSecret.trim())
    } catch (err) {
      setCredStatus('error')
      setCredError(err.message)
    }
  }, [clientId, clientSecret, loadTopics])

  const activeId = clientId.trim() || DEFAULT_CLIENT_ID
  const activeSecret = clientSecret.trim() || DEFAULT_CLIENT_SECRET

  const handleSearch = useCallback(async () => {
    if (!startDate || !endDate) return
    if (startDate > endDate) {
      setErrorMsg('Start date must be before or equal to end date.')
      setStatus('error')
      return
    }

    setStatus('loading')
    setErrorMsg('')
    setDays([])

    try {
      const posts = await fetchAllPosts(startDate, endDate, topic || null, activeId, activeSecret)
      setDays(extractPotd(posts, startDate, endDate))
      setStatus('done')
    } catch (err) {
      setErrorMsg(err.message)
      setStatus('error')
    }
  }, [startDate, endDate, topic, activeId, activeSecret])

  const today = todayStr()

  return (
    <>
      <header className="header">
        <div className="header-inner">
          <div className="ph-logo">PH</div>
          <h1>Product of the Day Awards</h1>
        </div>
      </header>

      <main className="page">
        {/* ── Credentials ── */}
        <section className="credentials">
          <div className="filters-label">API Credentials</div>
          <div className="filter-row">
            <div className="filter-group">
              <label htmlFor="client-id">Client ID</label>
              <input
                id="client-id"
                type="text"
                value={clientId}
                placeholder="Your Product Hunt Client ID"
                onChange={(e) => { setClientId(e.target.value); setCredStatus('idle') }}
                spellCheck={false}
              />
            </div>
            <div className="filter-group">
              <label htmlFor="client-secret">Client Secret</label>
              <input
                id="client-secret"
                type="password"
                value={clientSecret}
                placeholder="Your Product Hunt Client Secret"
                onChange={(e) => { setClientSecret(e.target.value); setCredStatus('idle') }}
              />
            </div>
            <button
              className={`connect-btn ${credStatus === 'ok' ? 'connect-btn--ok' : ''}`}
              onClick={handleConnect}
              disabled={credStatus === 'connecting'}
            >
              {credStatus === 'connecting' ? 'Connecting…' : credStatus === 'ok' ? '✓ Connected' : 'Connect'}
            </button>
          </div>
          {credStatus === 'error' && <div className="cred-error">⚠ {credError}</div>}
          <p className="cred-note">
            Get your credentials from the{' '}
            <a href="https://api.producthunt.com/v2/docs" target="_blank" rel="noopener noreferrer">API docs</a>.
            {' '}Each key is subject to{' '}
            <a href="https://api.producthunt.com/v2/docs/rate_limits/headers" target="_blank" rel="noopener noreferrer">rate limits</a>
            {' '}— use your own credentials to avoid hitting shared limits.
          </p>
        </section>

        {/* ── Filters ── */}
        <section className="filters">
          <div className="filters-label">Filters</div>
          <div className="filter-row">
            <div className="filter-group">
              <label htmlFor="start-date">From</label>
              <input
                id="start-date"
                type="date"
                value={startDate}
                max={endDate || today}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="filter-group">
              <label htmlFor="end-date">To</label>
              <input
                id="end-date"
                type="date"
                value={endDate}
                min={startDate}
                max={today}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
            <div className="filter-group">
              <label htmlFor="category">Category</label>
              <select
                id="category"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                disabled={topicsLoading}
              >
                <option value="">{topicsLoading ? 'Loading…' : 'All categories'}</option>
                {topics.map((t) => (
                  <option key={t.slug} value={t.slug}>{t.name}</option>
                ))}
              </select>
            </div>
            <button
              className="search-btn"
              onClick={handleSearch}
              disabled={status === 'loading'}
            >
              {status === 'loading' ? 'Fetching…' : 'Search'}
            </button>
          </div>
        </section>

        {/* ── Error ── */}
        {status === 'error' && (
          <div className="error-box">⚠ {errorMsg}</div>
        )}

        {/* ── Loading ── */}
        {status === 'loading' && (
          <div className="loading">
            <div className="spinner" />
            <span className="loading-text">Fetching Product Hunt data…</span>
          </div>
        )}

        {/* ── Initial state ── */}
        {status === 'idle' && (
          <div className="initial-state">
            <div className="state-icon">🏆</div>
            <div className="state-title">Discover Product of the Day Winners</div>
            <div className="state-desc">
              Select a date range above and click Search to see the #1 ranked
              product for each day.
            </div>
          </div>
        )}

        {/* ── Empty ── */}
        {status === 'done' && days.length === 0 && (
          <div className="empty-state">
            <div className="state-icon">🔍</div>
            <div className="state-title">No results</div>
            <div className="state-desc">
              No featured products were found for the selected date range.
            </div>
          </div>
        )}

        {/* ── Results ── */}
        {status === 'done' && days.length > 0 && (
          <>
            <div className="results-meta">
              Showing {days.length} Product{days.length !== 1 ? 's' : ''} of the Day
            </div>
            {days.map(({ date, top }) => (
              <div key={date} className="day-section">
                <div className="day-header">
                  <span className="day-date">{formatDay(date)}</span>
                </div>
                <div className="day-cards">
                  {top.map((post) => (
                    <ProductCard key={post.id} post={post} />
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
      </main>
    </>
  )
}
