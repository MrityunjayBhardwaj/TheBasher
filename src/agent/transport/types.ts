// LLM transport types — provider-agnostic.
//
// The transport layer abstracts over OpenAI-compatible APIs. Deep Infra's
// google/gemma-4-31B-it uses this format; Anthropic, Groq, and others also
// offer compatible endpoints.
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
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool's parameters. */
  input_schema: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatChunk {
  /** Text delta */
  content: string | null;
  /** Tool call delta (if streaming tool calls) */
  tool_calls?: ToolCall[];
  /** Finish reason if this is the final chunk */
  finish_reason?: string | null;
  /** Usage for the final chunk */
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'done' | 'error';
  text?: string;
  tool_call?: ToolCall;
  finish_reason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
  error?: string;
}
