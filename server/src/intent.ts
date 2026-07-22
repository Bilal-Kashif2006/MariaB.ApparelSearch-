import { RateLimitError } from 'groq-sdk';
import { ConversationPlanSchema, RawIntentSchema, type ConversationPlan, type RawIntent } from './schema.js';

// Text/JSON planning runs on Gemini, not Groq — Groq's Whisper transcription
// (transcribe.ts) is a separate rate-limit bucket and stays on Groq. Voice
// search still calls into this module after transcription, so both text and
// voice search share this Gemini path.
const GEMINI_MODEL = process.env.GEMINI_INTENT_MODEL || 'gemini-2.5-flash';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

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

const PLANNER_SYSTEM_PROMPT = `You are Bareeze's specialist shopping assistant for Pakistani women's fashion. Decide the next useful action for a real shopper, using the conversation context and newest message.

Your verified local Bareeze catalogue covers women's casuals, formals, pret, prints, shawls, new arrivals and sale. Its verified fabric families include lawn, khaddar, velvet, chiffon, organza, net, cotton, cambric and karandi. It can filter or rank by collection, fabric, color, embroidered/printed style, piece count, occasion, and maximum PKR budget.

Treat this as a fashion consultation, not a generic keyword search:
- Understand natural needs such as Eid, office wear, wedding guest, party, daily wear, winter dressing, gifting, a desired colour, a fabric, or a budget.
- A clear occasion alone is enough to search; do not interrogate a shopper for every possible field.
- For a broad need, ask the ONE decision-making question that will materially improve a Bareeze recommendation. Prefer occasion first, then budget or colour only if the occasion is already clear.
- Use prior messages to resolve follow-ups such as "cheaper", "less formal", "same in green", "for my mother", or "something like the second one".
- Generic chat, greetings, and vague requests should receive a concise, warm clarification—not products.

The local catalogue has no verified children's or menswear collection. Do not turn those requests into unrelated women's products. Be direct about the scope and offer the closest useful next step. Do not invent product facts, availability, categories, sizing advice, or customer details.

Return ONLY this JSON object:
{
  "action": "search" | "clarify" | "unsupported",
  "searchScope": "new" | "refine",
  "question": string | null,
  "intent": {
    "collection": string | null,
    "fabric": string | null,
    "color": string | null,
    "type": string | null,
    "pieceCount": string | null,
    "occasion": string | null,
    "priceMax": number | null
  }
}

Decision rules:
- Use "search" when the shopper has given at least one usable Bareeze shopping facet or is refining an existing search. Extract every facet stated or implied by the conversation.
- Set "searchScope" to "new" when this is a new shopping goal, a newly named occasion, or an answer to a clarification that replaces the earlier need. "new" discards old filters. Set it to "refine" only when the shopper explicitly adjusts the current result set, such as "cheaper", "green instead", "same style", or "more formal".
- Use "clarify" when the request is too broad to search responsibly. Ask exactly ONE short, specific question that would most improve the result. Do not ask a checklist of questions.
- Use "unsupported" only when the request needs a catalogue category Bareeze does not offer or cannot verify, such as children's or menswear. Explain briefly and offer the nearest helpful next step without recommending unrelated products.
- The shopper may use English, Urdu, or Roman Urdu. You are responsible for correcting obvious typos, spelling variants, and Roman Urdu transliterations before returning intent. Do not return a misspelled token when you can confidently normalize it (for example, normalize a misspelled wedding occasion or fabric to its common term), but never infer a facet the shopper did not mention.
- Never use "search" with an empty intent. Never produce product recommendations or prose outside question.`;

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

// Thrown by complete() when Gemini responds 429 (RESOURCE_EXHAUSTED). Mirrors
// groq-sdk's RateLimitError shape closely enough that describeSearchFailure
// can format both the same way.
export class GeminiRateLimitError extends Error {
  readonly retryDelaySeconds: number | null;
  constructor(message: string, retryDelaySeconds: number | null) {
    super(message);
    this.name = 'GeminiRateLimitError';
    this.retryDelaySeconds = retryDelaySeconds;
  }
}

