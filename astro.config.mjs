// @ts-check
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { BOOT_JS } from './src/lib/boot-script.mjs';

// One switch: committing public/CNAME moves the whole site from the github.io
// project path to the custom domain (site URL, base path, canonical links, sitemap).
const cname = existsSync('./public/CNAME') ? readFileSync('./public/CNAME', 'utf8').trim() : '';

// Content Security Policy, delivered as a <meta http-equiv> tag on every page (GitHub Pages cannot set headers, so
// frame-ancestors, report-uri and sandbox, which a meta tag ignores, are not available: see README, "Security").
// Astro hashes the scripts and styles it bundles or inlines; the one inline script we write ourselves (the head boot
// script) is hashed here from the same string Base.astro prints. A meta policy only governs what is parsed AFTER it,
// and Astro writes it behind the boot script and the client router's module script: those two run with no policy, so
// the boot hash is not enforced today (tested: removing it changes nothing on first load or across router swaps, which
// do not re-run it). It stays so the page works if the meta ever moves ahead of it; scripts/gates/check-csp.mjs fails
// if anything else sits ahead of the meta. Everything else the site loads is same-origin,
// except YouTube thumbnails (i.ytimg.com). style-src-attr 'unsafe-inline' is the known gap: markup carries inline
// style="" attributes (per-track accent colours and the like) and nav.ts copies them across page swaps; Astro 6.4
// cannot hash attributes, so only the attribute channel is open, never <style> elements or scripts. Astro's config
// rejects a style-src-attr directive (its `kind` option arrives in 7.1), so this integration adds it to the meta tag
// after the build and fails the build if any page lacks the tag to add it to. Drop it when Astro offers the option.
const STYLE_ATTR = "style-src-attr 'unsafe-inline'";
/** @type {import('astro').AstroIntegration} */
const cspStyleAttr = {
  name: 'rehndrop-csp-style-attr',
  hooks: {
    'astro:build:done': async ({ dir }) => {
      /** @type {string[]} */
      const missing = [];
      /** @param {string} d */
      const walk = async (d) => {
        for (const e of await readdir(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) await walk(p);
          else if (e.name.endsWith('.html')) {
            const html = await readFile(p, 'utf8');
            const out = html.replace(/(<meta http-equiv="content-security-policy" content=")([^"]*)(")/, (_m, a, policy, c) => `${a}${policy.trim().replace(/;?$/, ';')} ${STYLE_ATTR};${c}`);
            if (out === html) missing.push(p);
            else await writeFile(p, out);
          }
        }
      };
      await walk(fileURLToPath(dir));
      if (missing.length) throw new Error(`csp: no content-security-policy meta tag to extend in ${missing.length} page(s), first: ${missing[0]}`);
    },
  },
};
/** @type {`sha256-${string}`} */
const bootHash = `sha256-${createHash('sha256').update(BOOT_JS).digest('base64')}`;

export default defineConfig({
  site: cname ? `https://${cname}` : 'https://sg57.github.io',
  base: cname ? '/' : '/rehndrop-site',
  trailingSlash: 'ignore',
  output: 'static',
  integrations: [sitemap(), cspStyleAttr],
  image: {
    // tracks that are live on Apple but not yet exported locally use Apple's artwork
    remotePatterns: [{ protocol: 'https', hostname: '**.mzstatic.com' }],
  },
  build: { inlineStylesheets: 'auto' },
  // no markdown on this site; Shiki's inline styles are what Astro warns about under a CSP
  markdown: { syntaxHighlight: false },
  security: {
    csp: {
      algorithm: 'SHA-256',
      scriptDirective: { hashes: [bootHash] },
      directives: [
        "default-src 'self'",
        "img-src 'self' data: https://i.ytimg.com",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-src 'none'",
      ],
    },
  },
  vite: {
    build: {
      // Only small stylesheets may be inlined (their hashes are in the policy). A small module script inlined
      // into a page makes the client router inject a data: script to wait for it, which no policy short of
      // 'data:' allows; fonts and images stay files so font-src and img-src can stay narrow.
      assetsInlineLimit: (file) => (file.endsWith('.css') ? undefined : false),
    },
  },
});
