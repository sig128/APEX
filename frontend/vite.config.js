import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

/** Always treat `frontend/` as the project root (fixes `react` resolve if Vite is started from repo root). */
const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '')
  const site = (env.VITE_PUBLIC_SITE_URL || '').trim().replace(/\/$/, '')
  /** Absolute URL for og:image / twitter:image when sharing links (set VITE_PUBLIC_SITE_URL in .env.production). */
  const socialImage = site ? `${site}/logo.png` : '/logo.png'

  return {
    root: __dirname,
    plugins: [
      react(),
      {
        name: 'apex-html-social-meta',
        transformIndexHtml(html) {
          return html
            .replace(/__OG_IMAGE__/g, socialImage)
            .replace(/__TWITTER_IMAGE__/g, socialImage)
        },
      },
    ],
    build: {
      outDir: 'build',
      emptyOutDir: true,
    },
    publicDir: 'public',
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8787',
          changeOrigin: true,
        },
      },
    },
  }
})
