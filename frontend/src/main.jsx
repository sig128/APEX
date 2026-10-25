import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App.jsx'
import { maybePlayIntro } from './intro/intro.js'
import { api } from './lib/api.js'
import { mutate } from './lib/useApi.js'
import './styles/tokens.css'
import './styles/app.css'

// The intro plays over the first paint at most every few hours, with this week's real numbers.
// The same request warms the home page's data, so the board is there when the curtain lifts.
const home = api('/api/nfl/home', { auth: false }).then(
  (d) => {
    mutate('/api/nfl/home', d)
    return d
  },
  () => null,
)
const stats = Promise.race([home, new Promise((r) => setTimeout(() => r(null), 1500))]).then((d) => {
  if (!d) return null
  const chips = (d.tabs?.apex || []).slice(0, 8).map((c) => [`${c.short} · ${c.shortLabel}`, c.l10 ? `${c.l10.hits}/${c.l10.n}` : `${Math.round(c.prob * 100)}%`, 'green'])
  return { week: d.week, games: d.counts?.games, live: d.counts?.live, props: d.counts?.props, chips }
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)

if (window.location.pathname === '/' || window.location.pathname === '/nfl') maybePlayIntro({ stats })
