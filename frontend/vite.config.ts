import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@components': path.resolve(__dirname, './src/components'),
      '@pages': path.resolve(__dirname, './src/pages'),
      '@hooks': path.resolve(__dirname, './src/hooks'),
      '@services': path.resolve(__dirname, './src/services'),
      '@types': path.resolve(__dirname, './src/types'),
      '@context': path.resolve(__dirname, './src/context'),
      '@utils': path.resolve(__dirname, './src/utils'),
    },
  },
  server: {
    port: 3000,
  },
  test: {
    environment: 'jsdom',
    setupFiles: './vitest.setup.ts',
    globals: true,
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
  build: {
    // Warn when an individual chunk exceeds 250kb (developer-specified budget)
    chunkSizeWarningLimit: 250,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules')) {
            if (id.includes('react') || id.includes('react-dom')) {
              return 'vendor_react'
            }
            if (id.includes('lodash')) {
              return 'vendor_lodash'
            }
            // group remaining node_modules into vendor chunk by package name
            const parts = id.split('node_modules/')[1].split('/')
            return parts[0]
          }
        },
      },
    },
  },
})
