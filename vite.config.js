import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/spool-social/', // <--- IMPORTANT: This must match your GitHub Repo name
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.js',
  },
})