export async function extractIntent(transcript: string): Promise<RawIntent> {
  // Kept as a real, growing message history (rather than a fresh two-message
  // exchange per attempt) so a retry never loses the shopper's actual
  // request — only the *first* reply is discarded, replaced by the
  // correction instruction, while the original transcript stays in context.
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Shopper's request: ${transcript}` },
  ];

  const raw = await complete(messages);
  const parsed = tryParse(raw);
  if (parsed) return parsed;

  messages.push({ role: 'assistant', content: raw });
  messages.push({
    role: 'user',
    content: 'That was not valid JSON matching the required shape. Reply with ONLY the corrected JSON object, no prose.',
  });
  const retryRaw = await complete(messages);
  const retryParsed = tryParse(retryRaw);
  if (retryParsed) return retryParsed;

  throw new Error('Gemini returned an unparseable/invalid intent response after one retry.');
}

export async function planShoppingTurn(transcript: string, history: string): Promise<ConversationPlan> {
  const messages: ChatMessage[] = [
    { role: 'system', content: PLANNER_SYSTEM_PROMPT },
    { role: 'user', content: `Conversation context:\n${history || '(none)'}\n\nNewest shopper message: ${transcript}` },
  ];
  const raw = await complete(messages);
  const parsed = tryParsePlan(raw);
  if (parsed) return parsed;

  messages.push({ role: 'assistant', content: raw });
  messages.push({ role: 'user', content: 'That was not valid JSON matching the required shape. Reply with ONLY the corrected JSON object.' });
  const retryRaw = await complete(messages);
  const retryParsed = tryParsePlan(retryRaw);
  if (retryParsed) return retryParsed;
  throw new Error('Gemini returned an unparseable/invalid shopping plan after one retry.');
}

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
};

async function complete(messages: ChatMessage[]): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set.');
  }

  // Gemini has no "system"/"assistant" roles in `contents` — system prompts
  // travel in a separate top-level field, and prior assistant turns become
  // role "model".
  const systemInstruction = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const contents = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    }));

  const response = await fetch(`${GEMINI_ENDPOINT}/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents,
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
        // Thinking tokens would otherwise slow down a plain JSON-extraction
        // call for no benefit here.
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    if (response.status === 429) {
      throw new GeminiRateLimitError(`Gemini rate limit: ${bodyText}`, parseRetryDelaySeconds(bodyText));
    }
    throw new Error(`Gemini request failed (${response.status}): ${bodyText}`);
  }

  const data = (await response.json()) as GeminiResponse;
  return data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
}

// Gemini's 429 body embeds a google.rpc.RetryInfo detail like
// {"@type":"...RetryInfo","retryDelay":"31s"} — pull the numeric seconds out
// of that string rather than parsing the whole protobuf-JSON shape.
function parseRetryDelaySeconds(bodyText: string): number | null {
  const match = bodyText.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return match ? Number(match[1]) : null;
}

function formatWaitMessage(seconds: number | null): string {
  if (seconds && seconds > 0) {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return `Daily search limit reached. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  }
  return 'Daily search limit reached. Try again in a few minutes.';
}

// Both providers can rate-limit a request: Groq's Whisper transcription
// (transcribe.ts) and Gemini's JSON planning (complete(), above). Without
// this, either one surfaces as an opaque "temporarily unavailable" — see
// server/src/index.ts's route handlers for where this wraps the real cause.
export function describeSearchFailure(error: unknown, fallback: string): string {
  if (error instanceof RateLimitError) {
    return formatWaitMessage(Number(error.headers?.get('retry-after')) || null);
  }
  if (error instanceof GeminiRateLimitError) {
    return formatWaitMessage(error.retryDelaySeconds);
  }
  return fallback;
}

function tryParse(raw: string): RawIntent | null {
  try {
    return RawIntentSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function tryParsePlan(raw: string): ConversationPlan | null {
  try {
    const value = JSON.parse(raw) as unknown;
    const planned = ConversationPlanSchema.safeParse(value);
    if (planned.success) return planned.data;

    // Graceful compatibility with a model that follows the older intent-only
    // contract despite being asked for a plan. A usable facet is enough to
    // search; an empty object remains a clarification, never random picks.
    const intentOnly = RawIntentSchema.safeParse(value);
    if (intentOnly.success && Object.keys(intentOnly.data).length > 0) {
      return { action: 'search', searchScope: 'new', question: null, intent: intentOnly.data };
    }
    if (value && typeof value === 'object' && 'intent' in value) {
      const nestedIntent = RawIntentSchema.safeParse((value as { intent: unknown }).intent);
      if (nestedIntent.success) {
        const hasFacet = Object.keys(nestedIntent.data).length > 0;
        return {
          action: hasFacet ? 'search' : 'clarify',
          searchScope: 'new',
          question: hasFacet ? null : 'What occasion or style are you shopping for?',
          intent: nestedIntent.data,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}
