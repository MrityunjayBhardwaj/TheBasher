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
 * Convert a zod schema to JSON Schema for OpenAI-compatible tool definitions.
 *
 * Handles: object, string, number, boolean, array, enum, optional, default,
 * nullable, and .describe() annotations. Recursive for nested objects/arrays.
 */
function zodToJsonSchema(zodSchema: unknown): Record<string, unknown> {
  // Top-level unwrap: zod schema is always a ZodType, but we work with
  // what we can introspect through _def and public methods.

  const schemaDef = (zodSchema as Record<string, unknown>)?._def as Record<string, unknown> | undefined;
  if (!schemaDef) return { type: 'object' };

  const typeName = schemaDef.typeName as string | undefined;

  // --- Leaf types ---
  if (typeName === 'ZodString') {
    const result: Record<string, unknown> = { type: 'string' };
    const checks = schemaDef.checks as Array<Record<string, unknown>> | undefined;
    if (checks) {
      for (const c of checks) {
        if (c.kind === 'min') result.minLength = c.value;
        if (c.kind === 'max') result.maxLength = c.value;
      }
    }
    return result;
  }

  if (typeName === 'ZodNumber') {
    const result: Record<string, unknown> = { type: 'number' };
    const checks = schemaDef.checks as Array<Record<string, unknown>> | undefined;
    if (checks) {
      for (const c of checks) {
        if (c.kind === 'min') result.minimum = c.value;
        if (c.kind === 'max') result.maximum = c.value;
        if (c.kind === 'positive') result.exclusiveMinimum = 0;
      }
    }
    return result;
  }

  if (typeName === 'ZodBoolean') return { type: 'boolean' };

  // --- Array ---
  if (typeName === 'ZodArray') {
    const innerType = schemaDef.type;
    const lengthCheck = (schemaDef.checks as Array<Record<string, unknown>> | undefined)
      ?.find((c) => c.kind === 'length');
    const result: Record<string, unknown> = {
      type: 'array',
      items: innerType ? zodToJsonSchema(innerType) : {},
    };
    if (lengthCheck) {
      result.minItems = lengthCheck.value;
      result.maxItems = lengthCheck.value;
    }
    return result;
  }

  // --- Enum ---
  if (typeName === 'ZodEnum') {
    const values = schemaDef.values as string[] | undefined;
    return {
      type: 'string',
      enum: values ?? [],
    };
  }

  // --- Object ---
  if (typeName === 'ZodObject') {
    // zod stores shape as a function for object schemas
    const shapeFn = schemaDef.shape as (() => Record<string, unknown>) | undefined;
    const shape = shapeFn?.() ?? {};
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, fieldSchema] of Object.entries(shape)) {
      const fieldDef = (fieldSchema as Record<string, unknown>)?._def as Record<string, unknown> | undefined;
      const fieldTypeName = fieldDef?.typeName as string | undefined;

      // Extract description from .describe() annotation
      let description: string | undefined;
      if (fieldDef?.description) {
        description = fieldDef.description as string;
      }

      // Check if field is optional (ZodOptional, ZodDefault, or nullable)
      const isOptional =
        fieldTypeName === 'ZodOptional' ||
        fieldTypeName === 'ZodDefault' ||
        (fieldDef?.nullable === true);

      // Unwrap optional/default to get the inner type
      let innerSchema = fieldSchema;
      if (fieldTypeName === 'ZodOptional' || fieldTypeName === 'ZodDefault') {
        innerSchema = (fieldSchema as Record<string, unknown>).unwrap
          ? ((fieldSchema as Record<string, unknown>).unwrap as () => unknown)()
          : fieldSchema;
      }

      const propSchema = zodToJsonSchema(innerSchema);
      if (description) {
        propSchema.description = description;
      }

      properties[key] = propSchema;
      if (!isOptional) {
        required.push(key);
      }
    }

    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
      additionalProperties: false,
    };
  }

  // Fallback — accept anything
  return {};
}
