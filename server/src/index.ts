import cors from 'cors';
import express from 'express';
import Groq from 'groq-sdk';
import type { ListingCard } from '../../src/shared/contracts';
import { canonicalizeForCatalog, isEmptyCatalogIntent, searchCatalog } from './catalog.js';
import { extractIntent } from './intent.js';
import type { RawIntent } from './schema.js';
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

// The catalog matches on every recognized facet at once, not just occasion
// — searchCatalog runs whenever the shopper's intent has anything for it to
// filter on. null products means "use the live intentToBareezeUrl path
// instead" (genuinely empty intent, or the local DB isn't reachable); []
// means "the catalog understood the request but has no match at all, not
// even a related one" — the two are deliberately not conflated so the
// popup never silently substitutes a broader live search for a specific
// request that came back empty. `relaxed: true` means products is a
// related/closest-match set, not an exact one — see searchCatalog.
async function resolveIntentAndProducts(
  transcriptOrText: string,
): Promise<{ intent: RawIntent; products: ListingCard[] | null; relaxed: boolean }> {
  const intent = await extractIntent(groq, transcriptOrText);
  const catalogIntent = canonicalizeForCatalog(intent);
  if (isEmptyCatalogIntent(catalogIntent)) {
    return { intent, products: null, relaxed: false };
  }
  try {
    const result = searchCatalog(catalogIntent);
    return { intent, products: result.products, relaxed: result.relaxed };
  } catch (error) {
    console.error('Local catalog search failed (was data/bareeze-catalog.db built?):', error);
    return { intent, products: null, relaxed: false };
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

    try {
      const transcript = await transcribeAudio(groq, audio, mimeType);
      if (!transcript.trim()) {
        res.status(422).json({ error: 'Could not make out anything in that recording. Try again.' });
        return;
      }
      const { intent, products, relaxed } = await resolveIntentAndProducts(transcript);
      res.json({ transcript, intent, products, relaxed });
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
  const text = (req.body as { text?: unknown } | undefined)?.text;
  if (typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'No search text received.' });
    return;
  }

  try {
    const { intent, products, relaxed } = await resolveIntentAndProducts(text);
    res.json({ intent, products, relaxed });
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
