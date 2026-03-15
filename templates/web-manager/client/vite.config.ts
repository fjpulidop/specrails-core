import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => ({
  plugins: [tailwindcss(), react()],
  define: {
    __WS_URL__: mode === 'development'
      ? JSON.stringify('ws://localhost:4200')
      : JSON.stringify(''),
  },
  server: {
    port: 4201,
    proxy: {
      '/api': 'http://localhost:4200',
      '/hooks': 'http://localhost:4200',
    },
  },
}))
