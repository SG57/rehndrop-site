// @ts-check
import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// One switch: committing public/CNAME moves the whole site from the github.io
// project path to the custom domain (site URL, base path, canonical links, sitemap).
const cname = existsSync('./public/CNAME') ? readFileSync('./public/CNAME', 'utf8').trim() : '';

export default defineConfig({
  site: cname ? `https://${cname}` : 'https://sg57.github.io',
  base: cname ? '/' : '/rehndrop-site',
  trailingSlash: 'ignore',
  output: 'static',
  integrations: [sitemap()],
  image: {
    // tracks that are live on Apple but not yet exported locally use Apple's artwork
    remotePatterns: [{ protocol: 'https', hostname: '**.mzstatic.com' }],
  },
  build: { inlineStylesheets: 'auto' },
});
