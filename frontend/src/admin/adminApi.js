// The admin API. The password's session cookie goes along by itself (HttpOnly, so this code never
// sees it), and no Google sign-in is involved.
import { api } from '../lib/api.js'

export const adminApi = (path, opts = {}) => api(path, { ...opts, auth: false })
