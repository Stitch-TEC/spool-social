import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/spool-social/', // <--- IMPORTANT: This must match your GitHub Repo name
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