# AGENT.md — How the Agent Lives Inside Basher

> Canonical companion to `THESIS.md` Part IV (§18-25). Source-of-truth for
> how the AI agent is wired to the DAG today, what it can and can't do,
> and how its surface compounds with every node type and node graph
> connection that lands.
>
> **Status as of 2026-05-07 (P2.5 v2 + correctness train):** branch
> `feat/p2.5-agent-on-dag`. 6 tools registered. Multi-turn loop (max 4
> rounds). Mode enforcement live. OpenAI-spec-correct wire format
> (testable on Claude / GPT-4o via OpenRouter).

---

## Table of contents

1. [Why this design — the privileged-user thesis](#1-why-this-design)
2. [Architecture at a glance](#2-architecture-at-a-glance)
3. [The end-to-end turn lifecycle](#3-the-end-to-end-turn-lifecycle)
4. [The skill catalogue (today's six tools)](#4-the-skill-catalogue)
5. [Worked examples](#5-worked-examples)
6. [The compounding-value thesis — what every new node buys you for free](#6-the-compounding-value-thesis)
7. [Current limitations — what it can't do today](#7-current-limitations)
8. [Roadmap aligned with Basher's phase plan](#8-roadmap)
9. [References](#9-references)

---

## 1. Why this design

THESIS §18 is load-bearing: **the agent is a privileged user, not a
parallel system.** Every editing surface in Basher must collapse onto a
single contract — Op-as-the-only-mutation-path (V1). The agent sits on
the same Op dispatcher as a human dragging a slider, the same undo
ledger, the same Diff overlay, the same evaluator.

The cost of getting this wrong is invisible until P3-P8: every cross-
cutting feature (undo, save, replay, multiplayer, AI-render queue, export
to PlayCanvas) would have to handle "user-authored" and "agent-authored"
state separately. Two paths means two test matrices, two bug surfaces,
two memory models. The thesis collapses them by design.

The five concrete commitments that fall out of this:

| Commitment                    | Mechanism                                                    | Where enforced                |
| ----------------------------- | ------------------------------------------------------------ | ----------------------------- |
| Tool handlers return `Op[]`   | `ToolDefinition.handler: (args, ctx) => ToolResult`          | `src/agent/tools/types.ts`    |
| Agent never dispatches direct | Result.ops flow through `useDiffStore.propose` → fork        | `src/agent/orchestrator.ts`   |
| Diff is previewable           | `DiffOverlay` renders forked DAG semi-transparently in R3F   | `src/viewport/DiffOverlay.tsx`|
| Accept = single undo entry    | `acceptSelectedOps` calls `dispatchAtomic` (one InverseOp)   | `src/agent/diff/store.ts`     |
| Reject = zero state changes   | Fork is discarded; real DAG was never touched                | `src/agent/diff/forkedDag.ts` |

These five together are the **vyapti V7** invariant: agent tool handlers
return Ops, never call `dagStore.setState`. ALIGNED in P2.5.

---

## 2. Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────────┐
│                        AgentChat.tsx (UI)                            │
│  [Mode pill row]  [Message bubbles]  [Token bar]  [Input + Send]     │
│                                │                                     │
│           getLLMConfig()       │   selectionStore.selectedNodeIds    │
│                                ▼                                     │
└──────────────────────────────  │  ────────────────────────────────────
                                 │
                                 ▼
              ┌──────────────────────────────────────┐
              │      orchestrator.runAgentTurn        │
              │                                       │
              │  1. useDiffStore.reset()    (F7)      │
              │  2. filterToolsByMode       (A4)      │
              │  3. buildStaticSystemPrompt (A6)      │
              │  4. anchorHistory + buildContext (A8) │
              │                                       │
              │  for round 1..MAX_ROUNDS:             │
              │     stream LLM → text + tool_calls    │
              │     for each tool_call:               │
              │        fresh useDagStore state  (F2)  │
              │        validate via zod         (V7)  │
              │        run handler              (→Op[])
              │        push role:'tool' msg     (F1)  │
              │     if mutation ops produced:         │
              │        useDiffStore.propose     (F8)  │
              │        break                          │
              │     else: loop                        │
              │  enforce maxTurnTokens budget    (A5) │
              └──────────────────────────────────────┘
                  │              │              │
                  ▼              ▼              ▼
        transport/openai.ts   tools/registry.ts    diff/store.ts
        (SSE; provider shim)  (6 ToolDefinitions)  (fork + propose +
                                                    accept/reject)
                  │                                      │
                  ▼                                      ▼
        OpenAI / Anthropic /                     DiffOverlay (R3F ghost)
        DeepInfra / OpenRouter                   DiffBar (apply/reject)
```

The boundaries (catalogued in `.anvi/dharana.md`):

- **B3 — Agent ↔ DAG.** Tool handlers are the seam. They build Op[],
  they never dispatch.
- **B1 — Editor ↔ Evaluator.** The DiffOverlay reads the forked DAG and
  evaluates it inside R3F's render loop, alongside the live evaluation.
- **V11 — Selection state spans the wire.** Selected node IDs flow from
  `selectionStore` → `ToolContext` → system prompt. The LLM sees what
  the user has clicked.

---

## 3. The end-to-end turn lifecycle

### 3.1 Wire-format conversation

Each turn produces a sequence of messages on the OpenAI Chat Completions
wire (mirrored across DeepInfra, OpenRouter, Anthropic-compat shims).
Round 1 ships:

```jsonc
[
  { "role": "system", "content": "Static rules + tool catalogue + op examples …" },
  { "role": "user",   "content": "Context (DAG summary + selection block)\n\nUser request: …" }
]
```

If the LLM responds with text only → turn ends. If it emits tool calls,
round 2's payload is built by appending exactly what the spec requires:

```jsonc
[
  ...previous messages,
  { "role": "assistant", "content": "I need to look at the scene first.",
    "tool_calls": [{ "id": "call_a1", "type": "function",
                     "function": { "name": "dag.inspect", "arguments": "{\"scope\":\"all\"}" }}] },
  { "role": "tool", "tool_call_id": "call_a1",
    "content": "{\"nodes\":[{\"id\":\"box\",\"type\":\"BoxMesh\", … }], \"nodeCount\": 1}" }
]
```

Why this shape: OpenAI / Anthropic / Gemini all reject any conversation
that doesn't pair every `tool_calls` entry with a matching
`role:'tool'` reply via `tool_call_id`. The previous v1 implementation
appended tool results into a fake user message; that worked only on
DeepInfra+Gemma's permissive parser. Now the shape is statically
guaranteed by the discriminated `ChatMessage` union in
`src/agent/transport/types.ts`.

### 3.2 Round budget

| Mechanism            | Cap         | Source                         |
| -------------------- | ----------- | ------------------------------ |
| `MAX_ROUNDS`         | 4           | `orchestrator.ts:18`           |
| `maxTurnTokens`      | 30,000      | `orchestrator.ts:19` (tunable) |
| Per-stream timeout   | inherited from `fetch`/SSE — no separate timeout in v0.5 |
| Abort signal         | `AbortController` wired from chat input |

When the budget is exceeded mid-turn, the loop prints a cost-guard
notice into the assistant bubble and stops. Already-streamed text and
already-proposed diffs survive — no rollback.

### 3.3 What survives the turn

```
Session store            Diff store              DAG store
─────────────            ──────────              ─────────
- user message           - pendingDiff            (untouched until accept)
- assistant per round      = forkState
  (with tool result        + ops + opSources
   blocks inlined)         + selected[]
- token usage              + description
- error
```

Reject the diff → diff store goes back to idle; DAG never moved. Accept
the diff → `acceptSelectedOps` calls `dispatchAtomic(selectedOps,
'agent', description)` → one `InverseOp` lands in the undo stack → one
Cmd+Z reverts the entire turn. This is the K3 lifecycle (catalogued in
`.anvi/krama.md`).

---

## 4. The skill catalogue

Six tools today — two **universals** and four **macros**. The
universal/macro split is straight from THESIS §20: primitives that always
work, macros that emit primitive sequences for ergonomic operations.

### 4.1 dag.inspect — universal, read-only

**Purpose:** the agent's eyes. Without it, the LLM is reasoning from a
single context block and can't discover node IDs / node-type schemas
mid-turn.

**Why this design:** the alternative is dumping the entire DAG into
every system prompt. That's a token bill that grows linearly with scene
size. `dag.inspect` is opt-in: the model fetches what it needs when it
needs it. The four scopes are graduated:

| Scope    | Returns                                          | When the model picks it             |
| -------- | ------------------------------------------------ | ----------------------------------- |
| `all`    | Every node + outputs map                         | First contact / fresh session       |
| `node`   | One specific node's params + I/O bindings        | Drill-down on a known ID            |
| `output` | The `outputs` map (named anchors like `scene`)   | Need to find scene root             |
| `types`  | Every registered node type's param/IO schema     | Constructing addNode for a new type |

**Params:** `{ scope: 'all'|'node'|'output'|'types', nodeId?: string }`.
Default scope is `all`.

**Returns:** `{ ops: [], text: <JSON string> }`. Read-only — empty ops
array is the contract that this tool is non-mutating.

**Where it fails:** `scope:'node'` with a missing `nodeId` returns
`Error: ...` in the text field rather than throwing. The orchestrator
threads that into the LLM's tool-result message so the model can retry.

**REF:** `src/agent/tools/dagInspect.ts:25`.

### 4.2 dag.exec — universal, mutation

**Purpose:** the agent's hands. Every Op the system supports
(`addNode`, `removeNode`, `connect`, `disconnect`, `setParam`) flows
through here.

**Why this design:** there's exactly one mutation surface. If you wanted
to rename a node, change a material color, and disconnect a child, all
three go through `dag.exec`. The macros (mesh.add, library.import,
walkTo, snapshot) are *also* implemented as Op[] producers — they exist
purely for ergonomics, not because they have privileged access.

**Params:** `{ description: string, ops: Op[] }`. The `ops` array is
validated against the canonical `OpSchema` (`src/core/dag/types.ts`),
which is a Zod discriminated union. The schema is now correctly
serialized to JSON Schema (via `zod-to-json-schema`) and shipped to the
LLM as the tool's `parameters`, so the model can construct shapes
without having to memorize the spec.

**Returns:** `{ ops: <args.ops>, text: "Proposed N Op(s): <description>" }`.
The orchestrator forks and proposes; the user accepts or rejects.

**Where it fails:** zod validation rejects malformed Ops at the tool
boundary; if the ops parse but the fork's `applyOp` throws (cycle, type
mismatch, missing node), the error is caught by F8's try/catch and
surfaced into the chat. The LLM doesn't receive the failure as a tool
message in v0.5 — diff failures are terminal for the turn.

**REF:** `src/agent/tools/dagExec.ts:29`.

### 4.3 mesh.add — macro

**Purpose:** ergonomic spawn of a primitive. Saves the agent from having
to construct an addNode + connect-to-scene Op pair every time.

**Supported kinds:** `Cube`, `Sphere`, `DirectionalLight`, `PointLight`,
`SpotLight`, `AreaLight`, `AmbientLight`, `PerspectiveCamera`,
`OrthographicCamera`, `Group`, `Transform`. Mirrors the user-facing Add
menu so the agent and the human use the same vocabulary (Blender Shift+A
parity).

**Params:** `{ kind, position }`. Position defaults `[0, 0, 0]`.

**Why we kept it after `dag.exec` exists:** every primitive type needs
a different default param block (BoxMesh size [1,1,1] + material
preset, DirectionalLight intensity 1 + color #ffffff + rotation [0,0,0],
etc.). The macro centralizes those defaults via `buildAddPrimitiveOps`
— the same helper the human Add menu uses (V8: file-rooted, lives in
`src/app/`). Without the macro, the model has to look up
`paramSchema.parse` defaults for every type via `dag.inspect types` and
rebuild the addNode op from scratch. Net: shorter turns, cheaper tokens.

**Where it fails:** throws if the DAG has no `outputs.scene` (no
aggregator to connect into). The error surfaces as a tool error message
back to the LLM, which can then either dag.inspect to confirm or
explain to the user.

**REF:** `src/agent/tools/meshAdd.ts:37`.

### 4.4 character.walkTo — macro

**Purpose:** drive a Character node along a navmesh-aware path. The
human equivalent is right-click on the ground plane (`GroundClick`).

**Params:** `{ characterId: string, worldPoint: [x,y,z] }`.

**Why a macro and not a setParam:** the walkTo chain spans 2-4 ops:
addNode WalkPath → connect to LocomotionState → optionally disconnect
the previous WalkPath. The macro packages the whole sequence so the
agent emits one tool call instead of four. The implementation is
`buildWalkToOps` in `src/app/character/walkTo.ts` — same builder the
right-click handler uses (V8 file-rooted: dispatch lives in src/app/,
not src/viewport/).

**Where it fails:** missing character ID → `character not found`.
Missing Navmesh in the DAG → `missing Navmesh`. Missing
LocomotionState wired into the Character → same. Each is surfaced as a
tool error so the model can recover (e.g. dag.inspect to find a
Navmesh, then retry).

**REF:** `src/agent/tools/characterWalkTo.ts:22`.

### 4.5 camera.snapshot — macro

**Purpose:** capture the current editor camera pose into a new
`PerspectiveCamera` DAG node and wire it to `Scene.camera`. The human
equivalent is the View menu's "Camera from view" command (Cmd+Shift+C,
K9 lifecycle).

**Params:** `{ fov, position, lookAt }`. `position` is required so the
caller can capture the editor camera's current pose; `fov` defaults to
45°; `lookAt` defaults to `[0, 0, 0]`.

**Why it disconnects the existing camera:** Scene.camera is a single-
cardinality input. Adding without disconnecting first would violate the
DAG schema. The macro emits `disconnect → addNode → connect` as one
atomic 3-op chain. Reject the diff → no camera change. Accept → the
new camera is the live one and Cmd+Z reverts the swap.

**Where it fails:** no `outputs.scene` → throw. The wired Scene node
isn't actually a `Scene` type → throw (P6 hardening).

**REF:** `src/agent/tools/cameraSnapshot.ts:28`.

### 4.6 library.import — macro

**Purpose:** drop a glTF asset into the scene. The human equivalent is
dragging from the Library panel onto the viewport (K6 lifecycle).

**Params:** `{ assetRef: string, position?: [x,y,z] }`.

**Why a macro over `dag.exec`:** the asset-drop chain is 6 ops —
GltfAsset addNode + Transform addNode + connect + Group addNode +
connect + connect-to-scene — and the connection wiring depends on the
Group/Transform/Asset cardinality of each socket. Asking the LLM to
construct this from scratch every time is brittle and expensive. The
macro reuses `buildAssetDropOps` so the asset-drop path is byte-
identical whether a human or the agent triggers it.

**Where it fails:** no `outputs.scene` → throw. The asset itself isn't
loaded eagerly here; the GltfAsset node resolves the assetRef at
evaluator time. If the asset path is wrong, the failure surfaces in the
viewport's R3F error boundary (H16 catalogued). Future hardening: the
macro could `dag.inspect` the library to validate `assetRef` exists
before emitting the ops.

**REF:** `src/agent/tools/libraryImport.ts:26`.

---

## 5. Worked examples

Each shows the actual tool-call sequence the LLM emits and what lands
in the diff store.

### 5.1 "Add a red cube"

**Round 1 — model emits:**
```jsonc
{ "role": "assistant",
  "tool_calls": [{ "id": "c1", "function": {
    "name": "dag.exec",
    "arguments": "{\"description\":\"add red cube\",\"ops\":[
       {\"type\":\"addNode\",\"nodeId\":\"redCube1\",\"nodeType\":\"BoxMesh\",
        \"params\":{\"size\":[1,1,1],\"position\":[0,1,0],\"rotation\":[0,0,0],
                    \"material\":{\"name\":\"default\",\"color\":\"#ff0000\"}}},
       {\"type\":\"connect\",
        \"from\":{\"node\":\"redCube1\",\"socket\":\"out\"},
        \"to\":{\"node\":\"scene\",\"socket\":\"children\"}}]}"
  }}] }
```

**Tool result:** `Proposed 2 Op(s): add red cube`

**Diff store:** `pendingDiff = { ops: [addNode, connect], opSources:
['agent:dag.exec','agent:dag.exec'], description: 'dag.exec' }`.

**User clicks Apply →** `dispatchAtomic([addNode, connect], 'agent',
'dag.exec')` → one undo entry. Cmd+Z reverts both.

### 5.2 "Look at the scene, then add a sphere next to whatever's selected"

**Round 1 — model emits dag.inspect:**
```jsonc
{ "role": "assistant", "content": "Let me see the scene first.",
  "tool_calls": [{ "id": "c1", "function": {
    "name": "dag.inspect",
    "arguments": "{\"scope\":\"all\"}"
  }}] }
```

**Tool result (round 1):** the full DAG JSON. The model now sees the
selected node's params (selection block was already in round 1's user
message via `buildContextBlock`, but dag.inspect surfaces full I/O too).

**Round 2 — model emits dag.exec:**
```jsonc
{ "role": "assistant", "content": "I'll place a sphere at x=2 next to the selected cube.",
  "tool_calls": [{ "id": "c2", "function": {
    "name": "dag.exec",
    "arguments": "{\"description\":\"sphere next to selected\",\"ops\":[
       {\"type\":\"addNode\",\"nodeId\":\"sphere1\",\"nodeType\":\"SphereMesh\",
        \"params\":{\"radius\":0.5,\"position\":[2,1,0]}},
       {\"type\":\"connect\",
        \"from\":{\"node\":\"sphere1\",\"socket\":\"out\"},
        \"to\":{\"node\":\"scene\",\"socket\":\"children\"}}]}"
  }}] }
```

This is the multi-turn loop in action. The model needed information
between deciding-what-to-do and emitting-the-ops. Selection context
short-circuits the inspect step when the user's request is "this", "it",
"selected" — but for "next to", the model still needed coordinates.

### 5.3 "Walk the character to the red cube"

**Round 1 — dag.inspect (the model needs both the character ID and the
cube's position):**
- Tool result lists `char1 (Character)` and `redCube1 (BoxMesh)
  position: [0,1,0]`.

**Round 2 — character.walkTo:**
```jsonc
{ "tool_calls": [{ "id": "c2", "function": {
    "name": "character.walkTo",
    "arguments": "{\"characterId\":\"char1\",\"worldPoint\":[0,0,0]}"
  }}] }
```

The macro emits the WalkPath addNode + LocomotionState reconnect. The
character animates along the navmesh on accept. Time replay (V3) holds
because the WalkPath node is pure given (start, target, time).

### 5.4 "Make the camera look at the selected object"

Currently this requires the model to know the editor camera's pose.
Today's `camera.snapshot` only takes a target `position` + `lookAt` from
the model — there's no tool that reads the live R3F camera. Workaround:
the model uses `dag.inspect` to find the selected node's position, then
calls `camera.snapshot { position: [some-distance-back], lookAt: <that
position> }`. **Limitation:** model has to invent a camera position;
no auto-framing. See §7.

---

## 6. The compounding-value thesis

This is the single most important property of the architecture and
the reason it justifies its own document.

> **Every new node type, every new socket connection, every new param
> field added anywhere in Basher's DAG widens the agent's capabilities
> without any change to the agent code.**

Why: the agent surface is *derived* from the DAG, not coupled to it.
Three derivation paths:

### 6.1 Derivation #1 — `dag.inspect types` is the LLM's curriculum

When the model calls `dag.inspect { scope: 'types' }`, it gets every
registered NodeDefinition's:
- type name
- inputs (sockets + types + cardinalities)
- outputs (sockets + types)
- params summary (compacted JSON-schema view of the Zod schema)

So when P3 lands `KeyframeChannel<T>`, `Curve<T>`, `AnimationLayer`,
`Shot`, `Cut`, the agent automatically knows their shapes. No prompt
update. No code change. Build the node, register it, the agent can
construct it.

### 6.2 Derivation #2 — `dag.exec` is a single mutation surface

Every Op the registry validates is reachable through one tool. P3 adds
`KeyframeChannel`? `dag.exec [{addNode, nodeType:'KeyframeChannel<vec3>',
params:{…}}]` works without touching `dag.exec`. P4's render passes are
similarly trivial: addNode + connect Scene → BeautyPass + connect
BeautyPass → RenderJob.

The contract is at the Op layer, and the Op layer is closed (5 ops:
addNode, removeNode, connect, disconnect, setParam). Anything you
can express as a Basher graph is expressible by the agent.

### 6.3 Derivation #3 — selection + summarize scale with the graph

`buildContextBlock` (orchestrator.ts:330) renders selected nodes as
`{id, type, params}` for whatever the user has clicked. As more node
types join, the selection block grows naturally — no per-type code.
`summarizeDag` reports type counts; if you scatter 50 trees, the LLM
sees `Scatter×1, GltfAsset×3, Group×4` — proportionate context.

### 6.4 What this looks like phase by phase

| Phase shipped | Nodes added                                          | Agent capability gained (no code change) |
| ------------- | ---------------------------------------------------- | ----------------------------------------- |
| P0 (done)     | Scene, BoxMesh, RenderOutput, ...                    | Spawn meshes, set transforms, render-pass scaffolding |
| P1 (done)     | GltfAsset, Transform, Group, MaterialOverride, Scatter, Library | Drop assets, scatter geometry, override materials |
| P2 (done)     | Character, Skeleton, AnimationClip, LocomotionState, Navmesh, WalkPath, TimeSource | Place characters, animate locomotion, navmesh-aware paths |
| P2.6 (done)   | SphereMesh, all 4 light types with rotation+scale, EditorLights, AddMenu | Author lighting + mesh primitives via Add menu vocabulary |
| **P2.5 v2 (this branch)** | + `dag.inspect`, `dag.exec` universals; mode + diff + cost guards | Agent now has full DAG visibility AND single mutation surface |
| P3 (next)     | KeyframeChannel<T>, Curve<T>, AnimationLayer, Shot, Cut | **Agent can author keyframes, layered animations, shot lists** |
| P4            | BeautyPass, DepthPass, NormalPass, AlbedoPass, IDPass, AlphaPass, MotionVectorPass, RenderJob | Agent can compose render graphs, trigger renders |
| P5            | ComfyUIWorkflow, Prompt, VideoStitch                 | Agent can run AI restyle, estimate cost before dispatch |
| P6            | SplatAsset, SplatRender, SplatScatter, SplatAsset4D  | Agent can place 3DGS assets, scatter splats |
| P7            | (export-only — no new nodes, just a traversal)       | Agent can publish projects to PlayCanvas |

The pattern: **agent code stays roughly fixed; node code is where
intelligence accumulates.** This is THESIS §6 — eighty percent of
Basher is node definitions. The agent is one of the consumers of that
investment.

### 6.5 Animation end-to-end (P3 preview)

Right now (P2.5), you can ask the agent to add a moving character via
WalkPath. That works because P2 shipped LocomotionState + animation
clips as DAG nodes — locomotion-as-data.

When P3 lands, the agent will compose animation from primitives:

```
User: "Cube starts at [-3,1,0], moves to [3,1,0] over 2 seconds, ease-out."

Agent (round 1): dag.inspect types  →  sees KeyframeChannel<vec3>, Curve<vec3>
Agent (round 2): dag.exec
  ops: [
    { addNode, nodeId:'kfBox', nodeType:'KeyframeChannel<vec3>',
      params:{ keyframes:[
        {t:0, value:[-3,1,0]}, {t:2, value:[3,1,0], easing:'easeOut'}
      ]}},
    { connect, from:{node:'time', socket:'out'}, to:{node:'kfBox', socket:'time'}},
    { connect, from:{node:'kfBox', socket:'out'}, to:{node:'box1', socket:'positionAnim'}}
  ]
```

The `box1.positionAnim` socket lands in P3 alongside KeyframeChannel.
The agent constructs it from the type-listing alone — no agent-side
update needed. The dopesheet UI (P3) projects the same KeyframeChannel
nodes; the curve editor projects one channel and dispatches `setParam`
on bezier-handle drag. Three surfaces (agent, dopesheet, curve editor)
write to the same data.

---

## 7. Current limitations

What the agent can't do today, in priority order. Each is a candidate
for the roadmap in §8.

### 7.1 No animation tools

There's no `timeline.keyframe`, no `clip.play`, no curve editor surface
the agent can drive. P2 ships `LocomotionState` + `AnimationClip`, but
those are character-locomotion-shaped — they don't author per-property
animation on arbitrary nodes. **Lands in P3.**

### 7.2 No render / AI render tools

`dag.exec` can construct a BeautyPass node (once P4 ships it), but
there's no `render.shot` to trigger a render, no `render.estimateCost`
to preview AI restyle spend before dispatch. **Lands in P4-P5.**

### 7.3 No spatial reasoning

The agent doesn't see the viewport. It can't answer "where is the cube
relative to the character" without inferring from positions in
`dag.inspect`. THESIS §21.5 names vision-on-trigger ("this", "here",
"looks like") but the trigger isn't wired. **Wire `viewport.screenshot`
in P3 / P4.**

### 7.4 No project-level tools

Save / undo / redo / new-project / load-project aren't in the tool
catalogue. The agent can author scenes but can't move between them or
preserve state explicitly.

### 7.5 No persistence of conversation

`agent_sessions/<id>.json` from THESIS §23 isn't written. Reload =
fresh session. Cross-session memory (`agent_notes.md`) is also not
implemented.

### 7.6 No settings UI

API key / base URL / model are read from `.env` or `window.__BASHER_*`.
No in-app settings panel. Mode switcher exists; provider switcher does
not.

### 7.7 No autopilot mode

THESIS §22 names four modes; we ship three (read-only, copilot,
sandbox). Autopilot (operate without prompts within a token budget)
is v0.6.

### 7.8 No vision input

No screenshot-attach on triggers. No multimodal model support. The
LLM is text-only against the DAG context.

### 7.9 No multi-agent / no background tasks

One in-flight turn per chat. No agent that watches the scene and
suggests fixes. No agent that runs an AI render in the background and
reports when done.

### 7.10 No tool-error retry threading on diff propose failure

Most tool errors flow back as `role:'tool'` messages so the LLM can
retry (F6). The exception is `useDiffStore.propose` — when fork
validation fails (cycle, missing node, type mismatch), the F8 try/catch
prints the error to the chat but doesn't re-prompt the LLM with the
failure. **One-line fix in P3 hardening.**

### 7.11 No tool-call schema for vision-aware ops

`viewport.screenshot()` from THESIS §20 isn't a tool yet. Even if the
LLM supported vision, we'd need a tool that returns a base64 image so
the LLM can see what we see.

### 7.12 No domain validation beyond zod

`dag.exec` validates op shapes via OpSchema, but doesn't, e.g., check
that a `connect` from `out:Mesh` to `children:Light` is a type-
compatible socket pair before fork. The fork's `applyOp` does that
check, and it throws — F8 catches and surfaces — but a pre-fork
sanity pass would yield friendlier error messages to the model.

### 7.13 No memory of accepted vs rejected diffs

When the user rejects a diff, the model doesn't see "the user rejected
your previous proposal because of X". It sees the conversation history
but not the rejection signal. Future: thread "rejected" / "accepted"
back as tool-result messages.

### 7.14 No node-aware naming

The model invents nodeIds (`box1`, `redCube1`). They survive but they
don't follow any project convention. Future: a tool that allocates
unique IDs from the registry's existing IDs to avoid collisions.

---

## 8. Roadmap

Aligned with THESIS Part VII (§37-47). The agent's deltas per phase:

### 8.1 P3 — Timeline = animation nodes (next)

**Node types added:** `KeyframeChannel<T>`, `Curve<T>`, `AnimationLayer`,
`Shot`, `Cut`, plus `*Anim` input sockets on existing nodes
(BoxMesh.positionAnim, light.intensityAnim, etc.).

**What the agent gets for free** (no agent code change):
- Authoring keyframes via `dag.exec` with `addNode KeyframeChannel<vec3>` ops.
- Composing animation layers (e.g., walk-cycle layer + look-at-target layer additively).
- Constructing Shots and Cuts as DAG nodes — agent can describe the cut, build the shot.

**New tools to add:**
- `timeline.keyframe(targetNodeId, paramPath, time, value, easing?)` —
  ergonomic macro that creates the channel + connects time + connects to
  the target's `*Anim` socket. Same builder the dopesheet UI uses.
- `timeline.addLayer(channelIds, mask?)` — wrap channels in an
  AnimationLayer with bone-mask support.
- `camera.frameShot(targetNodeIds, framing?)` — auto-frame a list of
  nodes by computing a camera pose. **Closes §7.3 partially.**
- `shot.create(cameraId, startTime, duration, description)` — shot
  composition. Sister to Shot/Cut nodes.

**P3 acceptance for the agent:** "make the cube wave back and forth
over 4 seconds, smoothly" → KeyframeChannel constructed → diff preview
shows ghost trajectory in viewport → accept → animation plays in
viewport, scrubs in dopesheet. "Frame the character + cube together"
→ camera.frameShot → diff shows new camera pose → accept.

### 8.2 P4 — Render graph = render nodes

**Node types added:** BeautyPass, DepthPass, NormalPass, AlbedoPass,
IDPass, AlphaPass, MotionVectorPass, RenderJob.

**What the agent gets for free:**
- Constructing render graphs via dag.exec (compose passes onto a
  Scene+Camera).
- Reading render results for context (RenderOutput already shipped).

**New tools:**
- `render.shot(shotId)` — trigger a single shot's RenderJob.
- `render.preview(passType)` — quick low-res preview of a single pass
  for context.
- `render.estimateCost(jobId)` — required before AI render dispatch
  per THESIS §24.

### 8.3 P5 — AI Render Bridge

**Node types added:** ComfyUIWorkflow, Prompt, VideoStitch.

**New tools:**
- `render.aiRestyle(workflowNodeId, frames?)` — execute the workflow.
  Cost preview enforced.
- `prompt.suggest(scene)` — propose a stylized prompt from current scene
  contents. Uses vision input (P3+).
- `viewport.screenshot()` — finally land THESIS §20's vision input.
  Even on text-only models, this lets the agent claim "I'm looking at
  the scene" honestly.

### 8.4 P6 — Splats

**Node types added:** SplatAsset, SplatRender, SplatScatter,
SplatAsset4D.

**No new agent tools needed** — splats are `dag.inspect types` material.
The agent can place / scatter / animate splats from the type listing
alone.

### 8.5 P7 — PlayCanvas export

**No new node types** (export is a traversal).

**New tool:**
- `publish.toPlayCanvas(projectName)` — bake the evaluated DAG to a
  PlayCanvas scene JSON + assets bundle.

### 8.6 P8 — Progressive UX + Demo

**Agent deltas:**
- Mode switcher integrates with the agent's mode pill — Director mode
  defaults agent to copilot, Pro to read-only, Simple to copilot with
  more aggressive auto-accept.
- 60-second guided tour includes one agent-driven step.

### 8.7 v0.6+

- **Autopilot mode** (THESIS §22, mode #4).
- **Agent persistence** — `agent_sessions/<id>.json` + `agent_notes.md`.
- **Multi-agent / background tasks** — render-watching agent, diff-
  scrubbing agent, "what's missing" agent.
- **Settings UI** — provider switcher, model picker, key entry, budget
  slider.
- **CRDT multiplayer** — agent + multiple humans editing concurrently
  via Yjs.

---

## A. Conventions

| Quantity   | Storage (DAG params) | THREE.js seam        | UI display                      |
| ---------- | -------------------- | -------------------- | ------------------------------- |
| Position   | meters               | meters (passthrough) | meters                          |
| Size       | meters               | meters (passthrough) | meters                          |
| Rotation   | **degrees**          | radians (converted)  | degrees (Inspector + Gizmo)     |
| Color      | CSS hex (`#rrggbb`)  | hex / Color          | swatch + hex                    |

**Why degrees:** every modern DCC and game engine (Blender, Maya, 3ds Max,
Cinema 4D, Houdini, Unity, Unreal, Godot) stores user-facing rotation as
degrees because `45`, `90`, `180` are readable while `π/4`, `π/2`, `π`
are not. THREE.js's `Object3D.rotation` is radians, so we convert at the
seam in `src/viewport/rotation.ts` (`degVec3ToRad` / `radVec3ToDeg`).

The agent's system prompt declares this convention so the LLM emits
`rotation: [90, 0, 0]` for a quarter-turn. Same as a human typing it.

**Catalogued as H20** in `.anvi/hetvabhasa.md` (rotation units mismatch —
agent wrote degrees, renderer treated as radians, visual was at
116.6° instead of 90°).

---

## 9. References

| Source                              | Topic                                                  |
| ----------------------------------- | ------------------------------------------------------ |
| `THESIS.md` §18-25                  | Agent thesis, modes, memory, guardrails                |
| `THESIS.md` §41                     | P2.5 phase plan (this milestone)                       |
| `THESIS.md` §50                     | Op system as the only mutation path (V1)               |
| `.anvi/dharana.md` §B3              | Boundary observation targets, silent-failure modes     |
| `.anvi/vyapti.md` V7, V11           | Tool handler purity, selection wiring                  |
| `.anvi/hetvabhasa.md` H10, H17, H18, H19 | Zustand snapshot pitfalls, tool-call accumulator,
                                      JSON-Schema converter, stale-snapshot in orchestrator     |
| `.anvi/krama.md` K3                 | Agent tool dispatch lifecycle                           |
| `src/agent/orchestrator.ts`         | The turn engine                                         |
| `src/agent/transport/openai.ts`     | SSE + provider shim                                     |
| `src/agent/tools/`                  | Six tool implementations                                |
| `src/agent/diff/`                   | Fork + propose + accept/reject                          |
| `src/app/AgentChat.tsx`             | Chat UI                                                 |

---

**Updates to this doc** are required whenever:
- A tool is added or removed (update §4 catalogue + §6.4 phase table).
- The wire format changes (update §3.1).
- A limitation is closed (move from §7 to "shipped" line in §8).
- A new boundary is catalogued in dharana (update §2 architecture map).
