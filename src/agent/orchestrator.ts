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
import { ClosurePreservationError } from '../agent/closure/expand';
import type { ClosureSpec } from './closure/types';
import type { IdentifyResult } from './identify/types';
import { recordEvent } from './telemetry';
import { useAgentSessionStore, summarizeDag, type AgentMode } from './session/store';
import type { Op, NodeId } from '../core/dag/types';

// Bumped 4 → 8 (2026-05-08, post-PR-#9 live smoke). Single user intents
// often legitimately require 2 identifies + listMutators + proposePlan +
// a setMaterialColor chain (5+ tool calls). At 4 rounds the orchestrator
// silently capped before retry, requiring the user to type "continue."
// 8 covers the realistic compose patterns; bound stays so a confused
// model can't loop forever.
const MAX_ROUNDS = 8;
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

  // Wave B (Identify pre-stage). When the user phrase references existing
  // nodes ("the cube", "this", "selected"), round 1 is forced through
  // agent.identify so the orchestrator commits to a concrete selector
  // (or surfaces ambiguity to the user) BEFORE any mutation round runs.
  // The heuristic skips Identify for purely additive prompts (P-3
  // mitigation — no latency penalty for "add a red cube").
  let identifiedSelectors: ReadonlySet<NodeId> = selectedNodeIds;
  let nextRoundToolChoice: { name: string } | undefined;
  let earlyExit = false;
  if (mode !== 'read-only' && shouldRunIdentifyRound(message, selectedNodeIds)) {
    nextRoundToolChoice = { name: 'agent.identify' };
  }

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

      // Per-round tool_choice override — used to force agent.identify
      // for round 1 when the heuristic fires. Cleared after the round
      // completes so subsequent rounds use the LLM's own judgment.
      const roundToolChoice = nextRoundToolChoice;
      nextRoundToolChoice = undefined;

      await streamChatCompletion(config, {
        messages,
        tools: toolSchemas,
        toolChoice: roundToolChoice,
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
      // Wave C: when agent.proposePlan emits ops, the Mutator's
      // declared closure spec (carried in the JSON result) overrides
      // Wave A's selection-inferred spec for THIS round. Multi-mutator
      // rounds union the roots; the gate runs once over the merged ops.
      let mutatorClosureSpec: ClosureSpec | undefined;

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
        const toolStart = performance.now();
        const result = await executeToolCall(acc, toolDef, ctx, mode);
        const toolDuration = performance.now() - toolStart;
        const resultMessage = result.text ?? `OK (${result.ops.length} ops)`;
        // Wave D telemetry: tool name + outcome + duration only. No
        // args, no DAG content, no prompt text. Killswitch-respecting.
        recordEvent({
          kind: 'tool_call',
          toolName: acc.name,
          success: !resultMessage.startsWith('ERROR:'),
          durationMs: Math.round(toolDuration),
        });

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

          // Wave C: capture the Mutator-declared closure when
          // agent.proposePlan succeeds. The validator already ran the
          // five gates inside the tool — but propose() will run gate 3
          // again at the diff-store level, this time with the precise
          // Mutator-declared spec instead of the orchestrator's
          // selection-inferred fallback.
          if (acc.name === 'agent.proposePlan') {
            const spec = parseProposePlanClosureSpec(result.text);
            if (spec) {
              mutatorClosureSpec = mutatorClosureSpec
                ? unionClosureSpecs(mutatorClosureSpec, spec)
                : spec;
            }
          }
        }

        // Wave B Identify post-processing. The tool itself is read-only
        // (ops:[]) — what matters is the JSON in result.text, which the
        // orchestrator parses to commit / surface / reject the
        // resolution. Three branches:
        //   - match     → store selectors for closure scoping; thread a
        //                 user-side resolution note into the conversation
        //                 so subsequent rounds reference concrete ids.
        //   - ambiguous → surface candidate list to user; end turn.
        //   - no-match  → surface rationale; end turn.
        if (acc.name === 'agent.identify') {
          const parsed = parseIdentifyResult(result.text);
          if (!parsed) {
            // Resolver returned a non-JSON or unparseable payload. Treat
            // as a no-op (let the LLM proceed in regular rounds) — the
            // tool message has already been pushed for the LLM to see.
          } else if (parsed.type === 'match') {
            identifiedSelectors = new Set(parsed.selectors);
            const idList = parsed.selectors.join(', ');
            messages.push({
              role: 'user',
              content:
                `Identify resolved → ${idList} ` +
                `(strategy: ${parsed.strategy}, confidence ${parsed.confidence.toFixed(2)}). ` +
                `Subsequent ops should target these node ids exactly.`,
            });
          } else if (parsed.type === 'ambiguous') {
            const lines = parsed.candidates
              .map((c) => `  - ${c.id} (${c.nodeType})${c.summary ? ` — ${c.summary}` : ''}`)
              .join('\n');
            sessionStore.appendToLastAssistant(
              `\n\nI need disambiguation — multiple candidates match "${message}":\n${lines}\n\nReply with the id you want.`,
            );
            earlyExit = true;
          } else if (parsed.type === 'no-match') {
            sessionStore.appendToLastAssistant(
              `\n\nI couldn't resolve "${message}" — ${parsed.rationale}`,
            );
            earlyExit = true;
          }
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

      // Wave B: Identify resolution → ambiguous / no-match terminates the
      // turn (the user picks; next turn references the chosen one). The
      // assistant{tool_calls} ↔ role:'tool' pairing above is intact, so
      // exiting now never leaves a malformed conversation.
      if (earlyExit) break;

      // If mutation ops were produced → propose them as a diff and end the
      // turn. The user accepts/rejects via DiffBar.
      if (roundOps.length > 0) {
        mutationToolCallCount += roundMutationToolNames.length;
        const description = roundMutationToolNames.join(', ');
        // V13 closure-preservation. Precedence:
        //   1. Mutator-declared closure (Wave C) — exact, contract-driven.
        //   2. Selection / Identify-resolved roots (Wave A + B) — conservative fallback.
        //   3. None → vacuous gate (additive prompts).
        const closureSpec = mutatorClosureSpec ?? inferClosureSpec(identifiedSelectors);
        try {
          // F8: createFork can throw on op validation (unknown node, cycle,
          // type mismatch). Without try/catch the orchestrator never sets
          // streaming=false and the UI hangs.
          useDiffStore
            .getState()
            .propose(currentDagState, roundOps, description, roundOpSources, closureSpec);
        } catch (proposeErr) {
          if (proposeErr instanceof ClosurePreservationError) {
            // F6: thread the structured rejection back to the LLM as a
            // follow-up user message. The assistant{tool_calls} +
            // role:'tool' pairing already pushed in this round stays
            // intact — we just add context for round N+1. The model can
            // retry with ops scoped to the closure roots, dag.inspect to
            // explore, or surface to the user.
            const rootList = closureSpec!.rootSelectors.join(', ');
            const closureList = [...proposeErr.closure.nodes].join(', ');
            const retryMsg =
              `DIFF_REJECTED_BY_CLOSURE_GATE: op targeted node "${proposeErr.target}" ` +
              `outside the declared closure (roots: [${rootList}]; reachable: [${closureList}]). ` +
              `Retry with ops that only touch the listed closure nodes, OR call dag.inspect to ` +
              `find a different scope, OR explain to the user why the requested change is out of scope.`;
            messages.push({ role: 'user', content: retryMsg });
            sessionStore.appendToLastAssistant(`\n\n[Closure gate: ${proposeErr.message}]`);
            // Do NOT break — let the loop run another round so the LLM
            // can react. mutationToolCallCount stays incremented for
            // observability (the model did try to mutate).
            continue;
          }
          // F6: non-Closure errors from propose() (createFork validation —
          // unknown node, cycle, type mismatch) are also routed back to
          // the LLM as structured retry feedback. Without this branch,
          // the user saw "Diff proposal failed" with no path forward and
          // the LLM never got a chance to fix the plan. Bounded by
          // MAX_ROUNDS so we can't loop forever.
          const errMsg = (proposeErr as Error).message;
          const retryMsg =
            `DIFF_PROPOSAL_FAILED: createFork rejected the ops with: "${errMsg}". ` +
            `Common causes: op references an unknown node, introduces a cycle, ` +
            `or a setParam value mismatches the target's paramSchema. Inspect ` +
            `the DAG with dag.inspect, refine the plan, OR explain to the user ` +
            `why the requested change can't be applied.`;
          messages.push({ role: 'user', content: retryMsg });
          sessionStore.appendToLastAssistant(`\n\n[Diff proposal failed: ${errMsg}]`);
          // Loop another round so the LLM can react. mutationToolCallCount
          // stays incremented for observability.
          continue;
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
Op shape examples (use inside dag.exec's "ops" array). Tokens like
<sceneId> are PLACEHOLDERS — read the actual id from the Context
block's "Anchors" section (e.g. "scene → n_scene"). Never use the
literal string "scene", "render", "ground" etc. as a node id.

1. Add a red BoxMesh:
   {"type":"addNode","nodeId":"box1","nodeType":"BoxMesh","params":{"size":[1,1,1],"position":[0,1,0],"rotation":[0,0,0],"material":{"name":"default","color":"#ff0000"}}}

2. Wire into scene children (replace <sceneId> with the actual scene id):
   {"type":"connect","from":{"node":"box1","socket":"out"},"to":{"node":"<sceneId>","socket":"children"}}

3. Remove a node:
   {"type":"removeNode","nodeId":"box1"}

4. Change a param:
   {"type":"setParam","nodeId":"box1","paramPath":"material.color","value":"#00ff00"}

5. Disconnect:
   {"type":"disconnect","from":{"node":"box1","socket":"out"},"to":{"node":"<sceneId>","socket":"children"}}

Use lowerCamelCase for new nodeId values you create (e.g. "myCube",
"pointLight1"). For existing nodes, ALWAYS use the exact id from the
Context block or from a dag.inspect result.`;

  const paramTips = `
Quick conventions (full guidance in strategy resources — call agent.getStrategy):
- Positions/sizes in METERS, rotations in DEGREES, colors as "#rrggbb" hex.
- setParam paramPath supports dot paths: "material.color", "position", "rotation".
- Scene children use list connections: connect { from: {node: childId, socket: "out"}, to: {node: sceneId, socket: "children"} }
- mesh.add spawns primitives with NEUTRAL DEFAULTS — color/material/rotation/scale qualifiers go through Mutators in a follow-up agent.proposePlan call. Call agent.getStrategy({ topic: "spawnWithProperties" }) when the user names a property in an "add" prompt.
- For deeper guidance on units, materials, lighting, cameras, asset choice, spawn-with-properties: agent.listStrategies / agent.getStrategy({ topic }).`;

  return [
    `You are Basher's AI agent — a director-first assistant for procedural 3D scene authoring.`,
    `Mode: ${mode}`,
    ``,
    `Available tools:`,
    toolList,
    ``,
    `Rules:`,
    `- You NEVER mutate the scene directly. Mutation tools return Op[] that get proposed as a diff for the user to accept or reject.`,
    `- Prefer agent.proposePlan with a Mutator (mutator.rotate, mutator.translate, mutator.scale, mutator.setMaterialColor, mutator.duplicate, mutator.deleteNode) over raw dag.exec for common operations. Mutators run five validation gates BEFORE producing ops; rejection comes back as { ok: false, gate, reason } you can react to. Call agent.listMutators to see the registered catalog and contracts.`,
    `- Use dag.inspect when you need to discover node ids or types you don't already know.`,
    `- Use dag.exec only for ops the Mutator catalog does not cover (raw addNode/connect/disconnect for node types not yet wrapped, custom multi-step plans). Make sure new nodes are wired into the scene aggregator's "children" socket so they appear.`,
    `- The Context block lists "Anchors" — the project's named outputs (scene, render) resolved to their concrete node ids (e.g. "n_scene"). Use those exact ids when wiring connections. NEVER use the literal string "scene" or "render" as a node id; that's the placeholder NAME, not a real id.`,
    `- The user's current selection appears in the Context block at the start of each turn — prefer acting on selected nodes when the request says "this", "selected", "it".`,
    `- When the user references an existing node by description (e.g. "the cube", "the green sphere", "selected"), call agent.identify FIRST to resolve the reference to a concrete node id before constructing any Op. The orchestrator may force this call on round 1; receive a "match" with concrete ids, then act. If the result is "ambiguous" or "no-match" the turn ends — do not attempt to guess; the user will pick the candidate next turn.`,
    `- After agent.identify resolves a "match", a follow-up user message will state the concrete ids ("Identify resolved → ..."). Use ONLY those ids in subsequent ops; the closure-preservation gate rejects ops that target nodes outside the resolved scope.`,
    `- Describe your changes clearly so the user knows what you propose.`,
    `- If a tool call returns an ERROR, read the message and either retry with corrected args or explain to the user why it can't be done.`,
    opExamples,
    paramTips,
  ].join('\n');
}

function buildContextBlock(
  dagState: { nodes: Record<string, { type: string; params?: unknown }>; outputs: Record<string, { node: string; socket: string } | unknown> },
  selectedNodeIds: ReadonlySet<string>,
): string {
  const summary = summarizeDag(dagState.nodes, dagState.outputs);

  // Anchors block — resolve project-level named outputs (scene, render, ...)
  // into their concrete node ids. Closes H21 (agent invented "scene" as a
  // literal node id from prompt examples, not knowing the seed scene's
  // aggregator is "n_scene"). Surfacing this up front means the model
  // never has to guess.
  const anchorLines: string[] = [];
  for (const [name, ref] of Object.entries(dagState.outputs)) {
    if (ref && typeof ref === 'object' && 'node' in ref) {
      const r = ref as { node: string; socket: string };
      const node = dagState.nodes[r.node];
      const typeTag = node ? ` (${node.type})` : '';
      anchorLines.push(`  - ${name} → ${r.node}${typeTag}, socket "${r.socket}"`);
    }
  }
  const anchorsBlock = anchorLines.length > 0
    ? `Anchors (project named outputs — use these ids verbatim, do NOT use the names "scene"/"render" as node ids):\n${anchorLines.join('\n')}`
    : 'Anchors: (none — call dag.inspect to discover node ids)';

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

  return ['Context (current DAG state):', summary, '', anchorsBlock, '', selectionBlock].join('\n');
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

/**
 * Wave A's conservative closure inference: when the user has a selection
 * (or Wave B's Identify pre-stage committed selectors), scope mutations
 * to selectors ∪ parents ∪ children. No roots → no spec → vacuous gate
 * (additive prompts like "add a red cube" still work unchanged). Wave C
 * will replace this with Mutator-declared closures derived from each
 * mutator's contract.
 *
 * REF: P2.5.2 PLAN §5 Wave A.4 + Wave B.4; vyapti V13.
 */
function inferClosureSpec(
  rootIds: ReadonlySet<NodeId>,
): ClosureSpec | undefined {
  if (rootIds.size === 0) return undefined;
  return {
    rootSelectors: [...rootIds],
    followedEdges: ['parent', 'children'],
  };
}

/**
 * Wave B heuristic — should round 1 force agent.identify before any Plan
 * round runs?
 *
 * Rationale: forcing Identify on every prompt doubles latency for
 * additive requests ("add a red cube" doesn't reference any existing
 * node). This heuristic skips Identify when the prompt is purely
 * additive AND no selection is set; runs Identify when the prompt
 * contains pronouns ("this", "it", "the") or explicit selection
 * markers ("selected", "named", "with id"). When a selection exists,
 * default to running Identify so the orchestrator commits the resolved
 * selectors instead of acting on raw selection.
 *
 * REF: P2.5.2 PLAN §2 P-3 (latency mitigation), §5 Wave B step 3.
 */
export function shouldRunIdentifyRound(
  message: string,
  selectedNodeIds: ReadonlySet<NodeId>,
): boolean {
  const m = message.trim().toLowerCase();
  // Pure additive — skip.
  if (/^(add|make|create|spawn|insert)\s/.test(m)) return false;
  // Selective references — run.
  if (/\b(this|that|it|the|selected|chosen)\b/.test(m)) return true;
  // Explicit identifier markers — run.
  if (/\b(named|called|with id)\b/.test(m)) return true;
  // Default: run when there's a selection, skip otherwise.
  return selectedNodeIds.size > 0;
}

/**
 * Parse the JSON payload `agent.identify` returns into an
 * IdentifyResult. Returns null on any structural error — the
 * orchestrator falls back to "no Identify resolution" semantics
 * (no early exit, no committed selectors).
 */
function parseIdentifyResult(text: string | undefined): IdentifyResult | null {
  if (!text) return null;
  try {
    const obj = JSON.parse(text) as unknown;
    if (!obj || typeof obj !== 'object') return null;
    const t = (obj as { type?: unknown }).type;
    if (t === 'match' || t === 'ambiguous' || t === 'no-match') {
      return obj as IdentifyResult;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Extract the Mutator-declared ClosureSpec from agent.proposePlan's
 * success payload. Returns null on any structural mismatch — the
 * orchestrator falls back to selection-inferred closure.
 */
function parseProposePlanClosureSpec(text: string | undefined): ClosureSpec | null {
  if (!text) return null;
  try {
    const obj = JSON.parse(text) as unknown;
    if (!obj || typeof obj !== 'object') return null;
    const o = obj as Record<string, unknown>;
    if (o.ok !== true) return null;
    const roots = o.closureRoots;
    const edges = o.closureFollowedEdges;
    if (!Array.isArray(roots) || !Array.isArray(edges)) return null;
    return {
      rootSelectors: roots.filter((s): s is NodeId => typeof s === 'string'),
      followedEdges: edges as ClosureSpec['followedEdges'],
    };
  } catch {
    return null;
  }
}

/**
 * Union two ClosureSpecs by merging root selectors and edge kinds.
 * Used when a single round dispatches multiple agent.proposePlan
 * calls — every targeted node must be in the union of declared
 * closures (gate 3 then runs once over the combined ops).
 */
function unionClosureSpecs(a: ClosureSpec, b: ClosureSpec): ClosureSpec {
  return {
    rootSelectors: Array.from(new Set([...a.rootSelectors, ...b.rootSelectors])),
    followedEdges: Array.from(new Set([...a.followedEdges, ...b.followedEdges])) as ClosureSpec['followedEdges'],
    maxDepth: a.maxDepth ?? b.maxDepth,
  };
}
