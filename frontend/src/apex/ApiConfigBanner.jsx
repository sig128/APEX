import { isHostingChatApiMisconfigured } from './apiConfig.js'
import './ApiConfigBanner.css'

export function ApiConfigBanner() {
  if (!isHostingChatApiMisconfigured()) return null
  return (
    <div className="apex-api-banner" role="alert">
      <strong>Chat API misconfiguration:</strong> this build has no <code>VITE_API_BASE</code>. Long
      ANALYZE runs will stop (~60s) because requests go through Firebase Hosting. Rebuild with{' '}
      <code>frontend/.env.production</code> set to your Cloud Function URL (see{' '}
      <code>frontend/.env.example</code>), then redeploy.
    </div>
  )
}
