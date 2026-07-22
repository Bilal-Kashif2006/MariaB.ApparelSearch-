import Groq, { RateLimitError } from 'groq-sdk';
import { ConversationPlanSchema, RawIntentSchema, type ConversationPlan, type RawIntent } from './schema.js';
import { STORE_CONFIG } from '../../src/shared/store.js';

const GROQ_MODEL = process.env.GROQ_INTENT_MODEL || 'llama-3.3-70b-versatile';
const GEMINI_MODEL = process.env.GEMINI_INTENT_MODEL || 'gemini-2.5-flash';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// Enabled by default while diagnosing model/provider issues. Set
// VERBOSE_LLM_LOGS=false once the proxy is behaving normally.
const VERBOSE_LLM_LOGS = process.env.VERBOSE_LLM_LOGS !== 'false';
const MAX_LOGGED_MODEL_OUTPUT = 20_000;

function logModel(event: string, details: Record<string, unknown>): void {
  if (!VERBOSE_LLM_LOGS) return;
  console.error(`[llm] ${event}`, details);
}

function modelOutputForLog(raw: string): string {
  return raw.length > MAX_LOGGED_MODEL_OUTPUT
    ? `${raw.slice(0, MAX_LOGGED_MODEL_OUTPUT)}\n...[truncated]`
    : raw;
}

const SUPPORTED_COLLECTIONS = STORE_CONFIG.server.supportedCollections.join(', ');
const SUPPORTED_FABRICS = STORE_CONFIG.server.supportedFabrics.join(', ');

const SYSTEM_PROMPT = `You are a shopping-intent extractor for ${STORE_CONFIG.brandName}, a Pakistani women's fashion brand.

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
- collection: the broad product line, e.g. ${SUPPORTED_COLLECTIONS}.
- fabric: the material, e.g. ${SUPPORTED_FABRICS}.
- color: any named color, in the shopper's own words (e.g. "hara", "sabz", "green" are all valid — do not translate or normalize it yourself).
- type: a construction/finish descriptor, e.g. embroidered.
- pieceCount: how many pieces in the suit, e.g. "2 piece", "3 piece".
- occasion: the event/context the shopper is dressing for, in their own words (e.g. "wedding", "eid", "office", "party", "everyday") — do not force it into any fixed list yourself.
- priceMax: an upper budget in PKR if the shopper names one (e.g. "under 5000" -> 5000). Do not guess a number if none was stated.

Rules:
- Only include a field if the shopper actually said something relevant to it. Use null for anything not mentioned or unclear.
- Do not invent, translate, or normalize values — return them close to how the shopper said them; a separate system handles matching them to the store's exact catalog terms.
- Return ONLY the JSON object. No prose, no markdown fences.`;

