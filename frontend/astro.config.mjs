import { defineConfig } from 'astro/config';
import solid from '@astrojs/solid-js';
import extractInlineScripts from './plugins/vite-plugin-extract-inline-scripts.mjs';

export default defineConfig({
  server: {
    host: true,
  },
  preview: {
    host: true,
  },
  integrations: [solid()],
  vite: {
    plugins: [extractInlineScripts()],
  },
});
