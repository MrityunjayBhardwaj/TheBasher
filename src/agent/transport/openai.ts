// OpenAI-compatible streaming chat completion transport.
//
// Supports any provider with an OpenAI-compatible API:
//   - DeepInfra (google/gemma-4-31B-it, etc.)
//   - OpenRouter (Claude, GPT-4o, etc.)
//   - OpenAI itself
//   - Groq, Together, Fireworks, Anyscale.
//
// The connection is pure fetch (no SDK dependency). Streams via SSE.
//
// REF: THESIS.md §21.

import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import type {
  LLMConfig,
  ChatMessage,
  ToolSchema,
  ToolCall,
  StreamChunk,
} from './types';

export interface StreamOptions {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  signal?: AbortSignal;
  onChunk: (chunk: StreamChunk) => void;
  /**
   * tool_choice override per call. Falls back to `config.toolChoice` then 'auto'.
   */
  toolChoice?: LLMConfig['toolChoice'];
}

/**
 * Stream a chat completion from an OpenAI-compatible API.
 * Calls `onChunk` for each text delta, tool call, and final usage.
 *
 * The function resolves when the stream completes or rejects on error.
 *
 * `messages` MUST follow OpenAI's tool-call protocol:
 *   assistant.tool_calls → role:'tool' messages with matching tool_call_id
 *   before the next assistant turn.
 */
export async function streamChatCompletion(
  config: LLMConfig,
  options: StreamOptions,
): Promise<void> {
  const { messages, tools, signal, onChunk } = options;

  const body: Record<string, unknown> = {
    model: config.model,
    messages: messages.map(serializeMessage),
    stream: true,
    max_tokens: config.maxTokens ?? 4096,
    temperature: config.temperature ?? 0.7,
  };

  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    const choice = options.toolChoice ?? config.toolChoice ?? 'auto';
    if (typeof choice === 'object' && 'name' in choice) {
      body.tool_choice = { type: 'function', function: { name: choice.name } };
    } else {
      body.tool_choice = choice;
    }
  }

  const response = await fetchWithRetry(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown error');
    throw new Error(`LLM API error ${response.status}: ${text}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('LLM API response has no body stream');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6).trim();

        if (data === '[DONE]') {
          onChunk({ type: 'done', finish_reason: 'stop' });
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          const finish = parsed.choices?.[0]?.finish_reason;
          const usage = parsed.usage;

          if (usage) {
            onChunk({
              type: 'done',
              finish_reason: finish ?? 'stop',
              usage: {
                prompt_tokens: usage.prompt_tokens ?? 0,
                completion_tokens: usage.completion_tokens ?? 0,
              },
            });
            continue;
          }

          if (finish) {
            onChunk({ type: 'done', finish_reason: finish });
            continue;
          }

          if (!delta) continue;

          if (delta.content) {
            onChunk({ type: 'text', text: delta.content });
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const partial: ToolCall = {
                index: tc.index ?? 0,
                id: tc.id ?? '',
                type: 'function',
                function: {
                  name: tc.function?.name ?? '',
                  arguments: tc.function?.arguments ?? '',
                },
              };
              onChunk({ type: 'tool_call', tool_call: partial });
            }
          }
        } catch {
          // Skip malformed JSON lines (some providers emit non-JSON SSE comments)
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * One-shot retry on transient network failure (TypeError / failed-to-fetch).
 * Aborts and 4xx/5xx pass through to the caller.
 */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    if (init.signal?.aborted) throw err;
    return await fetch(url, init);
  }
}

/**
 * Serialize a domain ChatMessage to the OpenAI on-the-wire shape.
 * The shape is mostly identical, but we normalize undefined fields.
 */
function serializeMessage(msg: ChatMessage): Record<string, unknown> {
  if (msg.role === 'assistant') {
    const out: Record<string, unknown> = { role: 'assistant', content: msg.content };
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      out.tool_calls = msg.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));
    }
    return out;
  }
  if (msg.role === 'tool') {
    return { role: 'tool', tool_call_id: msg.tool_call_id, content: msg.content };
  }
  return { role: msg.role, content: msg.content };
}

/**
 * Build tool schemas for the OpenAI-compatible API from our ToolDefinitions.
 * Returns ToolSchema[] (provider-agnostic); the transport adapter wraps each
 * in `{type:'function', function:{...}}` at request time.
 */
export function buildToolSchemas(
  tools: Array<{ name: string; description: string; paramSchema: z.ZodTypeAny }>,
): ToolSchema[] {
  return tools.map((t) => {
    const json = zodToJsonSchema(t.paramSchema, {
      $refStrategy: 'none',
      target: 'openApi3',
    }) as Record<string, unknown>;
    // zod-to-json-schema returns a top-level $schema field; OpenAI ignores
    // it but stripping keeps the body lean.
    delete json.$schema;
    return {
      name: t.name,
      description: t.description,
      parameters: json,
    };
  });
}
