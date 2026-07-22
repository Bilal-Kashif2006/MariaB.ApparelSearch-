// Produces an audit report without calling an LLM or changing classifications.
// Run after classify-occasion-rules.ts:
// node --experimental-strip-types scripts/audit-classification-confidence.ts
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureClassificationSchema } from './classification-storage.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(ROOT, 'data', 'bareeze-catalog.db');
const REPORT_PATH = path.join(ROOT, 'data', 'classification-audit.json');

interface Bucket { range: string; products: number; }

const db = new DatabaseSync(DB_PATH);
ensureClassificationSchema(db);

const total = (db.prepare('SELECT COUNT(*) AS count FROM products').get() as { count: number }).count;
const sourceBreakdown = db.prepare(
  'SELECT source, COUNT(*) AS products FROM product_occasion GROUP BY source ORDER BY products DESC',
).all();
const statusBreakdown = db.prepare(
  'SELECT review_status, COUNT(*) AS products FROM product_occasion GROUP BY review_status ORDER BY products DESC',
).all();
const occasionBreakdown = db.prepare(
  `SELECT occasion, review_status, COUNT(*) AS products
   FROM product_occasion GROUP BY occasion, review_status ORDER BY occasion, review_status`,
).all();
const confidenceBuckets: Bucket[] = [
  { range: 'high (>= 0.80)', products: (db.prepare('SELECT COUNT(*) AS count FROM product_occasion WHERE confidence >= 0.80').get() as { count: number }).count },
  { range: 'medium (0.60–0.79)', products: (db.prepare('SELECT COUNT(*) AS count FROM product_occasion WHERE confidence >= 0.60 AND confidence < 0.80').get() as { count: number }).count },
  { range: 'low (< 0.60)', products: (db.prepare('SELECT COUNT(*) AS count FROM product_occasion WHERE confidence < 0.60').get() as { count: number }).count },
  { range: 'not yet scored', products: (db.prepare('SELECT COUNT(*) AS count FROM product_occasion WHERE confidence IS NULL').get() as { count: number }).count },
];
const llmQueue = db.prepare(
  `SELECT p.slug, p.title, po.occasion, po.confidence, po.reason
   FROM product_occasion po JOIN products p ON p.slug = po.product_slug
   WHERE po.review_status = 'needs-llm-review' OR po.review_status = 'needs-recheck'
   ORDER BY po.confidence ASC, p.title ASC`,
).all();

const report = {
  generatedAt: new Date().toISOString(),
  totalProducts: total,
  classifiedProducts: (db.prepare('SELECT COUNT(*) AS count FROM product_occasion').get() as { count: number }).count,
  confidencePolicy: {
    high: '>= 0.80 — accepted unless a later catalogue refresh introduces contradictory facts',
    medium: '0.60–0.79 — queued for LLM classification and independent LLM review',
    low: '< 0.60 — queued for LLM classification and independent LLM review; never presented as certain',
  },
  sourceBreakdown,
  statusBreakdown,
  confidenceBuckets,
  occasionBreakdown,
  llmReviewQueue: llmQueue,
};

await import('node:fs/promises').then(({ writeFile }) => writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`));
console.log(JSON.stringify({ totalProducts: total, confidenceBuckets, statusBreakdown, llmReviewQueue: llmQueue.length, report: REPORT_PATH }, null, 2));
db.close();
