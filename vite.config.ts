import { defineConfig } from 'vite';
import pkg from './package.json';

export default defineConfig({
  define: {
    // stamped into every saved zine (doc.app) and shown in settings
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // served from https://justgoscha.github.io/infinizine/
  base: process.env.GITHUB_ACTIONS ? '/infinizine/' : '/',
});
