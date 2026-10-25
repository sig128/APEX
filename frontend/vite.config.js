import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

/** Always treat `frontend/` as the project root (fixes `react` resolve if Vite is started from repo root). */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

function installed(pkg) {
  try {
    require.resolve(`${pkg}/package.json`, { paths: [__dirname] })
    return true
  } catch {
    return false
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '')
  const site = (env.VITE_PUBLIC_SITE_URL || '').trim().replace(/\/$/, '')
  /** Absolute URL for og:image / twitter:image when sharing links (set VITE_PUBLIC_SITE_URL in .env.production). */
  const socialImage = site ? `${site}/logo.png` : '/logo.png'
  // Privy (wallet sign-in for payments) only goes into the build when it's configured and installed.
  const privy = Boolean((env.VITE_PRIVY_APP_ID || '').trim()) && installed('@privy-io/react-auth')

  return {
    root: __dirname,
    plugins: [
      react(),
      {
        name: 'apex-html-social-meta',
        transformIndexHtml(html) {
          return html.replace(/__OG_IMAGE__/g, socialImage).replace(/__TWITTER_IMAGE__/g, socialImage)
        },
      },
    ],
    resolve: {
      alias: privy ? {} : { '@privy-io/react-auth': path.resolve(__dirname, 'src/billing/privy-stub.js') },
    },
    build: {
      outDir: 'build',
      emptyOutDir: true,
      target: 'es2020',
      chunkSizeWarningLimit: 1200,
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
