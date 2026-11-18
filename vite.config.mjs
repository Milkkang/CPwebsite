import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

// Copy the existing storefront unchanged; Vite builds only the Worker module.
export default defineConfig({
  publicDir: './dist',
  plugins: [cloudflare()],
  build: { outDir: 'build', emptyOutDir: true }
});
