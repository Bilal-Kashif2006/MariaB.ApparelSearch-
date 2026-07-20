// Injected only on an explicit "Add to Bag" click from the popup. Bareeze
// has no public cart API (it isn't Shopify) — this clicks Bareeze's own
// real "Add To Bag" button so their own React app's cart logic runs
// exactly as it would for a human shopper. See README.md for the plan.
export {};
