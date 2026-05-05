// Builds the embeddable widget bundle.
//
// Reads:  src/widget/bookingwidget.ts and src/widget/bookingwidget.css
// Writes: static/bookingwidget.js and static/bookingwidget.css
//
// The output files are then served by the ServeWidget HTTP-triggered function
// at GET /bookingwidget.js and GET /bookingwidget.css.
//
// Run via `npm run build:widget`.

import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = `${__dirname}/static`;

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function buildJavaScript() {
  await build({
    entryPoints: [`${__dirname}/src/widget/bookingwidget.ts`],
    bundle: true,
    minify: true,
    target: ['es2018'],
    format: 'iife',
    outfile: `${STATIC_DIR}/bookingwidget.js`,
    sourcemap: false,
    legalComments: 'none',
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  });
}

async function buildStylesheet() {
  // The CSS file is hand-authored vanilla CSS — we just minify it via esbuild's
  // CSS pipeline so that one tool handles both JS and CSS bundling.
  await build({
    entryPoints: [`${__dirname}/src/widget/bookingwidget.css`],
    bundle: true,
    minify: true,
    outfile: `${STATIC_DIR}/bookingwidget.css`,
    loader: { '.css': 'css' },
  });
}

async function main() {
  await ensureDir(STATIC_DIR);
  await Promise.all([buildJavaScript(), buildStylesheet()]);
  console.log('[build-widget] wrote bookingwidget.js and bookingwidget.css to static/');
}

main().catch((err) => {
  console.error('[build-widget] failed:', err);
  process.exit(1);
});
