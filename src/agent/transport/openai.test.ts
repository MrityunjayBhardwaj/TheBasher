// #1057 — the transport has to ASK for usage, or the prompt-read check reads nothing.
//
// The OpenAI spec streams `usage` only when `stream_options.include_usage` is set,
// and Ollama follows it: measured, a stream without the flag carries no usage chunk
// at all. The orchestrator then falls back to its own estimate, and a check that
// compares an estimate with itself can never fire — a guard that is believed and
// off. So the request shape is pinned here, along with the chunk it produces.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamChatCompletion } from './openai';
import type { StreamChunk } from './types';

/** A fetch that records the request body and streams the given SSE lines. */
function fakeFetch(lines: string[]) {
  const sent: Array<Record<string, unknown>> = [];
  const bytes = new TextEncoder().encode(lines.map((l) => `data: ${l}\n\n`).join(''));
  let done = false;
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () =>
            done
              ? { done: true, value: undefined }
              : ((done = true), { done: false, value: bytes }),
          releaseLock: () => {},
        }),
      },
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('streamChatCompletion — usage', () => {
  it('asks for usage on the stream', async () => {
    const sent = fakeFetch(['[DONE]']);
    await streamChatCompletion(
      { baseUrl: 'http://x', model: 'm', apiKey: 'k' },
      { messages: [{ role: 'user', content: 'hi' }], onChunk: () => {} },
    );
    expect(sent[0].stream).toBe(true);
    expect(sent[0].stream_options).toEqual({ include_usage: true });
  });

  it("hands the provider's usage chunk (empty choices, as the spec sends it) to the caller", async () => {
    fakeFetch([
      JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 4096, completion_tokens: 12 } }),
      '[DONE]',
    ]);
    const chunks: StreamChunk[] = [];
    await streamChatCompletion(
      { baseUrl: 'http://x', model: 'm', apiKey: 'k' },
      { messages: [{ role: 'user', content: 'hi' }], onChunk: (c) => chunks.push(c) },
    );
    const usage = chunks.find((c) => c.usage)?.usage;
    expect(usage).toEqual({ prompt_tokens: 4096, completion_tokens: 12 });
  });
});