const PLANNER_SYSTEM_PROMPT = `You are ${STORE_CONFIG.brandName}'s specialist shopping assistant for Pakistani women's fashion. Decide the next useful action for a real shopper, using the conversation context and newest message.

Your verified local ${STORE_CONFIG.brandName} catalogue covers ${STORE_CONFIG.server.catalogScopeLabel}, including ${SUPPORTED_COLLECTIONS}. Its verified fabric families include ${SUPPORTED_FABRICS}. It can filter or rank by collection, fabric, color, embroidered/printed/dyed style, piece count, occasion, and maximum PKR budget.

Treat this as a fashion consultation, not a generic keyword search:
- Understand natural needs such as Eid, office wear, wedding guest, party, daily wear, winter dressing, gifting, a desired colour, a fabric, or a budget.
- A clear occasion alone is enough to search; do not interrogate a shopper for every possible field.
- For a broad need, ask the ONE decision-making question that will materially improve a ${STORE_CONFIG.brandName} recommendation. Prefer occasion first, then budget or colour only if the occasion is already clear.
- Use prior messages to resolve follow-ups such as "cheaper", "less formal", "same in green", "for my mother", or "something like the second one".
- If the newest shopper message answers your previous clarification question, convert that answer into a "search" and carry forward the earlier described item details into intent. Do not ask the same occasion/style question again after the shopper has already answered it.
- Generic chat, greetings, and vague requests should receive a concise, warm clarification—not products.

The local catalogue used for this assistant is scoped to ${STORE_CONFIG.server.catalogScopeLabel}. Do not turn childrenswear or menswear requests into unrelated women's products. Be direct about the scope and offer the closest useful next step. Do not invent product facts, availability, categories, sizing advice, or customer details.

Return ONLY one of these JSON objects:

For a searchable request:
{
  "action": "search",
  "searchScope": "new" | "refine",
  "question": null,
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

For a clarification:
{
  "action": "clarify",
  "searchScope": null,
  "question": string,
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

For an unsupported request:
{
  "action": "unsupported",
  "searchScope": null,
  "question": string,
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
- Use "search" when the shopper has given at least one usable ${STORE_CONFIG.brandName} shopping facet or is refining an existing search. Extract every facet stated or implied by the conversation.
- Set "searchScope" to "new" when this is a new shopping goal, a newly named occasion, or an answer to a clarification that replaces the earlier need. "new" discards old filters. Set it to "refine" only when the shopper explicitly adjusts the current result set, such as "cheaper", "green instead", "same style", or "more formal".
- Use "clarify" when the request is too broad to search responsibly. Ask exactly ONE short, specific question that would most improve the result. Do not ask a checklist of questions.
- Use "unsupported" only when the request needs a catalogue category ${STORE_CONFIG.brandName} does not offer in this assistant's verified catalogue scope, such as children's or menswear. Explain briefly and offer the nearest helpful next step without recommending unrelated products.
- For "clarify" and "unsupported", set "searchScope" to null.
- The shopper may use English, Urdu, or Roman Urdu. Preserve their wording in intent values; another system normalizes them.
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
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Shopper's request: ${transcript}` },
  ];

  const raw = await complete(messages, 'extract-intent:first');
  const parsed = tryParse(raw);
  if (parsed) return parsed;
  logModel('invalid extract-intent response', { attempt: 1, output: modelOutputForLog(raw) });

  messages.push({ role: 'assistant', content: raw });
  messages.push({
    role: 'user',
    content: 'That was not valid JSON matching the required shape. Reply with ONLY the corrected JSON object, no prose.',
  });

  const retryRaw = await complete(messages, 'extract-intent:retry');
  const retryParsed = tryParse(retryRaw);
  if (retryParsed) return retryParsed;
  logModel('invalid extract-intent response', { attempt: 2, output: modelOutputForLog(retryRaw) });

  throw new Error('Gemini returned an unparseable/invalid intent response after one retry.');
}

export async function planShoppingTurn(transcript: string, history: string): Promise<ConversationPlan> {
  const messages: ChatMessage[] = [
    { role: 'system', content: PLANNER_SYSTEM_PROMPT },
    { role: 'user', content: `Conversation context:\n${history || '(none)'}\n\nNewest shopper message: ${transcript}` },
  ];

  const raw = await complete(messages, 'planner:first');
  const parsed = tryParsePlan(raw);
  if (parsed) return parsed;
  logModel('invalid planner response', { attempt: 1, output: modelOutputForLog(raw) });

  messages.push({ role: 'assistant', content: raw });
  messages.push({ role: 'user', content: 'That was not valid JSON matching the required shape. Reply with ONLY the corrected JSON object.' });

  const retryRaw = await complete(messages, 'planner:retry');
  const retryParsed = tryParsePlan(retryRaw);
  if (retryParsed) return retryParsed;
  logModel('invalid planner response', { attempt: 2, output: modelOutputForLog(retryRaw) });
  throw new Error('Gemini returned an unparseable/invalid shopping plan after one retry.');
}

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
};

