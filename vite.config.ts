import { defineConfig } from 'vite';

export default defineConfig({
  // served from https://justgoscha.github.io/infinizine/
  base: process.env.GITHUB_ACTIONS ? '/infinizine/' : '/',
});
