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
    rollupOptions: {
      output: {
        // Split heavyweight vendors into separate long-term-cacheable chunks
        // so app-code changes don't invalidate the whole bundle.
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-firebase': ['firebase/app', 'firebase/auth', 'firebase/firestore'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.js',
  },
})