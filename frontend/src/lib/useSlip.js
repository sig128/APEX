import { useSyncExternalStore } from 'react'
import { getSlip, onSlip } from './slip.js'

export function useSlip() {
  return useSyncExternalStore(onSlip, getSlip, getSlip)
}
