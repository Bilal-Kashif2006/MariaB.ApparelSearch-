import { DatabaseSync } from 'node:sqlite';

export type ReviewStatus = 'accepted' | 'needs-llm-review' | 'needs-recheck' | 'unclassified';

/**
 * Keeps the catalogue classification table backwards-compatible while adding
 * the audit fields needed for a defensible recommendation system.
 */
export function ensureClassificationSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_occasion (
      product_slug TEXT PRIMARY KEY,
      occasion TEXT NOT NULL,
      classified_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'llm',
      confidence REAL,
      review_status TEXT NOT NULL DEFAULT 'needs-llm-review',
      reason TEXT,
      evidence_json TEXT,
      reviewer_confidence REAL,
      reviewer_reason TEXT,
      reviewed_at TEXT
    );
  `);

  const columns = new Set(
    (db.prepare('PRAGMA table_info(product_occasion)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  const additions: Array<[string, string]> = [
    ['source', "TEXT NOT NULL DEFAULT 'llm'"],
    ['confidence', 'REAL'],
    ['review_status', "TEXT NOT NULL DEFAULT 'needs-llm-review'"],
    ['reason', 'TEXT'],
    ['evidence_json', 'TEXT'],
    ['reviewer_confidence', 'REAL'],
    ['reviewer_reason', 'TEXT'],
    ['reviewed_at', 'TEXT'],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE product_occasion ADD COLUMN ${name} ${definition};`);
  }
}
