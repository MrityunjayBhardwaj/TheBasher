// Agent orchestrator — one agent turn per user message.
//
// Lifecycle (krama K3):
//   1. Build system prompt + context (DAG summary, recent activity, tool schemas)
//   2. Stream response from LLM (text + tool calls)
//   3. On each complete tool call: validate args via zod, execute handler → Op[]
//   4. Collect all Op[] → propose diff to diffStore
//   5. User accepts/rejects (DiffBar UI)
//
// Pure orchestration — no direct DAG mutation. All mutations go through the
// diff system (V7).
//
// REF: THESIS.md §18-21, krama K3, vyapti V7.

import type { LLMConfig } from './transport/types';
import { streamChatCompletion, buildToolSchemas } from './transport/openai';
import type { ToolCall } from './transport/types';
import { getTool, listTools } from './tools/registry';
import type { ToolContext } from './tools/types';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { useDiffStore } from './diff/store';
import { useAgentSessionStore, summarizeDag, type AgentMode } from './session/store';

export interface TurnResult {
  /** Assistant text response (accumulated from streaming deltas). */
  text: string;
  /** Number of tool calls made. */
  toolCallCount: number;
  /** Error message if the turn failed. */
  error: string | null;
}

export interface TurnOptions {
  /** User message text. */
  message: string;
  /** Current DAG state snapshot (taken before the turn). */
  dagState: DagState;
  /** Current agent mode. */
  mode: AgentMode;
  /** Abort signal to cancel the turn. */
  signal?: AbortSignal;
}

/**
 * Run a single agent turn.
 * Streams from the LLM, executes tools, proposes a diff.
 *
 * Returns the accumulated text and tool call count.
 */
export async function runAgentTurn(
  config: LLMConfig,
  options: TurnOptions,
): Promise<TurnResult> {
  const { message, dagState, mode, signal } = options;
  const sessionStore = useAgentSessionStore.getState();
  const text: string[] = [];
  const toolCallAccumulators = new Map<string, {
    id: string;
    name: string;
    argsBuffer: string;
  }>();
  let toolCallCount = 0;
  let error: string | null = null;

  // 1. Build the messages array
  const systemPrompt = buildSystemPrompt(dagState, mode);
  const messages = buildMessages(systemPrompt, message, sessionStore.session.messages);

  // 2. Build tool schemas from registry
  const tools = listTools();
  const toolSchemas = buildToolSchemas(tools);

  // 3. Stream from LLM
  sessionStore.addMessage({ role: 'user', content: message });
  sessionStore.setStreaming(true);
  sessionStore.setError(null);

  // Add placeholder assistant message for streaming into
  sessionStore.addMessage({ role: 'assistant', content: '' });

  try {
    await streamChatCompletion(config, {
      messages,
      tools: toolSchemas,
      signal,
      onChunk: (chunk) => {
        switch (chunk.type) {
          case 'text': {
            const t = chunk.text ?? '';
            text.push(t);
            sessionStore.appendToLastAssistant(t);
            break;
          }
          case 'tool_call': {
            const tc = chunk.tool_call!;
            const existing = toolCallAccumulators.get(tc.id);
            if (existing) {
              // Accumulate arguments across chunks
              existing.argsBuffer += tc.function.arguments;
              // When the name is empty, keep the first non-empty one
              if (tc.function.name && !existing.name) {
                existing.name = tc.function.name;
              }
            } else {
              toolCallAccumulators.set(tc.id, {
                id: tc.id,
                name: tc.function.name,
                argsBuffer: tc.function.arguments,
              });
            }
            break;
          }
          case 'done': {
            if (chunk.usage) {
              sessionStore.addTokenUsage(
                chunk.usage.prompt_tokens,
                chunk.usage.completion_tokens,
              );
            }
            break;
          }
          case 'error': {
            error = chunk.error ?? 'Unknown streaming error';
            sessionStore.setError(error);
            break;
          }
        }
      },
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      error = 'Cancelled';
    } else {
      error = (err as Error).message ?? 'Unknown error';
    }
    sessionStore.setError(error);
    sessionStore.setStreaming(false);
    return { text: text.join(''), toolCallCount: 0, error };
  }

  // 4. Execute complete tool calls
  const allOps: { ops: Op[]; source: string }[] = [];
  const executedToolNames: string[] = [];

  for (const [, acc] of toolCallAccumulators) {
    if (!acc.name) continue;
    const toolDef = getTool(acc.name);
    if (!toolDef) {
      // Unknown tool — note it in the text but don't crash
      text.push(`\n\n[Unknown tool: ${acc.name}]`);
      continue;
    }

    // Parse arguments
    let args: unknown;
    try {
      args = JSON.parse(acc.argsBuffer);
    } catch {
      text.push(`\n\n[Tool ${acc.name}: invalid JSON arguments]`);
      continue;
    }

    // Validate with zod at the boundary (H5: input may be wider than output)
    const parsed = toolDef.paramSchema.safeParse(args);
    if (!parsed.success) {
      text.push(`\n\n[Tool ${acc.name}: validation failed — ${parsed.error.message}]`);
      continue;
    }

    // Execute handler
    const ctx: ToolContext = { dagState };
    try {
      const handlerResult = toolDef.handler(parsed.data, ctx);
      // Support both sync and async handlers
      const ops = handlerResult instanceof Promise ? await handlerResult : handlerResult;
      allOps.push({ ops, source: acc.name });
      executedToolNames.push(acc.name);
    } catch (handlerErr) {
      text.push(`\n\n[Tool ${acc.name}: ${(handlerErr as Error).message}]`);
      continue;
    }
  }

  toolCallCount = executedToolNames.length;

  // 5. Propose diff (if any ops were produced)
  if (allOps.length > 0) {
    const flatOps = allOps.flatMap((e) => e.ops);
    const description = executedToolNames.join(', ');
    useDiffStore.getState().propose(dagState, flatOps, description);
  }

  sessionStore.setStreaming(false);
  return { text: text.join(''), toolCallCount, error };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSystemPrompt(dagState: DagState, mode: AgentMode): string {
  const summary = summarizeDag(dagState.nodes, dagState.outputs);
  const tools = listTools()
    .map((t) => `  - ${t.name}: ${t.description}`)
    .join('\n');

  return [
    `You are Basher\'s AI agent — a director-first assistant for procedural 3D scene authoring.`,
    `Current mode: ${mode}`,
    ``,
    `You have the following tools available:`,
    tools,
    ``,
    `Rules:`,
    `- You NEVER mutate the scene directly. Every tool returns Op[] that gets proposed as a diff.`,
    `- The user must accept/reject the diff before any change takes effect.`,
    `- Describe your changes clearly so the user knows what you propose.`,
    `- If a tool call fails, explain the error to the user.`,
    ``,
    `Current DAG state:`,
    summary,
  ].join('\n');
}

function buildMessages(
  systemPrompt: string,
  userMessage: string,
  history: Array<{ role: string; content: string }>,
): Array<{ role: string; content: string }> {
  const msgs: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
  ];

  // Last N history messages for context (keep within token budget)
  const recentHistory = history.slice(-10);
  for (const m of recentHistory) {
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }

  msgs.push({ role: 'user', content: userMessage });
  return msgs;
}
