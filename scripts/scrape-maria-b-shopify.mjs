import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(scriptDir, '..');
const defaultOutputPath = path.join(repoRoot, 'data', 'maria-b-scraped.db');
const sourceArgv = process.argv.slice(2);

function readFlag(name) {
  const prefixed = `--${name}=`;
  const exactIndex = sourceArgv.findIndex((arg) => arg === `--${name}`);
  if (exactIndex >= 0) return sourceArgv[exactIndex + 1] ?? '';
  const inline = sourceArgv.find((arg) => arg.startsWith(prefixed));
  return inline ? inline.slice(prefixed.length) : '';
}

const outputPath = path.resolve(process.cwd(), readFlag('output') || defaultOutputPath);
const snapshotDbPath = readFlag('snapshot-db')
  ? path.resolve(process.cwd(), readFlag('snapshot-db'))
  : '';
const baseUrl = readFlag('base-url') || 'https://mariab.pk';
const limit = Math.min(250, Math.max(1, Number(readFlag('limit') || '250')));

function removeIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}

function cleanupSqliteSidecars(dbPath) {
  removeIfExists(`${dbPath}-shm`);
  removeIfExists(`${dbPath}-wal`);
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stripHtml(html) {
  return normalizeText(String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}

function parseTags(rawTags) {
  if (Array.isArray(rawTags)) return rawTags.map(String);
  if (typeof rawTags === 'string') {
    return rawTags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  return [];
}

function collectOptionValues(product, optionName) {
  const option = Array.isArray(product.options)
    ? product.options.find((entry) => normalizeText(entry?.name).toLowerCase() === optionName)
    : null;
  if (!option || !Array.isArray(option.values)) return [];
  return option.values.map(String).filter(Boolean);
}

function collectVariantValues(variants, key) {
  return [...new Set(
    (Array.isArray(variants) ? variants : [])
      .map((variant) => normalizeText(variant?.[key]))
      .filter(Boolean),
  )];
}

function availableVariants(variants) {
  return (Array.isArray(variants) ? variants : []).filter((variant) => Boolean(variant?.available));
}

function priceNumber(raw) {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function createSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS scrape_runs (
      id TEXT PRIMARY KEY,
      source_mode TEXT NOT NULL,
      base_url TEXT,
      source_snapshot_db TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      product_count INTEGER,
      variant_count INTEGER
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      external_id TEXT,
      handle TEXT,
      title TEXT,
      description_html TEXT,
      description_text TEXT,
      category TEXT,
      vendor TEXT,
      tags TEXT,
      colors TEXT,
      sizes TEXT,
      min_price REAL,
      max_price REAL,
      currency TEXT,
      primary_image_url TEXT,
      secondary_image_url TEXT,
      product_url TEXT,
      in_stock INTEGER,
      created_at TEXT,
      updated_at TEXT,
      raw_shopify_json TEXT NOT NULL,
      scraped_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_variants (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      external_variant_id TEXT,
      color TEXT,
      size TEXT,
      price REAL,
      compare_at_price REAL,
      available INTEGER,
      image_url TEXT,
      sku TEXT,
      created_at TEXT,
      updated_at TEXT,
      scraped_at TEXT NOT NULL
    );
  `);
}

function upsertProduct(db, runId, product, scrapedAt, sourceMode, originLabel) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const tags = parseTags(product.tags);
  const colors = collectVariantValues(variants, 'option2').length
    ? collectVariantValues(variants, 'option2')
    : collectOptionValues(product, 'color');
  const sizes = collectVariantValues(variants, 'option1').length
    ? collectVariantValues(variants, 'option1')
    : collectOptionValues(product, 'size');
  const prices = variants.map((variant) => priceNumber(variant.price)).filter((value) => value != null);
  const images = Array.isArray(product.images) ? product.images : [];
  const availableCount = availableVariants(variants).length;

  db.prepare(`
    INSERT OR REPLACE INTO products (
      id, external_id, handle, title, description_html, description_text, category, vendor, tags,
      colors, sizes, min_price, max_price, currency, primary_image_url, secondary_image_url,
      product_url, in_stock, created_at, updated_at, raw_shopify_json, scraped_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `scraped:${product.id}`,
    String(product.id),
    normalizeText(product.handle),
    normalizeText(product.title),
    typeof product.body_html === 'string' ? product.body_html : '',
    stripHtml(product.body_html),
    normalizeText(product.product_type),
    normalizeText(product.vendor),
    JSON.stringify(tags),
    JSON.stringify(colors),
    JSON.stringify(sizes),
    prices.length ? Math.min(...prices) : null,
    prices.length ? Math.max(...prices) : null,
    'PKR',
    normalizeText(images[0]?.src),
    normalizeText(images[1]?.src),
    `${baseUrl.replace(/\/$/, '')}/products/${normalizeText(product.handle)}`,
    availableCount > 0 ? 1 : 0,
    normalizeText(product.created_at),
    normalizeText(product.updated_at),
    JSON.stringify({
      ...product,
      _scrape_source_mode: sourceMode,
      _scrape_origin: originLabel,
      _scrape_run_id: runId,
    }),
    scrapedAt,
  );

  const deleteVariants = db.prepare('DELETE FROM product_variants WHERE product_id = ?');
  deleteVariants.run(`scraped:${product.id}`);

  const insertVariant = db.prepare(`
    INSERT INTO product_variants (
      id, product_id, external_variant_id, color, size, price, compare_at_price,
      available, image_url, sku, created_at, updated_at, scraped_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const variant of variants) {
    insertVariant.run(
      `scraped-variant:${variant.id}`,
      `scraped:${product.id}`,
      String(variant.id),
      normalizeText(variant.option2),
      normalizeText(variant.option1),
      priceNumber(variant.price),
      priceNumber(variant.compare_at_price),
      variant.available ? 1 : 0,
      normalizeText(variant.featured_image?.src || ''),
      normalizeText(variant.sku),
      normalizeText(variant.created_at),
      normalizeText(variant.updated_at),
      scrapedAt,
    );
  }
}

async function fetchProductsPage(page) {
  const url = `${baseUrl.replace(/\/$/, '')}/products.json?limit=${limit}&page=${page}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; MariaB-Catalog-Scraper/1.0)',
      Accept: 'application/json,text/plain,*/*',
    },
  });
  if (!response.ok) {
    throw new Error(`Fetch failed for page ${page}: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const products = Array.isArray(payload?.products) ? payload.products : [];
  return { products, url };
}

function* snapshotProducts(db) {
  const rows = db.prepare(`
    SELECT raw_shopify_json
    FROM products
    WHERE raw_shopify_json IS NOT NULL
      AND trim(raw_shopify_json) <> ''
    ORDER BY id
  `).all();
  for (const row of rows) {
    try {
      yield JSON.parse(row.raw_shopify_json);
    } catch {}
  }
}

async function loadProducts() {
  if (snapshotDbPath) {
    const db = new DatabaseSync(snapshotDbPath, { readOnly: true });
    try {
      const products = [...snapshotProducts(db)];
      return {
        sourceMode: 'snapshot-db',
        originLabel: snapshotDbPath,
        products,
      };
    } finally {
      db.close();
    }
  }

  const products = [];
  let page = 1;
  while (true) {
    const result = await fetchProductsPage(page);
    if (result.products.length === 0) break;
    products.push(...result.products);
    if (result.products.length < limit) break;
    page += 1;
  }

  return {
    sourceMode: 'live-shopify',
    originLabel: baseUrl,
    products,
  };
}

async function main() {
  const tempOutput = `${outputPath}.next`;
  cleanupSqliteSidecars(tempOutput);
  removeIfExists(tempOutput);

  const runId = `scrape-run:${new Date().toISOString()}`;
  const startedAt = new Date().toISOString();
  const { sourceMode, originLabel, products } = await loadProducts();

  const db = new DatabaseSync(tempOutput);
  try {
    createSchema(db);
    db.exec('BEGIN');
    db.prepare(`
      INSERT INTO scrape_runs (id, source_mode, base_url, source_snapshot_db, started_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, sourceMode, sourceMode === 'live-shopify' ? baseUrl : null, sourceMode === 'snapshot-db' ? snapshotDbPath : null, startedAt);

    db.exec('DELETE FROM products');
    db.exec('DELETE FROM product_variants');

    const scrapedAt = new Date().toISOString();
    let variantCount = 0;
    for (const product of products) {
      upsertProduct(db, runId, product, scrapedAt, sourceMode, originLabel);
      variantCount += Array.isArray(product.variants) ? product.variants.length : 0;
    }

    db.prepare(`
      UPDATE scrape_runs
      SET finished_at = ?, product_count = ?, variant_count = ?
      WHERE id = ?
    `).run(new Date().toISOString(), products.length, variantCount, runId);

    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  } finally {
    db.close();
  }

  cleanupSqliteSidecars(outputPath);
  removeIfExists(outputPath);
  fs.renameSync(tempOutput, outputPath);
  cleanupSqliteSidecars(tempOutput);

  console.log(JSON.stringify({
    outputPath,
    sourceMode,
    originLabel,
    productCount: products.length,
    variantCount: products.reduce((sum, product) => sum + (Array.isArray(product.variants) ? product.variants.length : 0), 0),
  }, null, 2));
}

await main();
