import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App.jsx'
import { maybePlayIntro } from './intro/intro.js'
import { api } from './lib/api.js'
import { mutate } from './lib/useApi.js'
import { sportFromPath, sportInfo, isSport, apiOf } from './lib/sport.js'
import './styles/tokens.css'
import './styles/app.css'

// A picks page the server couldn't render itself arrives as /?to=/u/handle: open it in place.
{
  const to = new URLSearchParams(window.location.search).get('to')
  if (to && /^\/u\/[a-z0-9_]{3,20}$/i.test(to)) window.history.replaceState(null, '', to)
}

// The intro plays over the first paint at most every few hours, with the real numbers of the
// league you land on. The same request warms that league's home page, so the board is there
// when the curtain lifts.
const path = window.location.pathname
const first = path.split('/')[1] || ''
const landingHome = path === '/' || (isSport(first) && path.replace(/\/+$/, '') === `/${first}`)
const league = sportFromPath(path)
const homeUrl = `${apiOf(league)}/home`
const home = landingHome
  ? api(homeUrl, { auth: false }).then(
      (d) => {
        mutate(homeUrl, d)
        return d
      },
      () => null,
    )
  : Promise.resolve(null)
const stats = Promise.race([home, new Promise((r) => setTimeout(() => r(null), 1500))]).then((d) => {
  if (!d) return null
  const chips = (d.tabs?.apex || []).slice(0, 8).map((c) => [`${c.short} · ${c.shortLabel}`, c.l10 ? `${c.l10.hits}/${c.l10.n}` : `${Math.round(c.prob * 100)}%`, 'green'])
  return { week: d.calendar === 'day' ? null : d.week, games: d.counts?.games, live: d.counts?.live, props: d.counts?.props, chips }
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)

if (landingHome) maybePlayIntro({ stats, chipText: sportInfo(league).name })
