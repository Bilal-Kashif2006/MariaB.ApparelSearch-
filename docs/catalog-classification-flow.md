# Bareeze Catalogue Classification and Confidence Policy

## Purpose

This is the quality-control process behind the Bareeze Shopping Assistant’s occasion recommendations. It supports useful requests such as “something for Eid”, “a modest office look”, or “an evening outfit” without presenting an AI guess as an official Bareeze product fact.

Bareeze remains the authority for the live product, price, availability, size, bag, and checkout. The assistant adds a carefully-audited discovery layer.

## Current Catalogue Audit

The local catalogue snapshot contains **871 products**. The confidence audit uses real scraped Bareeze catalogue attributes, not invented descriptions.

| Confidence band | Products | Handling |
|---|---:|---|
| High: `>= 0.80` | 616 | Accepted automatically with saved evidence |
| Medium: `0.60–0.79` | 174 | Sent to LLM classification and independent review |
| Low: `< 0.60` | 81 | Sent to LLM classification and independent review; never treated as certain |
| Already marked `unclassified` | 4 | Excluded from occasion-specific matching |
| Total LLM review queue | 251 | Only these products use LLM review |

The high-confidence group includes **9 products verified directly against a Bareeze collection**. The remaining products are scored by deterministic rules or an LLM review whose evidence is retained with the result.

Regenerate the exact audit at any time:

```bash
node --experimental-strip-types scripts/classify-occasion-rules.ts
node --experimental-strip-types scripts/audit-classification-confidence.ts
```

The second command creates `data/classification-audit.json`, a local report listing every queued product and the reason it needs review.

## The Classification Flow

```text
Live Bareeze product data
title · collection · season · fabric · colour · type · piece count · price
                                  |
                                  v
                    Deterministic evidence rules
                       | high confidence     | uncertain / conflicting
                       v                     v
                  Accept with audit       LLM classifier
                  trail                   (strict JSON only)
                                                  |
                              >= 0.80 and supported evidence? -- yes --> Accept
                                                  |
                                                  no
                                                  v
                                  Independent LLM reviewer
                                                  |
                       +--------------------------+-------------------------+
                       |                            |                         |
                       v                            v                         v
                >= 0.80 accept            0.60–0.79 needs recheck     < 0.60 / weak
                                                                        evidence: unclassified
```

### Stage 1 — Deterministic scoring

The first stage uses only real catalogue signals. Strong examples are:

- `Season` containing `EID` → `festive-eid`, confidence `0.98`.
- `Season` containing `WINTER` → `winter-wear`, confidence `0.96`.
- A Bareeze collection verified as Eid → `festive-eid`, confidence `0.99`.
- Net fabric and a formal embroidered product are useful but less certain occasion signals and are scored accordingly.
- A generic “New In” product with no meaningful type or fabric signal is only `0.45`; it is deliberately queued for review, not claimed as a confident casual recommendation.

Rules are ordered from strongest to weakest. A verified Bareeze collection is never overwritten by a rule or an LLM.

### Stage 2 — LLM classifier

Only medium- and low-confidence products are sent to the LLM. The model sees the product’s actual title, subtitle, categories, and attribute values. It must return strict JSON:

```json
{
  "occasion": "festive-eid",
  "confidence": 0.84,
  "reason": "Eid season tag and embroidered formal type"
}
```

It may return `unclassified`. A weak signal is never silently converted into a confident “daily casual” or “bridal” claim.

### Stage 3 — Independent LLM review

If the first LLM has confidence below `0.80`, or returns `unclassified`, a separate reviewer receives the original catalogue data and challenges the first result rather than merely repeating it.

```json
{
  "occasion": "party-evening",
  "confidence": 0.82,
  "decision": "change",
  "reason": "Net fabric is the strongest available signal"
}
```

The reviewer can return `confirm`, `change`, or `insufficient-evidence`.

## Acceptance Policy

| Result | Stored status | Assistant behaviour |
|---|---|---|
| Verified or deterministic result `>= 0.80` | `accepted` | May be used for matching and ranking |
| First LLM result `>= 0.80` | `accepted` | May be used, with LLM provenance |
| Reviewer result `>= 0.80` | `accepted` | May be used, with reviewer provenance |
| Reviewer result `0.60–0.79` | `needs-recheck` | Kept for audit; not a certain occasion match |
| Reviewer `< 0.60` or insufficient evidence | `unclassified` | Excluded from occasion-specific matching |

## Audit Record for Every Product

Each `product_occasion` record now stores:

```text
product_slug
occasion
confidence
source                     rule-based | verified-collection | llm | llm-review
review_status              accepted | needs-llm-review | needs-recheck | unclassified
reason
evidence_json
reviewer_confidence
reviewer_reason
classified_at
reviewed_at
```

This makes every recommendation explainable and re-evaluable after a catalogue refresh. It also shows management exactly how many items are uncertain instead of implying every label is equally reliable.

## Operational Process

1. Refresh the live catalogue and its genuine filters.
2. Run deterministic classification and the audit report.
3. Run the LLM reviewer only for the generated queue:

   ```bash
   node --experimental-strip-types --env-file=server/.env scripts/classify-occasion.ts
   ```

4. Re-run the audit. Accepted products are available to occasion matching; uncertain products remain explicitly marked.
5. Repeat after each catalogue refresh. Preserve the evidence trail and never overwrite verified Bareeze data with a weaker inference.

## Why Image Classification Is Not Required Initially

Structured Bareeze data already identifies most of the catalogue. Image review can later support ambiguous cases—such as embroidery density, silhouette, or minimal versus statement styling—but it never replaces the live Bareeze page for product facts, availability, or purchase decisions.
