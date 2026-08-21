import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/transcribe': {
        target: 'http://localhost:5001',
        changeOrigin: true,
      },
      '/transcribe_youtube': {
        target: 'http://localhost:5001',
        changeOrigin: true,
      },
      '/youtube_metadata': {
        target: 'http://localhost:5001',
        changeOrigin: true,
      },
      '/download': {
        target: 'http://localhost:5001',
        changeOrigin: true,
      },
    }
  }
})
