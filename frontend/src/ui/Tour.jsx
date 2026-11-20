import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { sp, useSport } from '../lib/sport.js'

/**
 * The onboarding tour: a few steps that point at the real screen, one idea each. Every step can
 * be skipped; it can be replayed from the footer. Starts once, after the consent screen and the
 * intro, on a first visit.
 */
export const STEPS = [
  { target: '.board-tabs', title: 'Today’s board', text: 'The day’s props, ranked by the PropPickz score: hit rate, projection, matchup and role in one number. Tap any prop to see why.' },
  { target: '[data-tour="prop"]', title: 'Research any player', text: 'Every prop opens its research: last 5 and 10 games, the matchup, the minutes or snaps behind it, and how the line has moved.' },
  { target: '[data-tour="slip"]', title: 'Build a slip', text: 'Add props to your slip. It shows the parlay’s real chance, every sportsbook’s price, and opens your book with the bet on it.' },
  { target: '[data-tour="picks"]', title: 'Track your picks', text: 'Post picks to your page and they’re graded for you: wins, losses, units and your trends over time.' },
  { target: '[data-tour="live"]', title: 'Live and lineups', text: 'Follow games as they happen, with lineup and injury news and line moves on the picks you care about.' },
  { target: null, title: 'Go further', text: 'Pro adds model reads on every prop, the parlay simulator, Smart Check on your slip and the live movement ticker.' },
]
const KEY = 'apex_tour'

const read = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null')
  } catch {
    return null
  }
}
const save = (v) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(v))
  } catch {
    /* blocked */
  }
}
const count = (action, step) => api('/api/members/tour', { method: 'POST', body: { action, ...(step != null ? { step } : {}) }, auth: false }).catch(() => null)

/** The first element for a step that's on screen (the header's on a desktop, the tab bar's on a phone). */
function findTarget(sel) {
  if (!sel) return null
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') return el
  }
  return null
}

/** Ask the tour to play again (the footer's "Take the tour"). */
export function replayTour() {
  window.dispatchEvent(new Event('apex:tour'))
}

export function Tour() {
  const [step, setStep] = useState(null)
  const [box, setBox] = useState(null)
  const card = useRef(null)
  const nav = useNavigate()
  const loc = useLocation()
  const sport = useSport()
  const onHome = loc.pathname === sp(sport, '') || loc.pathname === '/'

  const start = useCallback(
    (replay = false) => {
      if (!onHome) nav(sp(sport, ''))
      count(replay ? 'replay' : 'start')
      setStep(0)
    },
    [onHome, nav, sport],
  )

  useEffect(() => {
    // a first visit: after the consent screen and the intro
    const first = () => {
      if (!read()) start(false)
    }
    const again = () => start(true)
    window.addEventListener('apex:welcomed', first)
    window.addEventListener('apex:tour', again)
    return () => {
      window.removeEventListener('apex:welcomed', first)
      window.removeEventListener('apex:tour', again)
    }
  }, [start])

  // find this step's element (the board may still be loading), bring it into view, measure it
  useLayoutEffect(() => {
    if (step == null) return undefined
    count('step', step)
    let tries = 0
    let timer = null
    let el = null
    const measure = () => {
      if (!el) return setBox(null)
      const r = el.getBoundingClientRect()
      setBox({ x: r.left, y: r.top, w: r.width, h: r.height })
    }
    const look = () => {
      el = findTarget(STEPS[step].target)
      if (!el && STEPS[step].target && tries++ < 12) {
        timer = setTimeout(look, 150)
        return
      }
      if (el) {
        const r = el.getBoundingClientRect()
        // in view, clear of the sticky header and of the card's room
        if (r.top < 80 || r.bottom > window.innerHeight - 240) {
          window.scrollTo({ top: Math.max(0, window.scrollY + r.top - Math.max(90, (window.innerHeight - 240 - r.height) / 2)), behavior: 'instant' })
        }
      }
      measure()
    }
    look()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, { passive: true })
    return () => {
      clearTimeout(timer)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure)
    }
  }, [step])

  useEffect(() => {
    if (step == null) return undefined
    card.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') skip()
      if (e.key === 'ArrowRight') next()
      if (e.key === 'ArrowLeft' && step > 0) setStep(step - 1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  if (step == null) return null
  const s = STEPS[step]
  const last = step === STEPS.length - 1
  function next() {
    if (last) {
      save({ done: true, at: Date.now() })
      count('done')
      setStep(null)
    } else setStep(step + 1)
  }
  function skip() {
    save({ skipped: step, at: Date.now() })
    count('skip', step)
    setStep(null)
  }
  // the spotlight stays on screen; the card sits under it, or above it, or in the middle when
  // neither has room
  const pad = 8
  const vh = window.innerHeight
  const vw = window.innerWidth
  let hole = null
  if (box) {
    const top = Math.max(6, box.y - pad)
    const bottom = Math.min(vh - 6, box.y + box.h + pad)
    const left = Math.max(6, box.x - pad)
    const right = Math.min(vw - 6, box.x + box.w + pad)
    if (bottom - top > 12 && right - left > 12) hole = { left, top, width: right - left, height: bottom - top }
  }
  const CARD = 240
  const pos = !hole ? { className: 'is-center' } : vh - (hole.top + hole.height) > CARD ? { style: { top: hole.top + hole.height + 12 } } : hole.top > CARD ? { style: { bottom: vh - hole.top + 12 } } : { className: 'is-center' }
  // on a wide screen the card lines up with what it points at
  if (hole && pos.style && vw >= 720) pos.style.left = Math.min(vw - 211, Math.max(211, hole.left + hole.width / 2))
  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-h">
      {hole ? <div className="tour__hole" style={hole} /> : <div className="tour__dim" />}
      <div ref={card} tabIndex={-1} className={`tour__card ${pos.className || ''}`} style={pos.style}>
        <p className="tour__count num">
          {step + 1} of {STEPS.length}
        </p>
        <h2 id="tour-h" className="tour__title">
          {s.title}
        </h2>
        <p className="tour__text">{s.text}</p>
        <div className="tour__dots" aria-hidden="true">
          {STEPS.map((_, i) => (
            <span key={i} className={i === step ? 'is-on' : i < step ? 'is-past' : ''} />
          ))}
        </div>
        <div className="tour__actions">
          <button type="button" className="linkish tour__skip" onClick={skip}>
            Skip tour
          </button>
          {step > 0 && (
            <button type="button" className="btn btn--quiet btn--s" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          {last ? (
            <>
              <Link className="btn btn--quiet btn--s" to="/pricing" onClick={next}>
                See plans
              </Link>
              <button type="button" className="btn btn--lime btn--s" onClick={next}>
                Start
              </button>
            </>
          ) : (
            <button type="button" className="btn btn--lime btn--s" onClick={next}>
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
