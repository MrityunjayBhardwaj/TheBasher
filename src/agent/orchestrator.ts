// Agent orchestrator — one agent turn per user message.
//
// Lifecycle (krama K3):
//   1. Reset diff store (no stale pending diff carries across turns).
//   2. Filter tools by mode; build a STATIC system prompt (no per-turn DAG
//      state — keeps re-prompts cheap across multi-turn rounds).
//   3. Build per-turn user-side context (DAG summary + selection + the
//      user message). Read fresh DAG state at every round so the agent
//      can never act on a stale snapshot.
//   4. Stream a chat completion. On each round:
//        - text deltas → appended to the current assistant bubble
//        - tool calls → accumulated by index (H17)
//        - usage → captured per round (per-request, not summed across
//          chunks)
//   5. After streaming: execute tool handlers; for EACH tool call emit a
//      proper { role:'tool', tool_call_id } message back into the
//      LLM-facing conversation. Errors come back the same way so the LLM
//      can retry.
//   6. If mutation ops were produced this round → fork DAG against
//      CURRENT state and propose a diff. End the turn.
//      Otherwise (read-only tools only) → loop for another round so the
//      LLM can chain inspect → exec or refine its plan.
//
// Pure orchestration — no direct DAG mutation. All mutations go through
// the diff system (V7).
//
// REF: THESIS.md §18-21, krama K3, vyapti V7 + V11.

import type { LLMConfig, ChatMessage, AssistantToolCall } from './transport/types';
import { streamChatCompletion, buildToolSchemas } from './transport/openai';
import { getTool, listTools } from './tools/registry';
import type { ToolContext, ToolDefinition, ToolResult } from './tools/types';
import { useDagStore } from '../core/dag/store';
import { useDiffStore } from './diff/store';
import { useAgentSessionStore, summarizeDag, type AgentMode } from './session/store';
import type { Op } from '../core/dag/types';

const MAX_ROUNDS = 4;
const DEFAULT_TURN_TOKEN_BUDGET = 30_000;
const PARAMS_PREVIEW_LIMIT = 240;
/** Cap on prior session messages threaded into the LLM context. Anchored:
 * always keep the first user message + the most-recent ones up to this cap. */
const MAX_HISTORY_MESSAGES = 16;

export interface TurnResult {
  /** Assistant text response (accumulated from streaming deltas across all rounds). */
  text: string;
  /** Number of mutation tool calls made (read-only inspect calls don't count). */
  toolCallCount: number;
  /** Error message if the turn failed. */
  error: string | null;
}

export interface TurnOptions {
  /** User message text. */
  message: string;
  /** Current agent mode. */
  mode: AgentMode;
  /** Abort signal to cancel the turn. */
  signal?: AbortSignal;
  /** Node ids currently selected by the user. */
  selectedNodeIds: ReadonlySet<string>;
}

/**
 * Run a single agent turn. Multi-turn loop: the LLM can call read-only
 * tools (e.g. dag.inspect), see the results, and then call mutation tools
 * (e.g. dag.exec) in a follow-up — all inside one user message.
 *
 * Bounded by MAX_ROUNDS and the per-turn token budget.
 */
