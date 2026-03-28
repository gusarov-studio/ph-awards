import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/oauth': {
        target: 'https://api.producthunt.com',
        changeOrigin: true,
        rewrite: (path) => `/v2${path}`,
      },
      '/graphql': {
        target: 'https://api.producthunt.com',
        changeOrigin: true,
        rewrite: () => '/v2/api/graphql',
      },
    },
  },
})
