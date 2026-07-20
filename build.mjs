import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

async function copyStaticFiles() {
  await mkdir(dist, { recursive: true });
  await Promise.all([
    cp(path.join(root, 'manifest.json'), path.join(dist, 'manifest.json')),
    cp(path.join(root, 'popup.html'), path.join(dist, 'popup.html')),
    cp(path.join(root, 'src/styles.css'), path.join(dist, 'popup.css')),
  ]);
}

await rm(dist, { recursive: true, force: true });
await copyStaticFiles();

const options = {
  entryPoints: {
    background: path.join(root, 'src/background.ts'),
    popup: path.join(root, 'src/popup.ts'),
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome116',
  outdir: dist,
  entryNames: '[name]',
  sourcemap: false,
  logLevel: 'info',
};

// A separate build, not an extra entryPoints key: MV3 content scripts
// injected via chrome.scripting.executeScript's `files` option don't
// support top-level ESM the way the service worker (background.js) does,
// so these need their own `format: 'iife'`.
const contentScriptOptions = {
  entryPoints: {
    scrapeListing: path.join(root, 'src/content/scrape-listing.ts'),
    scrapeProduct: path.join(root, 'src/content/scrape-product.ts'),
    addToBag: path.join(root, 'src/content/add-to-bag.ts'),
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome116',
  outdir: dist,
  entryNames: '[name]',
  sourcemap: false,
  logLevel: 'info',
};

if (watch) {
  const [ctx, contentCtx] = await Promise.all([context(options), context(contentScriptOptions)]);
  await Promise.all([ctx.watch(), contentCtx.watch()]);
  console.log('Watching Bareeze extension sources...');
} else {
  await Promise.all([build(options), build(contentScriptOptions)]);
}
