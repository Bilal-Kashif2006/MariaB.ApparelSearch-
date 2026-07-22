import cors from 'cors';
import express from 'express';
import Groq from 'groq-sdk';
import type { ListingCard } from '../../src/shared/contracts';
import {
  canonicalizeForCatalog,
  dropNegatedFields,
  isEmptyCatalogIntent,
  mergeCatalogIntent,
  searchCatalog,
  type CatalogIntent,
} from './catalog.js';
import { extractIntent } from './intent.js';
import { CatalogIntentSchema, type RawIntent } from './schema.js';
import { transcribeAudio } from './transcribe.js';

const PORT = Number(process.env.PORT) || 8787;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB — generous for a short voice query

const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  throw new Error(
    'GROQ_API_KEY is not set. Copy server/.env.example to server/.env and add your Groq API key before starting the proxy.',
  );
}

const allowedOrigin = process.env.ALLOWED_EXTENSION_ORIGIN;
if (!allowedOrigin) {
  // Without this, any website open in the browser while this proxy is
  // running could POST audio to it and burn the developer's Groq quota —
  // fine for a first run before the extension's ID is known, but should be
  // locked down. See server/.env.example for how to find the ID.
  console.warn(
    'ALLOWED_EXTENSION_ORIGIN is not set — the proxy currently accepts requests from any origin. ' +
      'Set it to chrome-extension://<your-extension-id> (see chrome://extensions) to restrict this.',
  );
}

const groq = new Groq({ apiKey });
const app = express();

app.use(cors(allowedOrigin ? { origin: allowedOrigin } : {}));
app.use(express.json());
app.get('/health', (_req, res) => res.json({ ok: true }));

// Never lets a corrupted/stale client-stored previousIntent break the
// request — it's a context hint for merging, not something the request
// should fail over. Anything that doesn't validate is treated the same as
// "no previous turn" (a fresh search), not an error.
function parsePreviousIntent(raw: unknown): CatalogIntent | null {
  const parsed = CatalogIntentSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// The catalog matches on every recognized facet at once, not just occasion
// — searchCatalog runs whenever the shopper's intent has anything for it to
// filter on. null products means "use the live intentToBareezeUrl path
// instead" (genuinely empty intent, or the local DB isn't reachable); []
// means "the catalog understood the request but has no match at all, not
// even a related one" — the two are deliberately not conflated so the
// popup never silently substitutes a broader live search for a specific
// request that came back empty. `relaxed: true` means products is a
// related/closest-match set, not an exact one — see searchCatalog.
//
// previousIntent (the shopper's last resolved, canonical request, echoed
// back by the client) is what turns a follow-up like "cheaper" or "green
// instead" into a refinement rather than an unrelated fresh search — see
// mergeCatalogIntent in catalog.ts for how the two are combined, and
// dropNegatedFields for why the fresh turn is guarded before that merge.
// `canonicalIntent` in the response is the merged result: what the popup
// should display as the current filters AND echo back as previousIntent on
// the shopper's next message.
async function resolveIntentAndProducts(
  transcriptOrText: string,
  previousIntent: CatalogIntent | null,
): Promise<{
  intent: RawIntent;
  canonicalIntent: CatalogIntent;
  products: ListingCard[] | null;
  relaxed: boolean;
  priceRelaxRequested: boolean;
  priceRelaxApplied: boolean;
}> {
  const rawIntent = await extractIntent(groq, transcriptOrText);
  const { raw: guardedIntent, negatedFields } = dropNegatedFields(rawIntent, transcriptOrText);
  const freshCatalogIntent = canonicalizeForCatalog(guardedIntent);
  const { intent: canonicalIntent, priceRelaxRequested, priceRelaxApplied } = mergeCatalogIntent(
    previousIntent,
    freshCatalogIntent,
    transcriptOrText,
    negatedFields,
  );

  if (isEmptyCatalogIntent(canonicalIntent)) {
    return { intent: guardedIntent, canonicalIntent, products: null, relaxed: false, priceRelaxRequested, priceRelaxApplied };
  }
  try {
    const result = searchCatalog(canonicalIntent);
    return {
      intent: guardedIntent,
      canonicalIntent,
      products: result.products,
      relaxed: result.relaxed,
      priceRelaxRequested,
      priceRelaxApplied,
    };
  } catch (error) {
    console.error('Local catalog search failed (was data/bareeze-catalog.db built?):', error);
    return { intent: guardedIntent, canonicalIntent, products: null, relaxed: false, priceRelaxRequested, priceRelaxApplied };
  }
}

app.post(
  '/voice-intent',
  express.raw({ type: '*/*', limit: MAX_AUDIO_BYTES }),
  async (req, res) => {
    const audio = req.body as Buffer;
    if (!Buffer.isBuffer(audio) || audio.length === 0) {
      res.status(400).json({ error: 'No audio data received.' });
      return;
    }

    const mimeType = req.headers['content-type'] || 'audio/webm';
    // The body here is raw audio bytes (express.raw), not JSON — there's no
    // room for a previousIntent field in it, so it travels as a header
    // instead, URL-encoded JSON (a header value can't safely hold raw JSON
    // punctuation/whitespace).
    const previousIntentHeader = req.headers['x-previous-intent'];
    const previousIntent = parsePreviousIntent(
      typeof previousIntentHeader === 'string'
        ? (() => {
            try {
              return JSON.parse(decodeURIComponent(previousIntentHeader));
            } catch {
              return null;
            }
          })()
        : null,
    );

    try {
      const transcript = await transcribeAudio(groq, audio, mimeType);
      if (!transcript.trim()) {
        res.status(422).json({ error: 'Could not make out anything in that recording. Try again.' });
        return;
      }
      const { intent, canonicalIntent, products, relaxed, priceRelaxRequested, priceRelaxApplied } =
        await resolveIntentAndProducts(transcript, previousIntent);
      res.json({ transcript, intent, canonicalIntent, products, relaxed, priceRelaxRequested, priceRelaxApplied });
    } catch (error) {
      console.error('voice-intent request failed:', error);
      res.status(502).json({ error: 'Voice search is temporarily unavailable. Try typing your search instead.' });
    }
  },
);

// Typed-search counterpart to /voice-intent — same intent extraction +
// catalog-match pipeline, minus the transcription step, so typed queries get
// the same occasion-aware matching voice search does.
app.post('/text-intent', async (req, res) => {
  const body = req.body as { text?: unknown; previousIntent?: unknown } | undefined;
  const text = body?.text;
  if (typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'No search text received.' });
    return;
  }
  const previousIntent = parsePreviousIntent(body?.previousIntent);

  try {
    const { intent, canonicalIntent, products, relaxed, priceRelaxRequested, priceRelaxApplied } =
      await resolveIntentAndProducts(text, previousIntent);
    res.json({ intent, canonicalIntent, products, relaxed, priceRelaxRequested, priceRelaxApplied });
  } catch (error) {
    console.error('text-intent request failed:', error);
    res.status(502).json({ error: 'Smart search is temporarily unavailable. Try again.' });
  }
});

// Terminal error handler — catches anything that bypasses the route's own
// try/catch (e.g. express.raw()'s body-size limit rejecting an oversized
// request before the handler even runs). Without this, Express's default
// handler returns the raw error stack (including server file paths) to the
// caller whenever NODE_ENV isn't explicitly "production".
app.use((err: { status?: number; statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled request error:', err);
  res.status(err.status || err.statusCode || 500).json({ error: 'Bad request.' });
});

app.listen(PORT, () => {
  console.log(`Bareeze voice-intent proxy listening on http://localhost:${PORT}`);
});