export async function runAgentTurn(
  config: LLMConfig,
  options: TurnOptions,
): Promise<TurnResult> {
  const { message, mode, signal, selectedNodeIds } = options;
  const sessionStore = useAgentSessionStore.getState();

  // F7: clear any stale pending diff before starting.
  useDiffStore.getState().reset();

  // A4: tools available depend on mode. read-only literally cannot call
  // dag.exec / mesh.add / camera.snapshot / library.import / character.walkTo.
  const availableTools = filterToolsByMode(listTools(), mode);
  const toolSchemas = buildToolSchemas(availableTools);

  // A6: static prompt — rules + tool catalogue + op examples. Doesn't
  // include DAG state. Re-sending it across rounds is cheap.
  const systemPrompt = buildStaticSystemPrompt(mode, availableTools);

  // A8: capture the prior session history BEFORE pushing the current user
  // message so we can thread it into the LLM context.
  const priorHistory = anchorHistory(
    useAgentSessionStore.getState().session.messages,
    MAX_HISTORY_MESSAGES,
  );

  // Push the user message to session (UI history).
  sessionStore.addMessage({ role: 'user', content: message });
  sessionStore.setStreaming(true);
  sessionStore.setError(null);

  // F2: read fresh DAG state for context. The LLM-facing user message
  // bundles the current scene summary + selection + the user request.
  const initialContext = buildContextBlock(useDagStore.getState().state, selectedNodeIds);

  // The wire-format conversation — what we actually send to the API.
  // Distinct from session.messages (UI-facing).
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...priorHistory.map((m): ChatMessage =>
      m.role === 'assistant'
        ? { role: 'assistant', content: m.content }
        : { role: 'user', content: m.content },
    ),
    { role: 'user', content: `${initialContext}\n\nUser request: ${message}` },
  ];

  const allText: string[] = [];
  let mutationToolCallCount = 0;
  let error: string | null = null;
  let totalTokens = 0;
  const turnBudget = config.maxTurnTokens ?? DEFAULT_TURN_TOKEN_BUDGET;

  try {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (signal?.aborted) break;

      // F5: a fresh assistant bubble per round. Clean separation in the UI
      // between "round 1 said X, called inspect" and "round 2 said Y, called exec".
      sessionStore.addMessage({ role: 'assistant', content: '' });

      const roundText: string[] = [];
      const toolCallAccumulators = new Map<number, {
        id: string;
        name: string;
        argsBuffer: string;
      }>();
      // F3: capture exactly one usage event per round (provider sends
      // cumulative-per-request totals on the final chunk).
      let roundPromptTokens = 0;
      let roundCompletionTokens = 0;

      await streamChatCompletion(config, {
        messages,
        tools: toolSchemas,
        signal,
        onChunk: (chunk) => {
          switch (chunk.type) {
            case 'text': {
              const t = chunk.text ?? '';
              roundText.push(t);
              sessionStore.appendToLastAssistant(t);
              break;
            }
            case 'tool_call': {
              const tc = chunk.tool_call!;
              const idx = tc.index ?? 0;
              const existing = toolCallAccumulators.get(idx);
              if (existing) {
                existing.argsBuffer += tc.function.arguments;
                if (tc.function.name) existing.name = tc.function.name;
                if (tc.id) existing.id = tc.id;
              } else {
                toolCallAccumulators.set(idx, {
                  id: tc.id,
                  name: tc.function.name,
                  argsBuffer: tc.function.arguments,
                });
              }
              break;
            }
            case 'done': {
              if (chunk.usage) {
                roundPromptTokens = chunk.usage.prompt_tokens;
                roundCompletionTokens = chunk.usage.completion_tokens;
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

      allText.push(...roundText);

      // F3: one addTokenUsage per round. The session store accumulates
      // across the turn; UI shows the running total.
      if (roundPromptTokens > 0 || roundCompletionTokens > 0) {
        sessionStore.addTokenUsage(roundPromptTokens, roundCompletionTokens);
        totalTokens += roundPromptTokens + roundCompletionTokens;
      }

      // A5: hard cost guard. Abort the loop instead of silently spending.
      if (totalTokens > turnBudget) {
        sessionStore.appendToLastAssistant(
          `\n\n[Cost guard: turn exceeded ${turnBudget} tokens — stopping.]`,
        );
        break;
      }

      // No tool calls → text-only response → turn complete.
      if (toolCallAccumulators.size === 0) {
        break;
      }

      // Execute tool calls and build the assistant{tool_calls} + tool result
      // messages that we'll append to `messages` for the next round.
      const completedToolCalls: AssistantToolCall[] = [];
      const toolResultMessages: ChatMessage[] = [];
      const roundOps: Op[] = [];
      const roundOpSources: string[] = [];
      const roundMutationToolNames: string[] = [];

      // F2: re-read DAG state JUST before tool execution. If the user
      // dispatched an op while the LLM was thinking, tools see the truth.
      const currentDagState = useDagStore.getState().state;
      const ctx: ToolContext = { dagState: currentDagState, selectedNodeIds };

      // Iterate by accumulator index (insertion order).
      const entries = Array.from(toolCallAccumulators.entries()).sort((a, b) => a[0] - b[0]);
      for (const [, acc] of entries) {
        if (!acc.name) continue;

        // Reconstruct the assistant.tool_calls entry verbatim from what we
        // accumulated. This is what we send back so the LLM sees the same
        // call it made.
        completedToolCalls.push({
          id: acc.id || `call_${acc.name}_${Date.now().toString(36)}`,
          type: 'function',
          function: { name: acc.name, arguments: acc.argsBuffer },
        });

        const toolDef = getTool(acc.name);
        const result = await executeToolCall(acc, toolDef, ctx, mode);
        const resultMessage = result.text ?? `OK (${result.ops.length} ops)`;

        // F1: each tool_call MUST be answered by exactly one role:'tool'
        // message with matching tool_call_id. Otherwise OpenAI / Anthropic /
        // Gemini reject the request. Don't rely on Gemma's leniency.
        toolResultMessages.push({
          role: 'tool',
          tool_call_id: completedToolCalls[completedToolCalls.length - 1].id,
          content: resultMessage,
        });

        // Surface the result to the user in the chat too (debuggability).
        sessionStore.appendToLastAssistant(
          `\n\n[${acc.name}] ${resultMessage}`,
        );

        if (result.ops.length > 0) {
          for (const op of result.ops) {
            roundOps.push(op);
            roundOpSources.push(`agent:${acc.name}`);
          }
          roundMutationToolNames.push(acc.name);
        }
      }

      // F1: append the assistant turn (with tool_calls) and the tool
      // results to the conversation, in the exact order the spec requires.
      messages.push({
        role: 'assistant',
        content: roundText.join(''),
        tool_calls: completedToolCalls,
      });
      messages.push(...toolResultMessages);

      // If mutation ops were produced → propose them as a diff and end the
      // turn. The user accepts/rejects via DiffBar.
      if (roundOps.length > 0) {
        mutationToolCallCount += roundMutationToolNames.length;
        const description = roundMutationToolNames.join(', ');
        try {
          // F8: createFork can throw on op validation (unknown node, cycle,
          // type mismatch). Without try/catch the orchestrator never sets
          // streaming=false and the UI hangs.
          useDiffStore.getState().propose(currentDagState, roundOps, description, roundOpSources);
        } catch (proposeErr) {
          const msg = `Diff proposal failed: ${(proposeErr as Error).message}`;
          sessionStore.appendToLastAssistant(`\n\n[${msg}]`);
          error = msg;
        }
        break;
      }

      // Only read-only tools were called this round. Loop for another
      // round so the LLM can act on the inspection results.
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      error = 'Cancelled';
    } else {
      error = (err as Error).message ?? 'Unknown error';
    }
    sessionStore.setError(error);
  } finally {
    sessionStore.setStreaming(false);
  }

  return { text: allText.join(''), toolCallCount: mutationToolCallCount, error };
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeToolCall(
  acc: { id: string; name: string; argsBuffer: string },
  toolDef: ToolDefinition | undefined,
  ctx: ToolContext,
  mode: AgentMode,
): Promise<ToolResult> {
  // F6: every error path returns a structured ToolResult so it lands in the
  // LLM-facing tool message. The LLM can retry with corrections instead of
  // looping on the same broken call.
  if (!toolDef) {
    return { ops: [], text: `ERROR: unknown tool "${acc.name}"` };
  }

  // A4: belt-and-suspenders mode check. The tools array sent to the LLM is
  // already filtered, but if the model hallucinates a tool name we don't
  // want to execute it.
  if (mode === 'read-only' && acc.name !== 'dag.inspect') {
    return { ops: [], text: `ERROR: tool "${acc.name}" not available in read-only mode` };
  }

  let args: unknown;
  try {
    args = acc.argsBuffer ? JSON.parse(acc.argsBuffer) : {};
  } catch {
    return { ops: [], text: `ERROR: invalid JSON arguments — ${acc.argsBuffer.slice(0, 200)}` };
  }

  const parsed = toolDef.paramSchema.safeParse(args);
  if (!parsed.success) {
    return {
      ops: [],
      text: `ERROR: parameter validation failed — ${parsed.error.message}`,
    };
  }

  try {
    const handlerResult = toolDef.handler(parsed.data, ctx);
    const result: ToolResult = handlerResult instanceof Promise ? await handlerResult : handlerResult;
    return result;
  } catch (handlerErr) {
    return { ops: [], text: `ERROR: ${(handlerErr as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Mode + tool filtering
// ---------------------------------------------------------------------------

function filterToolsByMode(tools: ToolDefinition[], mode: AgentMode): ToolDefinition[] {
  if (mode === 'read-only') {
    return tools.filter((t) => t.name === 'dag.inspect');
  }
  // copilot + sandbox both expose the full surface; sandbox isolation is
  // handled by the diff system (proposed ops never auto-merge regardless).
  return tools;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildStaticSystemPrompt(mode: AgentMode, tools: ToolDefinition[]): string {
  const toolList = tools.map((t) => `  - ${t.name}: ${t.description}`).join('\n');

  const opExamples = `
Op shape examples (use inside dag.exec's "ops" array):

1. Add a red BoxMesh:
   {"type":"addNode","nodeId":"box1","nodeType":"BoxMesh","params":{"size":[1,1,1],"position":[0,1,0],"rotation":[0,0,0],"material":{"name":"default","color":"#ff0000"}}}

2. Wire into scene children:
   {"type":"connect","from":{"node":"box1","socket":"out"},"to":{"node":"scene","socket":"children"}}

3. Remove a node:
   {"type":"removeNode","nodeId":"box1"}

4. Change a param:
   {"type":"setParam","nodeId":"box1","paramPath":"material.color","value":"#00ff00"}

5. Disconnect:
   {"type":"disconnect","from":{"node":"box1","socket":"out"},"to":{"node":"scene","socket":"children"}}

Use lowerCamelCase for nodeId values (e.g. "myCube", "pointLight1").`;

  const paramTips = `
Common node params:
- BoxMesh: { size: [1,1,1], position: [0,0,0], rotation: [0,0,0], material: { name: "default", color: "#5af07a" } }
- SphereMesh: { radius: 1, position: [0,0,0] }
- DirectionalLight: { intensity: 1, color: "#ffffff", position: [5,10,5], rotation: [0,0,0] }
- setParam paramPath supports dot paths: "material.color", "position", "rotation".
- Scene children use list connections: connect { from: {node: childId, socket: "out"}, to: {node: sceneId, socket: "children"} }`;

  return [
    `You are Basher's AI agent — a director-first assistant for procedural 3D scene authoring.`,
    `Mode: ${mode}`,
    ``,
    `Available tools:`,
    toolList,
    ``,
    `Rules:`,
    `- You NEVER mutate the scene directly. Mutation tools return Op[] that get proposed as a diff for the user to accept or reject.`,
    `- Use dag.inspect when you need to discover node ids or types you don't already know.`,
    `- Use dag.exec to execute concrete Ops. Make sure new nodes are wired into the scene's "children" socket so they appear.`,
    `- The user's current selection appears in the Context block at the start of each turn — prefer acting on selected nodes when the request says "this", "selected", "it".`,
    `- Describe your changes clearly so the user knows what you propose.`,
    `- If a tool call returns an ERROR, read the message and either retry with corrected args or explain to the user why it can't be done.`,
    opExamples,
    paramTips,
  ].join('\n');
}

function buildContextBlock(
  dagState: { nodes: Record<string, { type: string; params?: unknown }>; outputs: Record<string, unknown> },
  selectedNodeIds: ReadonlySet<string>,
): string {
  const summary = summarizeDag(dagState.nodes, dagState.outputs);

  // Selection block — id, type, and a truncated JSON of params so the LLM
  // can act on selected nodes without having to dag.inspect first.
  const selectionDetails: string[] = [];
  for (const id of selectedNodeIds) {
    const n = dagState.nodes[id];
    if (n) {
      const paramsStr = truncate(JSON.stringify(n.params ?? {}), PARAMS_PREVIEW_LIMIT);
      selectionDetails.push(`  - ${id} (${n.type}): ${paramsStr}`);
    }
  }
  const selectionBlock = selectedNodeIds.size > 0
    ? `Selected nodes:\n${selectionDetails.join('\n')}`
    : 'Selected nodes: none.';

  return ['Context (current DAG state):', summary, '', selectionBlock].join('\n');
}

function truncate(s: string, limit: number): string {
  return s.length <= limit ? s : `${s.slice(0, limit)}…`;
}

/**
 * Anchor the conversation history: always keep the first non-empty message
 * (preserves the original goal across long sessions) plus the most recent
 * ones up to the cap.
 *
 * Drops empty assistant placeholders left over from in-progress / cancelled
 * turns.
 */
function anchorHistory(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  cap: number,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const filtered = messages.filter((m) => m.content.length > 0);
  if (filtered.length <= cap) return filtered;
  const head = filtered[0];
  const tail = filtered.slice(-(cap - 1));
  return [head, ...tail];
}
