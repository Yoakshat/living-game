import { defineConfig } from 'vite';

// Base path for GitHub Pages project page (served from /living-game/).
// Vite applies this in both dev and the production build so asset URLs resolve
// correctly when deployed.
export default defineConfig({
  base: '/living-game/',
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1500,
  },
});
