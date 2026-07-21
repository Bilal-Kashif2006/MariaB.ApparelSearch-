import Groq from 'groq-sdk';
import { RawIntentSchema, type RawIntent } from './schema.js';

const INTENT_MODEL = process.env.GROQ_INTENT_MODEL || 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = `You are a shopping-intent extractor for Bareeze, a Pakistani women's clothing brand.

Given a shopper's spoken or typed request (which may be in English, Urdu, or Roman Urdu), extract these fields as a single JSON object:

{
  "collection": string | null,
  "fabric": string | null,
  "color": string | null,
  "type": string | null,
  "pieceCount": string | null,
  "occasion": string | null,
  "priceMax": number | null
}

Field meanings:
- collection: the broad product line, e.g. casual, formal, shawl, new arrivals, sale, pret, prints.
- fabric: the material, e.g. lawn, khaddar, velvet, chiffon, organza, net, cotton, cambric, karandi.
- color: any named color, in the shopper's own words (e.g. "hara", "sabz", "green" are all valid — do not translate or normalize it yourself).
- type: a construction/finish descriptor, e.g. embroidered.
- pieceCount: how many pieces in the suit, e.g. "2 piece", "3 piece".
- occasion: the event/context the shopper is dressing for, in their own words (e.g. "wedding", "eid", "office", "party", "everyday") — do not force it into any fixed list yourself.
- priceMax: an upper budget in PKR if the shopper names one (e.g. "under 5000" -> 5000). Do not guess a number if none was stated.

Rules:
- Only include a field if the shopper actually said something relevant to it. Use null for anything not mentioned or unclear.
- Do not invent, translate, or normalize values — return them close to how the shopper said them; a separate system handles matching them to the store's exact catalog terms.
- Return ONLY the JSON object. No prose, no markdown fences.`;

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export async function extractIntent(client: Groq, transcript: string): Promise<RawIntent> {
  // Kept as a real, growing message history (rather than a fresh two-message
  // exchange per attempt) so a retry never loses the shopper's actual
  // request — only the *first* reply is discarded, replaced by the
  // correction instruction, while the original transcript stays in context.
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Shopper's request: ${transcript}` },
  ];

  const raw = await complete(client, messages);
  const parsed = tryParse(raw);
  if (parsed) return parsed;

  messages.push({ role: 'assistant', content: raw });
  messages.push({
    role: 'user',
    content: 'That was not valid JSON matching the required shape. Reply with ONLY the corrected JSON object, no prose.',
  });
  const retryRaw = await complete(client, messages);
  const retryParsed = tryParse(retryRaw);
  if (retryParsed) return retryParsed;

  throw new Error('Groq returned an unparseable/invalid intent response after one retry.');
}

async function complete(client: Groq, messages: ChatMessage[]): Promise<string> {
  const response = await client.chat.completions.create({
    model: INTENT_MODEL,
    response_format: { type: 'json_object' },
    temperature: 0.2,
    messages,
  });
  return response.choices[0]?.message?.content ?? '';
}

function tryParse(raw: string): RawIntent | null {
  try {
    return RawIntentSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
