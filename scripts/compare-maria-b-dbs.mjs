import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
function resolveInputPath(value, fallback) {
  if (!value) return fallback;
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

const importedPath = resolveInputPath(process.argv[2], path.join(repoRoot, 'data', 'maria-b.db'));
const scrapedPath = resolveInputPath(process.argv[3], path.join(repoRoot, 'data', 'maria-b-scraped.db'));

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

function count(db, sql, ...args) {
  return db.prepare(sql).get(...args).n;
}

function coverage(db, table, columns) {
  const total = count(db, `SELECT COUNT(*) AS n FROM ${table}`);
  const result = {};
  for (const column of columns) {
    const populated = count(
      db,
      `SELECT COUNT(*) AS n
       FROM ${table}
       WHERE ${column} IS NOT NULL
         AND CAST(${column} AS TEXT) <> ''
         AND CAST(${column} AS TEXT) <> '[]'
         AND CAST(${column} AS TEXT) <> '{}'`,
    );
    result[column] = {
      populated,
      total,
      ratio: total === 0 ? 0 : populated / total,
    };
  }
  return result;
}

function topCoverage(coverageMap, limit = 12) {
  return Object.entries(coverageMap)
    .sort((a, b) => b[1].ratio - a[1].ratio)
    .slice(0, limit)
    .map(([column, stats]) => ({ column, ...stats }));
}

const importedDb = new DatabaseSync(importedPath, { readOnly: true });
const scrapedDb = new DatabaseSync(scrapedPath, { readOnly: true });

try {
  const importedProducts = columnNames(importedDb, 'products');
  const scrapedProducts = columnNames(scrapedDb, 'products');
  const importedVariants = columnNames(importedDb, 'product_variants');
  const scrapedVariants = columnNames(scrapedDb, 'product_variants');

  const productOnlyImported = importedProducts.filter((name) => !scrapedProducts.includes(name));
  const productOnlyScraped = scrapedProducts.filter((name) => !importedProducts.includes(name));
  const variantOnlyImported = importedVariants.filter((name) => !scrapedVariants.includes(name));
  const variantOnlyScraped = scrapedVariants.filter((name) => !importedVariants.includes(name));

  const importedCoverage = coverage(importedDb, 'products', importedProducts);
  const scrapedCoverage = coverage(scrapedDb, 'products', scrapedProducts);

  console.log(JSON.stringify({
    importedPath,
    scrapedPath,
    counts: {
      importedProducts: count(importedDb, 'SELECT COUNT(*) AS n FROM products'),
      scrapedProducts: count(scrapedDb, 'SELECT COUNT(*) AS n FROM products'),
      importedVariants: count(importedDb, 'SELECT COUNT(*) AS n FROM product_variants'),
      scrapedVariants: count(scrapedDb, 'SELECT COUNT(*) AS n FROM product_variants'),
    },
    schemaDiff: {
      products: {
        onlyImported: productOnlyImported,
        onlyScraped: productOnlyScraped,
      },
      productVariants: {
        onlyImported: variantOnlyImported,
        onlyScraped: variantOnlyScraped,
      },
    },
    topCoverage: {
      importedProducts: topCoverage(importedCoverage),
      scrapedProducts: topCoverage(scrapedCoverage),
    },
    usefulImportedOnlyColumns: [
      'brand_id',
      'composite_key',
      'description_text',
      'product_family',
      'department',
      'is_kids',
      'age_ranges_months',
      'occasion',
      'color_images',
      'content_hash',
      'embedding_model_version',
      'embedded_at',
      'removed_at',
      'missing_streak',
      'vision_category',
      'vision_colors',
      'vision_classified_at',
      'text_derived_color',
      'product_tradition',
      'product_formality',
    ].filter((column) => productOnlyImported.includes(column)),
    usefulScrapedOnlyColumns: ['scraped_at'].filter((column) => productOnlyScraped.includes(column)),
  }, null, 2));
} finally {
  importedDb.close();
  scrapedDb.close();
}
