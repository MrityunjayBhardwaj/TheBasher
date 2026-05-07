// LLM transport types — provider-agnostic at the domain level, with
// provider-specific request shapes carved out where they actually differ.
//
// OpenAI Chat Completions (the spec the codebase targets) requires:
//   1. Assistant turns that emit tool calls carry `tool_calls: [...]`.
//   2. Each `tool_calls` entry MUST be followed by exactly one
//      `{ role: 'tool', tool_call_id, content }` message before the next
//      assistant turn.
// Without this shape, OpenAI / Anthropic / Gemini reject the request.
// DeepInfra+Gemma is permissive enough to swallow malformed turns —
// we don't rely on that.
//
// REF: THESIS.md §20-21 (tool surface, context strategy).

export interface LLMConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Max output tokens per response. */
  maxTokens?: number;
  /** Temperature for generation. 0 = deterministic. */
  temperature?: number;
  /** Hard cap on cumulative tokens consumed within a single agent turn. */
  maxTurnTokens?: number;
  /**
   * tool_choice strategy — 'auto' (default), 'none', 'required', or
   * a specific tool name like 'dag.exec'.
   */
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
}

/**
 * Provider-agnostic tool definition that the orchestrator passes through.
 * The transport adapter converts this into the provider-specific request
 * shape (OpenAI: `{type:'function', function:{name, parameters}}`;
 * Anthropic would use `{name, input_schema}`).
 */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool's parameters. */
  parameters: Record<string, unknown>;
}

/** Tool-call payload as it appears in an assistant message we send back to the LLM. */
export interface AssistantToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * A message in the LLM-facing conversation. Distinct from the UI-facing
 * session.Message — this is the on-the-wire chat shape.
 *
 * Three legitimate combos:
 *   { role: 'system' | 'user',  content: string }
 *   { role: 'assistant',        content: string, tool_calls?: [...] }
 *   { role: 'tool',             content: string, tool_call_id: string }
 */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: AssistantToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

/** Streaming tool-call delta. `id` and `name` may arrive only on the first chunk. */
export interface ToolCall {
  index: number;
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'done' | 'error';
  text?: string;
  tool_call?: ToolCall;
  finish_reason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
  error?: string;
}
