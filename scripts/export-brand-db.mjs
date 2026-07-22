import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sourceArg = process.argv[2] ?? path.join('data', 'resham.db');
const brandSlug = process.argv[3] ?? 'maria-b';
const outputArg = process.argv[4] ?? path.join('data', `${brandSlug}.db`);

const sourcePath = path.resolve(process.cwd(), sourceArg);
const outputPath = path.resolve(process.cwd(), outputArg);

function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

function tableSql(db, tableName) {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(tableName);
  if (!row?.sql) throw new Error(`Missing table schema for ${tableName}`);
  return row.sql;
}

function tableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all().map((row) => row.name);
}

function insertRows(targetDb, tableName, columns, rows) {
  if (rows.length === 0) return;
  const placeholders = columns.map(() => '?').join(', ');
  const insertSql = `INSERT INTO ${quoteIdent(tableName)} (${columns.map(quoteIdent).join(', ')}) VALUES (${placeholders})`;
  const insert = targetDb.prepare(insertSql);
  for (const row of rows) {
    insert.run(...columns.map((column) => row[column]));
  }
}

const sourceDb = new DatabaseSync(sourcePath, { readOnly: true });

try {
  const brand = sourceDb.prepare(
    `SELECT * FROM brands WHERE slug = ?`,
  ).get(brandSlug);
  if (!brand) throw new Error(`No brand found for slug "${brandSlug}" in ${sourcePath}`);

  const productRows = sourceDb.prepare(
    `SELECT * FROM products WHERE brand_id = ? ORDER BY id`,
  ).all(brand.id);

  const variantRows = sourceDb.prepare(
    `SELECT v.*
     FROM product_variants v
     JOIN products p ON p.id = v.product_id
     WHERE p.brand_id = ?
     ORDER BY v.id`,
  ).all(brand.id);

  const targetDb = new DatabaseSync(outputPath);
  try {
    targetDb.exec('PRAGMA journal_mode = WAL;');
    targetDb.exec('PRAGMA synchronous = NORMAL;');
    targetDb.exec('BEGIN');

    for (const tableName of ['brands', 'products', 'product_variants']) {
      targetDb.exec(`DROP TABLE IF EXISTS ${quoteIdent(tableName)}`);
      targetDb.exec(tableSql(sourceDb, tableName));
    }

    insertRows(targetDb, 'brands', tableColumns(sourceDb, 'brands'), [brand]);
    insertRows(targetDb, 'products', tableColumns(sourceDb, 'products'), productRows);
    insertRows(targetDb, 'product_variants', tableColumns(sourceDb, 'product_variants'), variantRows);

    targetDb.exec('COMMIT');
  } catch (error) {
    try {
      targetDb.exec('ROLLBACK');
    } catch {}
    throw error;
  } finally {
    targetDb.close();
  }

  console.log(JSON.stringify({
    sourcePath,
    outputPath,
    brand: {
      id: brand.id,
      name: brand.name,
      slug: brand.slug,
      department: brand.department,
    },
    counts: {
      brands: 1,
      products: productRows.length,
      product_variants: variantRows.length,
    },
  }, null, 2));
} finally {
  sourceDb.close();
}
