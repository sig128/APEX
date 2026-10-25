import { useState, useEffect, useCallback } from 'react'
import { apiUrl } from '../apex/apiConfig.js'
import { useSportsConfig } from '../context/SportsConfigContext.jsx'
import './AdminSportsPage.css'

const LABELS = {
  baseball_mlb: 'MLB',
  icehockey_nhl: 'NHL',
  basketball_nba: 'NBA',
  americanfootball_nfl: 'NFL',
}

const ORDER = ['baseball_mlb', 'icehockey_nhl', 'basketball_nba', 'americanfootball_nfl']

export function AdminSportsPage() {
  const { refresh } = useSportsConfig()
  const [disabled, setDisabled] = useState([])
  const [adminKey, setAdminKey] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setStatus('')
    try {
      const r = await fetch(apiUrl('/api/config/sports'))
      const j = await r.json()
      setDisabled(Array.isArray(j.disabledSportKeys) ? [...j.disabledSportKeys] : [])
    } catch (e) {
      setStatus(e?.message || 'Could not load config.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const enabled = (key) => !disabled.includes(key)

  const toggle = (key) => {
    setDisabled((d) => (d.includes(key) ? d.filter((x) => x !== key) : [...d, key]))
  }

  const save = async () => {
    setStatus('')
    const k = adminKey.trim()
    if (!k) {
      setStatus('Enter the admin key (same as ADMIN_SPORTS_KEY on the server).')
      return
    }
    try {
      const r = await fetch(apiUrl('/api/admin/sports'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Apex-Admin-Key': k,
        },
        body: JSON.stringify({ disabledSportKeys: disabled }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        setStatus(typeof j.error === 'string' ? j.error : `Error ${r.status}`)
        return
      }
      setStatus('Saved. Changes apply within ~30s for clients.')
      await refresh()
      void load()
    } catch (e) {
      setStatus(e?.message || 'Save failed.')
    }
  }

  return (
    <div className="admin-sports">
      <header className="admin-sports__hdr">
        <h1 className="admin-sports__title">Sport availability</h1>
        <p className="admin-sports__sub">
          Turn leagues off system-wide (analyzer, schedules, MLB live lines). Disabled sports are hidden or blocked on the
          API.
        </p>
      </header>

      {loading ? (
        <p className="admin-sports__loading">Loading…</p>
      ) : (
        <ul className="admin-sports__list">
          {ORDER.map((key) => (
            <li key={key} className="admin-sports__row">
              <label className="admin-sports__label">
                <input
                  type="checkbox"
                  className="admin-sports__cb"
                  checked={enabled(key)}
                  onChange={() => toggle(key)}
                />
                <span className="admin-sports__name">{LABELS[key] || key}</span>
                <span className="admin-sports__meta">{key}</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <div className="admin-sports__save">
        <label className="admin-sports__key-label">
          Admin key
          <input
            type="password"
            className="admin-sports__key-input"
            autoComplete="off"
            value={adminKey}
            onChange={(e) => setAdminKey(e.target.value)}
            placeholder="ADMIN_SPORTS_KEY"
          />
        </label>
        <button type="button" className="admin-sports__btn" onClick={() => void save()}>
          Save
        </button>
      </div>

      {status ? (
        <p className="admin-sports__status" role="status">
          {status}
        </p>
      ) : null}
    </div>
  )
}
