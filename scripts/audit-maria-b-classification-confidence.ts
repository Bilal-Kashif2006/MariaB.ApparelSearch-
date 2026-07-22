import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureClassificationSchema } from './classification-storage.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(ROOT, 'data', 'maria-b.db');

const db = new DatabaseSync(DB_PATH);
ensureClassificationSchema(db);

const totalProducts = (db.prepare('SELECT COUNT(*) AS count FROM products').get() as { count: number }).count;
const classifiedProducts = (db.prepare('SELECT COUNT(*) AS count FROM product_occasion').get() as { count: number }).count;
const confidenceBuckets = [
  { range: 'high (>= 0.80)', products: (db.prepare('SELECT COUNT(*) AS count FROM product_occasion WHERE confidence >= 0.80').get() as { count: number }).count },
  { range: 'medium (0.60–0.79)', products: (db.prepare('SELECT COUNT(*) AS count FROM product_occasion WHERE confidence >= 0.60 AND confidence < 0.80').get() as { count: number }).count },
  { range: 'low (< 0.60)', products: (db.prepare('SELECT COUNT(*) AS count FROM product_occasion WHERE confidence < 0.60').get() as { count: number }).count },
  { range: 'not yet scored', products: (db.prepare('SELECT COUNT(*) AS count FROM product_occasion WHERE confidence IS NULL').get() as { count: number }).count },
];
const statusBreakdown = db.prepare(
  'SELECT review_status, COUNT(*) AS products FROM product_occasion GROUP BY review_status ORDER BY products DESC',
).all();
const sourceBreakdown = db.prepare(
  'SELECT source, COUNT(*) AS products FROM product_occasion GROUP BY source ORDER BY products DESC',
).all();
const occasionBreakdown = db.prepare(
  'SELECT occasion, review_status, COUNT(*) AS products FROM product_occasion GROUP BY occasion, review_status ORDER BY occasion, review_status',
).all();

console.log(JSON.stringify({
  totalProducts,
  classifiedProducts,
  confidenceBuckets,
  statusBreakdown,
  sourceBreakdown,
  occasionBreakdown,
}, null, 2));

db.close();
