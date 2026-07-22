import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultDbPath = path.join(scriptDir, '..', 'data', 'resham.db');

const dbPath = path.resolve(process.cwd(), process.argv[2] ?? defaultDbPath);
const limit = Number.parseInt(process.argv[3] ?? '10', 10);

// This is a completeness proxy for classification quality, not a ground-truth
// accuracy score. The columns are chosen to reflect fields that carry product
// meaning or downstream classification value, while excluding IDs, crawl
// bookkeeping, and embedding metadata that would artificially inflate scores.
const scoredColumns = [
  'title',
  'description_html',
  'description_text',
  'category',
  'product_family',
  'vendor',
  'shopify_tags',
  'tags',
  'department',
  'occasion',
  'colors',
  'sizes',
  'color_images',
  'min_price',
  'max_price',
  'currency',
  'primary_image_url',
  'secondary_image_url',
  'product_url',
  'in_stock',
  'vision_category',
  'vision_colors',
  'text_derived_color',
  'product_tradition',
  'product_formality',
];

function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

function presenceExpr(column) {
  const ident = `p.${quoteIdent(column)}`;
  return `CASE
    WHEN ${ident} IS NULL THEN 0
    WHEN typeof(${ident}) = 'text' AND trim(${ident}) = '' THEN 0
    WHEN typeof(${ident}) = 'text' AND trim(${ident}) IN ('[]', '{}', 'null') THEN 0
    ELSE 1
  END`;
}

const db = new DatabaseSync(dbPath, { readOnly: true });

try {
  const existingColumns = new Set(
    db.prepare(`PRAGMA table_info(${quoteIdent('products')})`).all().map((row) => row.name),
  );
  const missingColumns = scoredColumns.filter((column) => !existingColumns.has(column));
  if (missingColumns.length > 0) {
    throw new Error(`products table is missing expected columns: ${missingColumns.join(', ')}`);
  }

  const selectParts = scoredColumns.map((column) => {
    const expr = presenceExpr(column);
    return `AVG(${expr}) AS ${quoteIdent(`${column}_pct`)}`;
  });

  const sumExpr = scoredColumns.map(presenceExpr).join(' + ');
  const totalPossiblePerRow = scoredColumns.length;

  const sql = `
    SELECT
      b.name AS brand_name,
      b.slug AS brand_slug,
      b.department AS brand_department,
      COUNT(*) AS product_count,
      AVG((${sumExpr}) * 1.0 / ${totalPossiblePerRow}) AS completeness_pct,
      ${selectParts.join(',\n      ')}
    FROM products p
    JOIN brands b ON b.id = p.brand_id
    GROUP BY b.id, b.name, b.slug, b.department
    HAVING COUNT(*) > 0
    ORDER BY completeness_pct DESC, product_count DESC, brand_name ASC
    LIMIT ?
  `;

  const rows = db.prepare(sql).all(limit);
  const results = rows.map((row, index) => ({
    rank: index + 1,
    brand: row.brand_name,
    slug: row.brand_slug,
    department: row.brand_department,
    productCount: row.product_count,
    completenessPct: Number((row.completeness_pct * 100).toFixed(2)),
    strongestColumns: scoredColumns
      .map((column) => ({
        column,
        pct: Number((row[`${column}_pct`] * 100).toFixed(2)),
      }))
      .sort((a, b) => b.pct - a.pct || a.column.localeCompare(b.column))
      .slice(0, 5),
    weakestColumns: scoredColumns
      .map((column) => ({
        column,
        pct: Number((row[`${column}_pct`] * 100).toFixed(2)),
      }))
      .sort((a, b) => a.pct - b.pct || a.column.localeCompare(b.column))
      .slice(0, 5),
  }));

  console.log(JSON.stringify({
    dbPath,
    metric: 'classification-oriented product completeness',
    scoredColumns,
    results,
  }, null, 2));
} finally {
  db.close();
}
