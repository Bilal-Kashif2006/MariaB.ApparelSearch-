// Phase 2 of the catalog build: tags each product already in the database
// (from scrape-catalog.ts) with its real Bareeze attributes — Color,
// Fabric, Type, Season, Size(piece-count) — sourced from each collection's
// own actual filter-drawer checkboxes, not a hardcoded/assumed vocabulary.
// Different collections expose different values (e.g. velvet/chiffon show
// up as Fabric options on formals but not casuals), so the drawer is read
// fresh per collection rather than reused.
//
// Run with: node --experimental-strip-types scripts/tag-attributes.ts
//
// Must not run concurrently with scrape-catalog.ts against the same
// database file (node:sqlite's DatabaseSync isn't safe for concurrent
// writers from two processes) — run this after the base crawl finishes.
import { chromium, type Page } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'bareeze-catalog.db');
const SCROLL_PAUSE_MS = 900;
const VALUE_PAUSE_MS = 600; // between attribute-value requests within a collection
const COLLECTION_PAUSE_MS = 2000;
const MAX_SCROLLS_PER_VALUE = 40; // filtered subsets are small — this is a generous cap, not an expected depth

// All real product-bearing pages from the base crawl (scrape-catalog.ts's
// CATEGORY_PATHS). An earlier version of this list only covered the 5 main
// collections, assuming the fabric-specific pages (/fabric/lawn etc.) and
// new-in/prints/embroidered were subsets with no products of their own —
// wrong for 209/871 products that were *only* ever discovered via one of
// these pages and so never got attribute-tagged at all. Re-crawling a page
// whose products are already tagged is harmless (INSERT OR IGNORE below).
const COLLECTIONS: Record<string, string> = {
  casuals: '/casuals',
  formals: '/formals',
  shawls: '/shawls',
  sale: '/sale',
  pret: '/bareeze-pret',
  'new in': '/new-in',
  prints: '/prints/view-all',
  lawn: '/fabric/lawn',
  khaddar: '/fabric/khaddar',
  velvet: '/fabric/velvet',
  chiffon: '/fabric/chiffon',
  organza: '/fabric/organza',
  net: '/fabric/net',
  cotton: '/fabric/cotton',
  cambric: '/fabric/cambric',
  karandi: '/fabric/karandi',
};

function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_attributes (
      product_slug TEXT NOT NULL,
      attribute_type TEXT NOT NULL,
      attribute_value TEXT NOT NULL,
      PRIMARY KEY (product_slug, attribute_type, attribute_value)
    );
  `);
  return db;
}

interface AttributeGroup {
  name: string; // e.g. "Color", "Fabric", "Type", "Season", "Size"
  values: string[];
}

async function discoverAttributeGroups(page: Page, basePath: string): Promise<AttributeGroup[]> {
  await page.goto(`https://www.bareeze.com${basePath}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.locator('text=Filter').first().click({ timeout: 10000 });
  await page.waitForTimeout(1000);

  const groups = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="checkbox"], input[type="radio"]'));
    const byName = new Map<string, Set<string>>();
    for (const el of inputs as HTMLInputElement[]) {
      const name = el.name;
      // "Category" is the drawer's own navigational sub-tab grouping
      // (view-all/by-season/by-piece/...), not a real product attribute.
      if (!name || name === 'Category') continue;
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name)!.add(el.value);
    }
    return Array.from(byName.entries()).map(([name, values]) => ({ name, values: Array.from(values) }));
  });

  return groups;
}

async function scrapeSlugsForAttributeValue(page: Page, basePath: string, attributeName: string, attributeValue: string): Promise<string[]> {
  const url = `https://www.bareeze.com${basePath}?attribute_name=${encodeURIComponent(attributeName)}&attribute_value=${encodeURIComponent(attributeValue)}&sort=newest`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

  let previousUnique = -1;
  let stableStreak = 0;
  for (let i = 0; i < MAX_SCROLLS_PER_VALUE; i++) {
    const uniqueCount = await page.evaluate(() => new Set(Array.from(document.querySelectorAll('.singleProductCardContainer a[href]')).map((a) => a.getAttribute('href'))).size);
    if (uniqueCount === previousUnique) {
      stableStreak++;
      if (stableStreak >= 2) break;
    } else {
      stableStreak = 0;
    }
    previousUnique = uniqueCount;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(SCROLL_PAUSE_MS);
  }

  return page.evaluate(() => {
    const slugs = new Set<string>();
    document.querySelectorAll('.singleProductCardContainer a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      const slug = href.replace(/^\//, '').split('?')[0];
      if (slug) slugs.add(slug);
    });
    return Array.from(slugs);
  });
}

async function main() {
  const db = openDatabase();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const insertTag = db.prepare(
    'INSERT OR IGNORE INTO product_attributes (product_slug, attribute_type, attribute_value) VALUES (?, ?, ?)',
  );
  const knownSlug = db.prepare('SELECT 1 FROM products WHERE slug = ?');

  let totalTagsInserted = 0;

  for (const [collectionKey, basePath] of Object.entries(COLLECTIONS)) {
    console.log(`\n=== ${collectionKey} (${basePath}) ===`);
    let groups: AttributeGroup[];
    try {
      groups = await discoverAttributeGroups(page, basePath);
    } catch (error) {
      console.log(`  FAILED to open filter drawer: ${(error as Error).message}`);
      continue;
    }
    console.log(`  Discovered ${groups.length} attribute groups: ${groups.map((g) => `${g.name}(${g.values.length})`).join(', ')}`);

    for (const group of groups) {
      for (const value of group.values) {
        try {
          const slugs = await scrapeSlugsForAttributeValue(page, basePath, group.name, value);
          let newlyTagged = 0;
          for (const slug of slugs) {
            if (!knownSlug.get(slug)) continue; // only tag products the base crawl already knows about
            const result = insertTag.run(slug, group.name, value);
            if (result.changes > 0) newlyTagged++;
          }
          totalTagsInserted += newlyTagged;
          console.log(`  ${group.name}=${value}: ${slugs.length} products (${newlyTagged} new tags)`);
        } catch (error) {
          console.log(`  ${group.name}=${value}: FAILED (${(error as Error).message})`);
        }
        await page.waitForTimeout(VALUE_PAUSE_MS);
      }
    }
    await page.waitForTimeout(COLLECTION_PAUSE_MS);
  }

  await browser.close();
  console.log(`\nDone. ${totalTagsInserted} attribute tags inserted.`);
  db.close();
}

await main();
