// Ground-truths festive-eid occasion tagging against Bareeze's own real,
// curated Eid landing pages (/new-in/eid-1-summer-25, /new-in/eid-2-summer-25
// — discovered via the site's sitemap_cat_0.xml, not guessed) instead of
// relying solely on classify-occasion.ts's LLM inference. A cross-check
// found 24% of products with a real Season=EID-* attribute tag weren't
// classified festive-eid by the LLM — this gives a second, independent,
// zero-LLM-cost signal for the subset Bareeze itself curates as Eid.
//
// Run with: node --experimental-strip-types scripts/verify-eid-collection.ts
// Must not run concurrently with scrape-catalog.ts/tag-attributes.ts/
// classify-occasion.ts against the same database file.
import { chromium, type Page } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'bareeze-catalog.db');
const SCROLL_PAUSE_MS = 900;
const MAX_SCROLLS = 40;

// The only two real Eid collection pages live on the site right now
// (verified: no -summer-26 equivalent exists yet, checked live).
const EID_COLLECTION_PATHS = ['/new-in/eid-1-summer-25', '/new-in/eid-2-summer-25'];

function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH);
  // Distinguishes a verified real-collection tag from an LLM guess so
  // classify-occasion.ts's full-catalog re-runs never clobber it — see
  // that script's getAllProductsForClassification.
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_occasion (
      product_slug TEXT PRIMARY KEY,
      occasion TEXT NOT NULL,
      classified_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'llm'
    );
  `);
  const columns = db.prepare("PRAGMA table_info(product_occasion)").all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'source')) {
    db.exec(`ALTER TABLE product_occasion ADD COLUMN source TEXT NOT NULL DEFAULT 'llm';`);
  }
  return db;
}

async function scrapeSlugs(page: Page, urlPath: string): Promise<string[]> {
  await page.goto(`https://www.bareeze.com${urlPath}?sort=newest`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1200);

  let previousUnique = -1;
  let stableStreak = 0;
  for (let i = 0; i < MAX_SCROLLS; i++) {
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

  const knownSlug = db.prepare('SELECT 1 FROM products WHERE slug = ?');
  const previousOccasion = db.prepare('SELECT occasion FROM product_occasion WHERE product_slug = ?');
  const upsert = db.prepare(
    `INSERT INTO product_occasion (product_slug, occasion, classified_at, source)
     VALUES (?, 'festive-eid', ?, 'verified-collection')
     ON CONFLICT(product_slug) DO UPDATE SET occasion = 'festive-eid', classified_at = excluded.classified_at, source = 'verified-collection'`,
  );

  const allEidSlugs = new Set<string>();
  for (const urlPath of EID_COLLECTION_PATHS) {
    const slugs = await scrapeSlugs(page, urlPath);
    console.log(`${urlPath}: ${slugs.length} products`);
    for (const s of slugs) allEidSlugs.add(s);
  }

  const now = new Date().toISOString();
  let verified = 0;
  let corrected = 0;
  let notInCatalog = 0;
  for (const slug of allEidSlugs) {
    if (!knownSlug.get(slug)) {
      notInCatalog++;
      continue;
    }
    const prior = previousOccasion.get(slug) as { occasion: string } | undefined;
    if (prior && prior.occasion !== 'festive-eid') corrected++;
    upsert.run(slug, now);
    verified++;
  }

  console.log(`\n${allEidSlugs.size} distinct real Eid-collection products found.`);
  console.log(`${verified} matched to known catalog products and marked festive-eid (source=verified-collection).`);
  console.log(`${corrected} of those had a DIFFERENT occasion before this — corrected.`);
  console.log(`${notInCatalog} were not in the catalog at all (not yet crawled).`);

  await browser.close();
  db.close();
}

await main();
