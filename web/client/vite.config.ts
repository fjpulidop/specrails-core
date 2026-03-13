import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4201,
    proxy: {
      '/api': 'http://localhost:4200',
      '/hooks': 'http://localhost:4200',
    },
  },
})
