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
import type { ToolContext, ToolResult } from './tools/types';
import type { DagState } from '../core/dag/state';
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
  /** Node ids currently selected by the user. */
  selectedNodeIds: ReadonlySet<string>;
}

/**
 * Run a single agent turn. Multi-turn loop: the LLM can call read-only
 * tools (e.g. dag.inspect), see the results, and then call mutation tools
 * (e.g. dag.exec) in a follow-up — all inside one user message.
 *
 * Max 3 rounds to prevent runaway loops.
 * Returns the accumulated text and tool call count.
 */
export async function runAgentTurn(
  config: LLMConfig,
  options: TurnOptions,
): Promise<TurnResult> {
  const { message, dagState, mode, signal, selectedNodeIds } = options;
  const sessionStore = useAgentSessionStore.getState();
  const allText: string[] = [];
  const allOps: { ops: import('../core/dag/types').Op[]; source: string }[] = [];
  const allToolNames: string[] = [];
  let error: string | null = null;

  // Build initial messages
  const systemPrompt = buildSystemPrompt(dagState, mode, selectedNodeIds);
  const tools = listTools();
  const toolSchemas = buildToolSchemas(tools);

  // Start the conversation history for this turn
  sessionStore.addMessage({ role: 'user', content: message });
  sessionStore.setStreaming(true);
  sessionStore.setError(null);
  sessionStore.addMessage({ role: 'assistant', content: '' });

  // Multi-turn loop: read-only tools feed results back for another LLM call
  // Read fresh store state — the snapshot at line 57 is stale after addMessage.
  let messages = buildMessages(systemPrompt, message, useAgentSessionStore.getState().session.messages);
  let round = 0;
  const MAX_ROUNDS = 3;

  while (round < MAX_ROUNDS) {
    round++;
    const roundText: string[] = [];
    const toolCallAccumulators = new Map<number, {
      id: string;
      name: string;
      argsBuffer: string;
    }>();

    if (signal?.aborted) break;

    try {
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
      return { text: allText.join(''), toolCallCount: allToolNames.length, error };
    }

    allText.push(...roundText);

    // Execute complete tool calls for this round
    const roundOps: { ops: import('../core/dag/types').Op[]; source: string }[] = [];
    const roundToolNames: string[] = [];
    const roundToolResultTexts: string[] = [];

    for (const [, acc] of toolCallAccumulators) {
      if (!acc.name) continue;
      const toolDef = getTool(acc.name);
      if (!toolDef) {
        sessionStore.appendToLastAssistant(`\n\n[Unknown tool: ${acc.name}]`);
        continue;
      }

      let args: unknown;
      try {
        args = JSON.parse(acc.argsBuffer);
      } catch {
        sessionStore.appendToLastAssistant(`\n\n[Tool ${acc.name}: invalid JSON arguments]`);
        continue;
      }

      const parsed = toolDef.paramSchema.safeParse(args);
      if (!parsed.success) {
        sessionStore.appendToLastAssistant(`\n\n[Tool ${acc.name}: validation failed — ${parsed.error.message}]`);
        continue;
      }

      const ctx: ToolContext = { dagState, selectedNodeIds };
      try {
        const handlerResult = toolDef.handler(parsed.data, ctx);
        const result: ToolResult = handlerResult instanceof Promise ? await handlerResult : handlerResult;
        if (result.ops.length > 0) {
          roundOps.push({ ops: result.ops, source: acc.name });
          roundToolNames.push(acc.name);
        }
        if (result.text) {
          roundToolResultTexts.push(result.text);
        }
      } catch (handlerErr) {
        sessionStore.appendToLastAssistant(`\n\n[Tool ${acc.name}: ${(handlerErr as Error).message}]`);
        continue;
      }
    }

    // Accumulate ops across rounds
    allOps.push(...roundOps);
    allToolNames.push(...roundToolNames);

    // If no tool calls were made, the LLM responded with text — done.
    if (toolCallAccumulators.size === 0) {
      break;
    }

    // If mutation ops were produced, propose the diff and done.
    if (roundOps.length > 0) {
      const resultBlock = '\n\n--- Tool results ---\n' + roundToolResultTexts.join('\n\n');
      sessionStore.appendToLastAssistant(resultBlock);

      const flatOps = allOps.flatMap((e) => e.ops);
      const description = allToolNames.join(', ');
      useDiffStore.getState().propose(dagState, flatOps, description);
      break;
    }

    // Only read-only tools were called. Feed results back for a follow-up.
    if (roundToolResultTexts.length > 0) {
      const resultBlock = '\n\n--- Tool results ---\n' + roundToolResultTexts.join('\n\n');
      sessionStore.appendToLastAssistant(resultBlock);
    }

    // Use the current message param directly — guaranteed current turn.
    messages = [
      ...messages,
      { role: 'assistant', content: roundText.join('') + '\n\n--- Tool results ---\n' + roundToolResultTexts.join('\n\n') },
      { role: 'user', content: `You inspected the DAG. Now execute what the user asked. The user's request was: "${message}". Call dag.exec with the concrete ops. Do exactly what was asked — no extra objects, no extra features.` },
    ];
  }

  sessionStore.setStreaming(false);
  return { text: allText.join(''), toolCallCount: allToolNames.length, error };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSystemPrompt(dagState: DagState, mode: AgentMode, selectedNodeIds: ReadonlySet<string>): string {
  const summary = summarizeDag(dagState.nodes, dagState.outputs);
  const tools = listTools()
    .map((t) => `  - ${t.name}: ${t.description}`)
    .join('\n');

  // Describe selected nodes with their current params so the LLM knows
  // which node to operate on and what values it already has.
  const selectedDetails: string[] = [];
  for (const id of selectedNodeIds) {
    const n = dagState.nodes[id];
    if (n) {
      selectedDetails.push(`  - ${id} (${n.type}): ${JSON.stringify(n.params)}`);
    }
  }
  const selectionBlock = selectedNodeIds.size > 0
    ? `Selected nodes:\n${selectedDetails.join('\n')}`
    : 'No node selected.';

  // Concrete Op construction examples the LLM can reference.
  const opExamples = `
Examples — construct these inside dag.exec's ops array:

1. Add a red BoxMesh:
   {"type":"addNode","nodeId":"box1","nodeType":"BoxMesh","params":{"size":[1,1,1],"position":[0,1,0],"rotation":[0,0,0],"material":{"name":"default","color":"#ff0000"}}}

2. Add to scene children:
   {"type":"connect","from":{"node":"box1","socket":"out"},"to":{"node":"scene","socket":"children"}}

3. Remove a node:
   {"type":"removeNode","nodeId":"box1"}

4. Change a pram:
   {"type":"setParam","nodeId":"box1","paramPath":"material.color","value":"#00ff00"}

5. Disonnect:
   {"type":"disconnect","from":{"node":"box1","socket":"out"},"to":{"node":"scene","socket":"children"}}

Use lowerCamelCase for nodeId values (e.g. "myCube", "pointLight1").`;

  return [
    `You are Basher\'s AI agent — a director-first assistant for procedural 3D scene authoring.`,
    `Current mode: ${mode}`,
    ``,
    `You have the following tools available:`,
    tools,
    ``,
    `Workflow (multi-turn — ALWAYS follow these steps):`,
    `Step 1: Call dag.inspect(scope:"all") to understand the current scene.`,
    `Step 2: Review the results. Plan your changes.`,
    `Step 3: Call dag.exec(description, ops) with the concrete ops array.`,
    `Step 4: The diff is proposed; the user must accept/reject it.`,
    ``,
    `Rules:`,
    `- You NEVER mutate the scene directly. Every tool returns Op[] that gets proposed as a diff.`,
    `- The user must accept/reject the diff before any change takes effect.`,
    `- Describe your changes clearly so the user knows what you propose.`,
    `- If a tool call fails, explain the error to the user.`,
    `- ALWAYS call dag.inspect first to understand the current state.`,
    `- After dag.inspect returns results, you MUST call dag.exec to make changes — do not stop after inspecting.`,
    `- Always include a "connect" op to wire new nodes into the scene's "children" socket, otherwise they won't appear.`,
    ``,
    `Node pram tips:`,
    `- BoxMesh: params = { size: [1,1,1], position: [0,0,0], rotation: [0,0,0], material: { name: "default", color: "#5af07a" } }`,
    `- SphereMesh: params = { radius: 1, position: [0,0,0] }`,
    `- DirectionalLight: params = { intensity: 1, color: "#ffffff", position: [5,10,5], rotation: [0,0,0] }`,
    `- To change pram after creation: setParam { nodeId, pramPath: "material.color" or "position" or "rotation" etc., value }`,
    `- Scene children use list connections. To add a child: connect { from: {node: childId, socket: "out"}, to: {node: sceneId, socket: "children"} }`,
    ``,
    `Current DAG state:`,
    summary,
    ``,
    selectionBlock,
    ``,
    opExamples,
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

  // history already contains the latest user message (pushed before calling
  // this), plus previous turns for context. Keep within token budget.
  const recentHistory = history.slice(-12);
  for (const m of recentHistory) {
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }

  return msgs;
}
