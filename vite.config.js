import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Cloudflare Worker serves the app at the root path, so base is '/'.
  // Set DEPLOY_TARGET=pages to build for the legacy GitHub Pages subpath.
  base: process.env.DEPLOY_TARGET === 'pages' ? '/spool-social/' : '/',
  // In `vite dev`, proxy API + media calls to the local `wrangler dev` server.
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/media': 'http://localhost:8787',
    },
  },
  build: {
    // Spool is installed and used from iPhones. Vite 7's moving default targets
    // substantially newer Safari releases; pin the compatibility floor so a
    // dependency refresh cannot silently emit syntax an otherwise-working
    // iPhone cannot parse. Built-ins used on the cold path are kept to this
    // floor in source as well (notably no String#replaceAll requirement).
    target: ['es2020', 'safari14'],
    rollupOptions: {
      output: {
        // Split heavyweight vendors into separate long-term-cacheable chunks
        // so app-code changes don't invalidate the whole bundle.
        manualChunks: {
          // 'react-dom' alone does NOT capture the react-dom/client entry the app
          // actually imports — without it the ~180KB renderer lands in the app
          // chunk and is re-downloaded on every deploy.
          'vendor-react': ['react', 'react-dom', 'react-dom/client'],
          'vendor-firebase': ['firebase/app', 'firebase/auth', 'firebase/firestore'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.js',
    // firebase.js calls getAuth() at module load, which throws without an API
    // key. Bake harmless dummies into test runs so a fresh clone's `npm test`
    // works without a .env (CI sets the same values in its own env block).
    env: {
      VITE_FIREBASE_API_KEY: 'test-dummy-api-key',
      VITE_FIREBASE_AUTH_DOMAIN: 'localhost',
      VITE_FIREBASE_PROJECT_ID: 'test-dummy',
      VITE_FIREBASE_APP_ID: 'test-dummy-app-id',
    },
  },
})
