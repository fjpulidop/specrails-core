import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    port: 4201,
    proxy: {
      '/api': 'http://localhost:4200',
      '/hooks': 'http://localhost:4200',
    },
  },
})
