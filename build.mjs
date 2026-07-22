import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const storeConfig = JSON.parse(await readFile(path.join(root, 'store.config.json'), 'utf8'));

async function writeManifestFromConfig() {
  const template = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  template.name = storeConfig.extension.name;
  template.description = storeConfig.extension.description;
  template.host_permissions = [...storeConfig.site.hostnames.map((hostname) => `https://${hostname}/*`), 'http://localhost:8787/*'];
  template.action = {
    ...(template.action || {}),
    default_title: storeConfig.extension.defaultTitle,
  };
  template.content_security_policy = {
    ...(template.content_security_policy || {}),
    extension_pages: `script-src 'self'; object-src 'self'; img-src 'self' ${storeConfig.extension.cspImageHosts.join(' ')} data:; style-src 'self'`,
  };
  await writeFile(path.join(dist, 'manifest.json'), JSON.stringify(template, null, 2));
}

async function copyStaticFiles() {
  await mkdir(dist, { recursive: true });
  await Promise.all([
    cp(path.join(root, 'popup.html'), path.join(dist, 'popup.html')),
    cp(path.join(root, 'mic-setup.html'), path.join(dist, 'mic-setup.html')),
    cp(path.join(root, 'src/styles.css'), path.join(dist, 'popup.css')),
  ]);
  await writeManifestFromConfig();
}

await rm(dist, { recursive: true, force: true });
await copyStaticFiles();

const options = {
  entryPoints: {
    background: path.join(root, 'src/background.ts'),
    popup: path.join(root, 'src/popup.ts'),
    'mic-setup': path.join(root, 'src/mic-setup.ts'),
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
    restorePageScroll: path.join(root, 'src/content/restore-page-scroll.ts'),
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
  console.log(`Watching ${storeConfig.brandName} extension sources...`);
} else {
  await Promise.all([build(options), build(contentScriptOptions)]);
}