async function complete(messages: ChatMessage[], requestLabel: string): Promise<string> {
  const groqApiKey = process.env.GROQ_API_KEY;
  const geminiApiKey = process.env.GEMINI_API_KEY;

  if (groqApiKey) {
    try {
      return await completeViaGroq(groqApiKey, messages, requestLabel);
    } catch (error) {
      logModel('provider failed', {
        provider: 'groq',
        request: requestLabel,
        model: GROQ_MODEL,
        error: error instanceof Error ? { name: error.name, message: error.message } : error,
      });
      if (!geminiApiKey) throw error;
    }
  }

  if (!geminiApiKey) {
    throw new Error('No planner API key is configured. Set GROQ_API_KEY (preferred) or GEMINI_API_KEY.');
  }

  return completeViaGemini(geminiApiKey, messages, requestLabel);
}

async function completeViaGroq(apiKey: string, messages: ChatMessage[], requestLabel: string): Promise<string> {
  const client = new Groq({ apiKey });
  try {
    const response = await client.chat.completions.create({
      model: GROQ_MODEL,
      response_format: { type: 'json_object' },
      temperature: 0.2,
      messages,
    });

    const raw = response.choices[0]?.message?.content ?? '';
    logModel('response', {
      provider: 'groq',
      request: requestLabel,
      model: GROQ_MODEL,
      finishReason: response.choices[0]?.finish_reason,
      usage: response.usage,
      output: modelOutputForLog(raw),
    });
    return raw;
  } catch (error) {
    logModel('request failed', {
      provider: 'groq',
      request: requestLabel,
      model: GROQ_MODEL,
      error: error instanceof Error ? { name: error.name, message: error.message } : error,
    });
    throw error;
  }
}

async function completeViaGemini(apiKey: string, messages: ChatMessage[], requestLabel: string): Promise<string> {
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

  try {
    const response = await fetch(`${GEMINI_ENDPOINT}/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      logModel('request failed', {
        provider: 'gemini',
        request: requestLabel,
        model: GEMINI_MODEL,
        status: response.status,
        body: modelOutputForLog(bodyText),
      });
      if (response.status === 429) {
        throw new GeminiRateLimitError(`Gemini rate limit: ${bodyText}`, parseRetryDelaySeconds(bodyText));
      }
      throw new Error(`Gemini request failed (${response.status}): ${bodyText}`);
    }

    const data = (await response.json()) as GeminiResponse;
    const raw = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
    logModel('response', {
      provider: 'gemini',
      request: requestLabel,
      model: GEMINI_MODEL,
      output: modelOutputForLog(raw),
    });
    return raw;
  } catch (error) {
    logModel('request failed', {
      provider: 'gemini',
      request: requestLabel,
      model: GEMINI_MODEL,
      error: error instanceof Error ? { name: error.name, message: error.message } : error,
    });
    throw error;
  }
}

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
  } catch (error) {
    logModel('extract-intent validation failure', {
      error: error instanceof Error ? error.message : error,
    });
    return null;
  }
}

function tryParsePlan(raw: string): ConversationPlan | null {
  try {
    const value = JSON.parse(raw) as unknown;
    const planned = ConversationPlanSchema.safeParse(value);
    if (planned.success) return planned.data;

    const intentOnly = RawIntentSchema.safeParse(value);
    if (intentOnly.success && Object.keys(intentOnly.data).length > 0) {
      return { action: 'search', searchScope: 'new', question: null, intent: intentOnly.data };
    }

    if (value && typeof value === 'object' && 'intent' in value) {
      const nestedIntent = RawIntentSchema.safeParse((value as { intent: unknown }).intent);
      if (nestedIntent.success) {
        const hasFacet = Object.keys(nestedIntent.data).length > 0;
        if (hasFacet) {
          return {
            action: 'search',
            searchScope: 'new',
            question: null,
            intent: nestedIntent.data,
          };
        }
        return {
          action: 'clarify',
          searchScope: null,
          question: 'What occasion or style are you shopping for?',
          intent: nestedIntent.data,
        };
      }
    }

    logModel('planner validation failure', { error: 'Planner JSON did not match any accepted schema.' });
    return null;
  } catch (error) {
    logModel('planner validation failure', {
      error: error instanceof Error ? error.message : error,
    });
    return null;
  }
}
