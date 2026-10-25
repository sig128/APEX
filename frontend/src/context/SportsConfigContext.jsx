import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { apiUrl } from '../apex/apiConfig.js'

const SportsConfigContext = createContext(null)

export function SportsConfigProvider({ children }) {
  const [disabledSportKeys, setDisabledSportKeys] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(apiUrl('/api/config/sports'))
      const j = await r.json().catch(() => ({}))
      setDisabledSportKeys(Array.isArray(j.disabledSportKeys) ? j.disabledSportKeys : [])
    } catch {
      setDisabledSportKeys([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const isSportEnabled = useCallback(
    (sportKey) => typeof sportKey === 'string' && sportKey && !disabledSportKeys.includes(sportKey),
    [disabledSportKeys],
  )

  return (
    <SportsConfigContext.Provider value={{ disabledSportKeys, loading, refresh, isSportEnabled }}>
      {children}
    </SportsConfigContext.Provider>
  )
}

export function useSportsConfig() {
  const ctx = useContext(SportsConfigContext)
  if (!ctx) {
    throw new Error('useSportsConfig must be used within SportsConfigProvider')
  }
  return ctx
}
