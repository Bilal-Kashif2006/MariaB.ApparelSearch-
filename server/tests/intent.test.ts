import { describe, expect, it, vi } from 'vitest';
import { extractIntent, planShoppingTurn } from '../src/intent.js';

function fakeClient(replies: string[]) {
  const create = vi.fn();
  for (const reply of replies) {
    create.mockResolvedValueOnce({ choices: [{ message: { content: reply } }] });
  }
  return { chat: { completions: { create } } } as any;
}

describe('extractIntent', () => {
  it('parses a valid JSON reply on the first try', async () => {
    // Arrange
    const client = fakeClient([
      JSON.stringify({ collection: 'casual', color: 'green', priceMax: 5000 }),
    ]);

    // Act
    const intent = await extractIntent(client, 'green casual suit under 5000');

    // Assert
    expect(intent).toEqual({ collection: 'casual', color: 'green', priceMax: 5000 });
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it('retries once with a correction prompt when the first reply is invalid JSON', async () => {
    // Arrange
    const client = fakeClient([
      'not json at all',
      JSON.stringify({ color: 'red' }),
    ]);

    // Act
    const intent = await extractIntent(client, 'red something');

    // Assert
    expect(intent).toEqual({ color: 'red' });
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it('keeps the original transcript in context on the retry call, not just the correction', async () => {
    // Arrange — regression test: an earlier version rebuilt the message
    // array from scratch per attempt, so the retry call never re-sent the
    // shopper's actual request, only "here's what you said wrong".
    const client = fakeClient(['not json at all', JSON.stringify({ color: 'red' })]);

    // Act
    await extractIntent(client, 'red something under budget');

    // Assert
    const retryCallArgs = client.chat.completions.create.mock.calls[1][0];
    const retryMessages = retryCallArgs.messages as Array<{ role: string; content: string }>;
    expect(retryMessages.some((m) => m.role === 'user' && m.content.includes('red something under budget'))).toBe(
      true,
    );
    expect(retryMessages.some((m) => m.role === 'assistant' && m.content === 'not json at all')).toBe(true);
  });

  it('throws after the retry also fails to produce valid JSON', async () => {
    // Arrange
    const client = fakeClient(['nope', 'still nope']);

    // Act & Assert
    await expect(extractIntent(client, 'anything')).rejects.toThrow(/unparseable/);
  });

  it('throws when the reply is valid JSON but does not match the schema', async () => {
    // Arrange — priceMax must be a number, not a string
    const client = fakeClient([
      JSON.stringify({ priceMax: 'five thousand' }),
      JSON.stringify({ priceMax: 'still a string' }),
    ]);

    // Act & Assert
    await expect(extractIntent(client, 'something under five thousand')).rejects.toThrow(/unparseable/);
  });
});

describe('planShoppingTurn', () => {
  it('returns a clarification decision rather than inventing products for a broad request', async () => {
    const client = fakeClient([
      JSON.stringify({
        action: 'clarify',
        searchScope: 'new',
        question: 'What occasion is it for?',
        intent: {},
      }),
    ]);

    await expect(planShoppingTurn(client, 'I need something nice', 'user: I need something nice')).resolves.toEqual({
      action: 'clarify',
      searchScope: 'new',
      question: 'What occasion is it for?',
      intent: {},
    });
  });

  it('keeps conversational context available when planning a follow-up', async () => {
    const client = fakeClient([
      JSON.stringify({
        action: 'search',
        searchScope: 'refine',
        question: null,
        intent: { collection: 'formal', color: 'green' },
      }),
    ]);

    await planShoppingTurn(client, 'green instead', 'user: I need a formal outfit\nassistant: Which colour do you prefer?');

    const prompt = client.chat.completions.create.mock.calls[0][0].messages[1].content;
    expect(prompt).toContain('I need a formal outfit');
    expect(prompt).toContain('green instead');
  });

  it('gives the planner the real Bareeze niche and verified category scope', async () => {
    const client = fakeClient([
      JSON.stringify({ action: 'search', searchScope: 'new', question: null, intent: { occasion: 'eid' } }),
    ]);

    await planShoppingTurn(client, 'I need something for Eid', '');

    const systemPrompt = client.chat.completions.create.mock.calls[0][0].messages[0].content;
    expect(systemPrompt).toContain("Pakistani women's fashion");
    expect(systemPrompt).toContain('casuals, formals, pret, prints, shawls');
    expect(systemPrompt).toContain("children's or menswear");
  });
});
