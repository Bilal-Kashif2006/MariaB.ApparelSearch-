import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitError } from 'groq-sdk';
import { describeSearchFailure, extractIntent, GeminiRateLimitError, planShoppingTurn } from '../src/intent.js';

function geminiResponse(text: string) {
  return {
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
    text: async () => '',
  };
}

// Stands in for Gemini's generateContent endpoint. Each call to
// complete() (intent.ts) becomes one fetch call here, in order.
function fakeGemini(replies: string[]) {
  const fetchMock = vi.fn();
  for (const reply of replies) {
    fetchMock.mockResolvedValueOnce(geminiResponse(reply));
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, callIndex: number) {
  return JSON.parse(fetchMock.mock.calls[callIndex][1].body as string);
}

beforeEach(() => {
  process.env.GEMINI_API_KEY = 'test-key';
  vi.unstubAllGlobals();
});

describe('extractIntent', () => {
  it('parses a valid JSON reply on the first try', async () => {
    // Arrange
    const fetchMock = fakeGemini([
      JSON.stringify({ collection: 'casual', color: 'green', priceMax: 5000 }),
    ]);

    // Act
    const intent = await extractIntent('green casual suit under 5000');

    // Assert
    expect(intent).toEqual({ collection: 'casual', color: 'green', priceMax: 5000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once with a correction prompt when the first reply is invalid JSON', async () => {
    // Arrange
    const fetchMock = fakeGemini([
      'not json at all',
      JSON.stringify({ color: 'red' }),
    ]);

    // Act
    const intent = await extractIntent('red something');

    // Assert
    expect(intent).toEqual({ color: 'red' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the original transcript in context on the retry call, not just the correction', async () => {
    // Arrange — regression test: an earlier version rebuilt the message
    // array from scratch per attempt, so the retry call never re-sent the
    // shopper's actual request, only "here's what you said wrong".
    const fetchMock = fakeGemini(['not json at all', JSON.stringify({ color: 'red' })]);

    // Act
    await extractIntent('red something under budget');

    // Assert
    const retryContents = requestBody(fetchMock, 1).contents as Array<{ role: string; parts: Array<{ text: string }> }>;
    expect(
      retryContents.some((c) => c.role === 'user' && c.parts.some((p) => p.text.includes('red something under budget'))),
    ).toBe(true);
    expect(retryContents.some((c) => c.role === 'model' && c.parts.some((p) => p.text === 'not json at all'))).toBe(
      true,
    );
  });

  it('throws after the retry also fails to produce valid JSON', async () => {
    // Arrange
    fakeGemini(['nope', 'still nope']);

    // Act & Assert
    await expect(extractIntent('anything')).rejects.toThrow(/unparseable/);
  });

  it('throws when the reply is valid JSON but does not match the schema', async () => {
    // Arrange — priceMax must be a number, not a string
    fakeGemini([
      JSON.stringify({ priceMax: 'five thousand' }),
      JSON.stringify({ priceMax: 'still a string' }),
    ]);

    // Act & Assert
    await expect(extractIntent('something under five thousand')).rejects.toThrow(/unparseable/);
  });
});

describe('planShoppingTurn', () => {
  it('returns a clarification decision rather than inventing products for a broad request', async () => {
    fakeGemini([
      JSON.stringify({
        action: 'clarify',
        searchScope: 'new',
        question: 'What occasion is it for?',
        intent: {},
      }),
    ]);

    await expect(planShoppingTurn('I need something nice', 'user: I need something nice')).resolves.toEqual({
      action: 'clarify',
      searchScope: 'new',
      question: 'What occasion is it for?',
      intent: {},
    });
  });

  it('keeps conversational context available when planning a follow-up', async () => {
    const fetchMock = fakeGemini([
      JSON.stringify({
        action: 'search',
        searchScope: 'refine',
        question: null,
        intent: { collection: 'formal', color: 'green' },
      }),
    ]);

    await planShoppingTurn('green instead', 'user: I need a formal outfit\nassistant: Which colour do you prefer?');

    const prompt = requestBody(fetchMock, 0).contents[0].parts[0].text;
    expect(prompt).toContain('I need a formal outfit');
    expect(prompt).toContain('green instead');
  });

  it('defaults an older planner reply without searchScope to a safe new search', async () => {
    fakeGemini([JSON.stringify({ action: 'search', question: null, intent: { occasion: 'eid' } })]);

    await expect(planShoppingTurn('show Eid outfits', '')).resolves.toMatchObject({
      action: 'search',
      searchScope: 'new',
      intent: { occasion: 'eid' },
    });
  });

  it('gives the planner the real Bareeze niche and verified category scope', async () => {
    const fetchMock = fakeGemini([
      JSON.stringify({ action: 'search', searchScope: 'new', question: null, intent: { occasion: 'eid' } }),
    ]);

    await planShoppingTurn('I need something for Eid', '');

    const systemPrompt = requestBody(fetchMock, 0).systemInstruction.parts[0].text;
    expect(systemPrompt).toContain("Pakistani women's fashion");
    expect(systemPrompt).toContain('casuals, formals, pret, prints, shawls');
    expect(systemPrompt).toContain("children's or menswear");
  });
});

describe('describeSearchFailure', () => {
  it('returns the fallback for a non-rate-limit error', () => {
    expect(describeSearchFailure(new Error('boom'), 'fallback message')).toBe('fallback message');
  });

  it('reports a minute-based wait time from a Groq rate limit error retry-after header', () => {
    const error = new RateLimitError(429, { error: { message: 'rate limited' } }, 'rate limited', new Headers({ 'retry-after': '683' }));

    expect(describeSearchFailure(error, 'fallback message')).toBe('Daily search limit reached. Try again in about 12 minutes.');
  });

  it('rounds a sub-minute Groq retry-after up to 1 minute rather than 0', () => {
    const error = new RateLimitError(429, { error: { message: 'rate limited' } }, 'rate limited', new Headers({ 'retry-after': '30' }));

    expect(describeSearchFailure(error, 'fallback message')).toBe('Daily search limit reached. Try again in about 1 minute.');
  });

  it('falls back to a generic wait message when no retry-after header is present', () => {
    const error = new RateLimitError(429, { error: { message: 'rate limited' } }, 'rate limited', new Headers());

    expect(describeSearchFailure(error, 'fallback message')).toBe('Daily search limit reached. Try again in a few minutes.');
  });

  it('reports a minute-based wait time from a Gemini rate limit error', () => {
    const error = new GeminiRateLimitError('rate limited', 683);

    expect(describeSearchFailure(error, 'fallback message')).toBe('Daily search limit reached. Try again in about 12 minutes.');
  });

  it('falls back to a generic wait message when Gemini gives no retry delay', () => {
    const error = new GeminiRateLimitError('rate limited', null);

    expect(describeSearchFailure(error, 'fallback message')).toBe('Daily search limit reached. Try again in a few minutes.');
  });
});
