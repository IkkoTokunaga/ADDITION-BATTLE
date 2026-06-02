// @ts-check
import { defineConfig } from 'astro/config';

import alpinejs from '@astrojs/alpinejs';

import vercel from '@astrojs/vercel';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://addition.ikk-dev.jp',
  output: 'server',
  integrations: [alpinejs()],
  adapter: vercel(),

  vite: {
    plugins: [tailwindcss()]
  }
});