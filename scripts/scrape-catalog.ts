// One-off catalog crawler — separate from the live extension, which keeps
// scraping on-demand exactly as before. This exists to build a local
// database of the full real Bareeze catalog so search can later match
// against real product data instead of only Bareeze's own coarse filter
// combinations.
//
// Run with: node --experimental-strip-types scripts/scrape-catalog.ts
//
// Politeness: one page at a time (no concurrency), a pause between scroll
// steps to let content load naturally rather than hammering the site, and a
// pause between categories. A full crawl is expected to take a while — that
// tradeoff is intentional.
import { chromium } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORY_PATHS } from '../src/shared/contracts.ts';

const DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'bareeze-catalog.db');
const SCROLL_PAUSE_MS = 900;
const CATEGORY_PAUSE_MS = 1500;
const MAX_SCROLLS_PER_CATEGORY = 150; // safety valve — 150 * ~16 cards is far beyond any real category size

function uniqueCategoryPaths(): Map<string, string[]> {
  const byPath = new Map<string, string[]>();
  for (const [key, categoryPath] of Object.entries(CATEGORY_PATHS)) {
    const keys = byPath.get(categoryPath) ?? [];
    keys.push(key);
    byPath.set(categoryPath, keys);
  }
  return byPath;
}

function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      slug TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      subtitle TEXT,
      price TEXT,
      image_url TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_categories (
      product_slug TEXT NOT NULL REFERENCES products(slug),
      category_key TEXT NOT NULL,
      PRIMARY KEY (product_slug, category_key)
    );
  `);
  return db;
}

interface ScrapedCard {
  slug: string;
  title: string;
  subtitle: string | null;
  price: string;
  imageUrl: string | null;
}

function upsertProduct(db: DatabaseSync, card: ScrapedCard, categoryKeys: string[]): boolean {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT slug FROM products WHERE slug = ?').get(card.slug);
  if (existing) {
    db.prepare(
      'UPDATE products SET title = ?, subtitle = ?, price = ?, image_url = ?, last_seen_at = ? WHERE slug = ?',
    ).run(card.title, card.subtitle, card.price, card.imageUrl, now, card.slug);
  } else {
    db.prepare(
      'INSERT INTO products (slug, title, subtitle, price, image_url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(card.slug, card.title, card.subtitle, card.price, card.imageUrl, now, now);
  }
  for (const key of categoryKeys) {
    db.prepare('INSERT OR IGNORE INTO product_categories (product_slug, category_key) VALUES (?, ?)').run(
      card.slug,
      key,
    );
  }
  return !existing;
}

function readCards(): ScrapedCard[] {
  const cards: ScrapedCard[] = [];
  document.querySelectorAll('.singleProductCardContainer').forEach((container) => {
    const link = container.querySelector('a[href]');
    const titleEl = container.querySelector('.singleProductCardProductTitle');
    const subtitleEl = container.querySelector('.singleProductCardProductSubTitle');
    const priceEl = container.querySelector('.singleProductCardActualPrice');
    const imgEl = container.querySelector('img') as HTMLImageElement | null;
    if (!link || !titleEl) return;
    const href = link.getAttribute('href') || '';
    const slug = href.replace(/^\//, '').split('?')[0];
    if (!slug) return;
    cards.push({
      slug,
      title: titleEl.textContent?.trim() || '',
      subtitle: subtitleEl?.textContent?.trim() || null,
      price: priceEl?.textContent?.trim() || '',
      imageUrl: imgEl?.src || null,
    });
  });
  return cards;
}

function dedupeBySlug(cards: ScrapedCard[]): ScrapedCard[] {
  const bySlug = new Map<string, ScrapedCard>();
  for (const card of cards) bySlug.set(card.slug, card);
  return [...bySlug.values()];
}

async function scrapeCategory(page: import('@playwright/test').Page, categoryPath: string): Promise<ScrapedCard[]> {
  await page.goto(`https://www.bareeze.com${categoryPath}`, { waitUntil: 'networkidle', timeout: 30000 });

  // Plateau on *unique slug count*, not raw DOM node count: some categories
  // keep appending padding/repeated cards past their real end rather than
  // stopping cleanly, which raw element counts can't distinguish from
  // genuine new content. Two consecutive stable reads (not just one) guards
  // against a single transient stall being mistaken for the real end.
  let previousUnique = -1;
  let stableStreak = 0;
  for (let i = 0; i < MAX_SCROLLS_PER_CATEGORY; i++) {
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

  const cards = await page.evaluate(readCards);
  return dedupeBySlug(cards);
}

async function main() {
  const db = openDatabase();
  const categories = uniqueCategoryPaths();
  console.log(`Crawling ${categories.size} unique category/fabric pages...`);

  const browser = await chromium.launch();
  const page = await browser.newPage();

  let totalNew = 0;
  let totalSeen = 0;
  let categoryIndex = 0;

  for (const [categoryPath, keys] of categories) {
    categoryIndex++;
    process.stdout.write(`[${categoryIndex}/${categories.size}] ${categoryPath} (${keys.join(', ')})... `);
    try {
      const cards = await scrapeCategory(page, categoryPath);
      let newCount = 0;
      for (const card of cards) {
        const isNew = upsertProduct(db, card, keys);
        if (isNew) newCount++;
      }
      totalNew += newCount;
      totalSeen += cards.length;
      console.log(`${cards.length} products (${newCount} new)`);
    } catch (error) {
      console.log(`FAILED: ${(error as Error).message}`);
    }
    await page.waitForTimeout(CATEGORY_PAUSE_MS);
  }

  await browser.close();

  const totalUnique = (db.prepare('SELECT COUNT(*) as n FROM products').get() as { n: number }).n;
  console.log(`\nDone. ${totalSeen} product listings seen across all categories, ${totalNew} new this run, ${totalUnique} unique products total in ${DB_PATH}.`);
  db.close();
}

await main();
