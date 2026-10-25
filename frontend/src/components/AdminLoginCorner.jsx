import { useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import './AdminLoginCorner.css'
import { formatUserFacingError } from '../apex/humanReadableError.js'

export function AdminLoginCorner() {
  const { signInAdminDev, adminDevSession } = useAuth()
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [err, setErr] = useState(null)

  if (adminDevSession) {
    return null
  }

  async function onSubmit(e) {
    e.preventDefault()
    setErr(null)
    try {
      await signInAdminDev(password)
      setOpen(false)
      setPassword('')
    } catch (e2) {
      setErr(formatUserFacingError(e2) || 'Login failed')
    }
  }

  return (
    <div className="admin-login-corner">
      <button
        type="button"
        className="admin-login-trigger"
        onClick={() => {
          setOpen(true)
          setErr(null)
        }}
      >
        Admin login
      </button>
      {open && (
        <div
          className="admin-login-backdrop"
          role="presentation"
          onClick={() => {
            setOpen(false)
            setPassword('')
            setErr(null)
          }}
        />
      )}
      {open && (
        <form className="admin-login-popover" onSubmit={onSubmit}>
          <label className="admin-login-label" htmlFor="admin-login-pw">
            Dev password
          </label>
          <input
            id="admin-login-pw"
            type="password"
            className="admin-login-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
            placeholder="Password"
          />
          {err && <p className="admin-login-err">{err}</p>}
          <div className="admin-login-actions">
            <button type="button" className="admin-login-cancel" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="admin-login-submit">
              Enter
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
