import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

// Vite requires a default export from its config file.
// eslint-disable-next-line no-restricted-syntax
export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 600, // recharts + react ship as one ~150 kB gzip vendor chunk
    rollupOptions: {
      output: {
        manualChunks: {vendor: ['react', 'react-dom', 'recharts']},
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Keep the browser's Host header so the server's host/origin checks see the real values.
      '/api': {target: 'http://127.0.0.1:3030', changeOrigin: false},
    },
  },
});
