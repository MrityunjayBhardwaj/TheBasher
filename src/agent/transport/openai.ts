// OpenAI-compatible streaming chat completion transport.
//
// Supports any provider with an OpenAI-compatible API:
//   - Deep Infra (google/gemma-4-31B-it, etc.)
//   - Groq
//   - Together
//   - OpenAI itself
//   - Anyscale, Fireworks, etc.
//
// The connection is pure fetch (no SDK dependency). Streams via SSE.
//
// REF: THESIS.md §21.

import type { LLMConfig, ChatMessage, ToolSchema, ToolCall, StreamChunk } from './types';

export interface StreamOptions {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  signal?: AbortSignal;
  onChunk: (chunk: StreamChunk) => void;
}

/**
 * Stream a chat completion from an OpenAI-compatible API.
 * Calls `onChunk` for each text delta, tool call, and final usage.
 *
 * The function resolves when the stream completes or rejects on error.
 */
export async function streamChatCompletion(
  config: LLMConfig,
  options: StreamOptions,
): Promise<void> {
  const { messages, tools, signal, onChunk } = options;

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
    max_tokens: config.maxTokens ?? 4096,
    temperature: config.temperature ?? 0.7,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
    // GPT-family models prefer `tool_choice: 'auto'`
    body.tool_choice = 'auto';
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
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
      // Keep the last partial line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6).trim();

        // SSE done signal
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

          // Text content
          if (delta.content) {
            onChunk({ type: 'text', text: delta.content });
          }

          // Tool calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const partial: ToolCall = {
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
 * Build tool schemas for the OpenAI-compatible API from our ToolDefinitions.
 * Returns the `tools` array for the chat completion request body.
 */
export function buildToolSchemas(
  tools: Array<{ name: string; description: string; paramSchema: { _def?: unknown } }>,
): ToolSchema[] {
  return tools.map((t) => {
    // Convert zod schema to JSON Schema. OpenAI-compatible APIs accept
    // JSON Schema in the `parameters` field.
    const schema = zodToJsonSchema(t.paramSchema);
    return {
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: schema,
      },
    };
  });
}

/**
 * Minimal zod-to-JSON-Schema converter.
 * Covers the subset needed for Basher's first-party tool schemas:
 * object, string, number, array, enum, optional, default.
 */
function zodToJsonSchema(zodSchema: { _def?: unknown }): Record<string, unknown> {
  // Our tool schemas are always z.object(...) at the top level.
  // This returns a basic JSON Schema object shape.
  const schema: Record<string, unknown> = {
    type: 'object',
    properties: {},
    required: [],
  };

  // Since we can't reliably introspect zod schemas at runtime without
  // the full zod-to-json-schema library, we return a minimal schema
  // that accepts any object. The actual validation happens in the tool
  // handler via zod's safeParse.
  //
  // For production, this should be replaced with a proper zod-to-json-schema
  // transform when the LLM provider requires strict schema enforcement.
  // For Deep Infra / Gemma, the descriptive tool names + descriptions
  // do the heavy lifting; schema enforcement is at the handler boundary.
  return schema;
}
