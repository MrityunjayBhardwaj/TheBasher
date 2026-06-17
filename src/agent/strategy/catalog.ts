// Strategy catalog — register/get/list. Ships with five starter
// resources covering units, materials, lighting, cameras, asset
// choice. Author additional resources by calling registerStrategy.
//
// Resources are inline-stringified (vs separate .md files) for v0.5
// to keep the bundle simple — Vite resolves them at build time. P3+
// can move to glob-loaded markdown files when the catalog grows.
//
// REF: P2.5.2 PLAN §5 Wave D step 8.

import type { StrategyResource, StrategyTopic } from './types';

const registry = new Map<StrategyTopic, StrategyResource>();

export function registerStrategy(resource: StrategyResource): void {
  if (registry.has(resource.topic)) {
    throw new Error(`Strategy already registered: ${resource.topic}`);
  }
  registry.set(resource.topic, resource);
}

export function getStrategy(topic: StrategyTopic): StrategyResource | undefined {
  return registry.get(topic);
}

export function listStrategies(): StrategyResource[] {
  return Array.from(registry.values());
}

/** Compact metadata view — drops the body. */
export interface StrategyMetadata {
  topic: StrategyTopic;
  description: string;
}

export function listStrategyMetadata(): StrategyMetadata[] {
  return listStrategies().map((s) => ({ topic: s.topic, description: s.description }));
}

export function __resetStrategyRegistryForTests(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// Starter resources (lifted from the orchestrator's inline paramTips +
// dcc-reference convention notes — Wave D leans the system prompt by
// moving these here).
// ---------------------------------------------------------------------------

const UNITS: StrategyResource = {
  topic: 'units',
  description: 'Units conventions: meters, degrees, hex colors.',
  body: `# Units convention

- **Positions and sizes** — meters. \`[1, 0, 0]\` = 1 meter on X.
- **Rotations** — DEGREES (X, Y, Z Euler), not radians. \`90\` = quarter-turn.
  This matches Blender / Unity / Unreal / Godot. The viewport converts
  to radians at the THREE.Euler seam (V12 enforced; H20 catalogued).
- **Colors** — CSS hex strings: \`"#ff0000"\`, \`"#00ff00"\`, \`"#5af07a"\`.
- **FOV** — vertical, in degrees (PerspectiveCamera default 45°).

When in doubt, consult \`.anvi/dcc-reference.md\` (20-section convention
table across DCCs + game engines + glTF).`,
};

const MATERIALS: StrategyResource = {
  topic: 'materials',
  description: 'PBR material parameters and override patterns.',
  body: `# Materials

Basher v0.5 ships PBR-only materials (V9 — materials = data, not code).
Shader authoring (TSL/OSL) is deferred to P4.

## Mesh inline material
Most meshes (BoxMesh, SphereMesh) carry a \`material\` block:
\`{ name: "default", color: "#5af07a" }\`. Only \`color\` is exposed in v0.5.

## MaterialOverride node
Wraps a child mesh and replaces its material. Params:
- \`name\` (string)
- \`color\` (hex)
- \`roughness\` (0..1, default 0.5)
- \`metalness\` (0..1, default 0)
- \`opacity\` (0..1, default 1)
- \`emissive\` (hex, default "#000000")
- \`emissiveIntensity\` (≥0, default 0)

Use MaterialOverride when you need to drive properties beyond color
(e.g. metallic surfaces, emissive panels). For simple recolours,
prefer \`mutator.setMaterialColor\` — it touches \`material.base.color\`
directly and runs the closure-preservation gate.`,
};

const LIGHTING: StrategyResource = {
  topic: 'lighting',
  description: 'Light type selection and intensity scaling.',
  body: `# Lighting

Basher ships five light types (P2.6+):
- **DirectionalLight** — sun analogue. Direction = \`rotation × (0, -1, 0)\`.
  Intensity ~1 for outdoor sun; can scale up for stylized lighting.
- **PointLight** — omnidirectional. Use for lamps, fires, candles.
  Intensity ranges 5–100 typical.
- **SpotLight** — cone, has \`angle\` + \`penumbra\` params.
- **AreaLight** — rectangle. \`width\` × \`height\` controls coverage;
  intensity multiplied by area (V10 scale-drives-power applies).
- **AmbientLight** — global fill, no position/rotation. Use sparingly.

## Editor vs render

\`viewportStore.shading === 'rendered'\` strips editor-only lighting
(EditorLights component). When composing a scene, switch to 'rendered'
to preview what the user actually sees on render output (B6 boundary —
editor-shading separated from DAG-render).

## Adding lights via the agent

Use \`mesh.add\` macro with kinds \`DirectionalLight\`, \`PointLight\`,
\`SpotLight\`, \`AreaLight\`, \`AmbientLight\`. Mirrors the user-facing
Add menu (Shift+A → Light). For color, pass it on the \`color\` param
directly — lights don't carry a \`material\` block.`,
};

const CAMERAS: StrategyResource = {
  topic: 'cameras',
  description: 'Camera framing, lens choice, FOV semantics.',
  body: `# Cameras

Two camera types in v0.5:
- **PerspectiveCamera** — \`fov\` (vertical, degrees, default 45),
  \`near\` (default 0.1), \`far\` (default 1000), \`position\`, \`lookAt\`.
- **OrthographicCamera** — \`zoom\`, \`near\`, \`far\`, \`position\`, \`lookAt\`.

## FOV cheat sheet (vertical, degrees)
- 20° — telephoto / zoomed-in. Compressed depth.
- 35° — typical "portrait" framing.
- 45° — default, neutral. Matches most film + game defaults.
- 60° — wide, slightly fish-eye. Action shots.
- 90°+ — extreme wide, distortion visible at edges.

## Snapshot vs author

\`camera.snapshot\` macro captures the current editor camera pose into
a new PerspectiveCamera DAG node and wires it to Scene.camera (K9
lifecycle). Use when the user says "save this view" or "frame this".

For explicit framing of a target node, compute camera position:
- Distance ≈ \`bbox_diagonal / (2 * tan(fov/2 * π/180))\`.
- LookAt at the target's center.

## Future (P3+)
\`camera.frameShot\` Mutator will auto-frame multiple targets.`,
};

const ASSET_CHOICE: StrategyResource = {
  topic: 'assetChoice',
  description: 'When to spawn library.import vs mesh.add vs (P5+) generate.',
  body: `# Asset choice

Three avenues for adding content:

## library.import (recommended for assets)
Drops a glTF asset from the project library. The user has curated
these — they're known good, animation-ready, materials baked. Use for:
- Characters
- Props (furniture, vehicles, vegetation)
- Buildings / sets

## mesh.add (procedural primitives)
Use for cubes, spheres, cameras, lights. Default sizes in meters.
Mirrors the Add menu (Shift+A) — same vocabulary the human uses.

## Procedural composition (dag.exec or Mutators)
For nodes that need explicit wiring (Scatter, MaterialOverride, Group,
Transform), compose with the appropriate Mutator or raw dag.exec.

## Coming in P5
\`generate.modelFromText({ prompt })\` — Hyper3D Rodin / Hunyuan3D bridge.
Async-job pattern (poll → import). Use when no library asset fits AND
the user asks for something stylized.

## Decision flow
1. User says "place a [thing]" → check library first (\`dag.inspect\`
   the assets list / use the Library panel hint).
2. If primitive (cube, sphere, light, camera) → \`mesh.add\`.
3. If novel asset request → defer to P5; for now, explain that
   external generation isn't wired and offer the closest library asset.`,
};

const SPAWN_WITH_PROPERTIES: StrategyResource = {
  topic: 'spawnWithProperties',
  description:
    'How to spawn a primitive with non-default properties (color, material, ' +
    'rotation, etc.) — chain mesh.add + the relevant Mutator.',
  body: `# Spawning with properties (compose pattern)

\`mesh.add\` spawns a primitive with **neutral defaults**. It does NOT
accept color, material, rotation, or other property qualifiers. The
boundary is intentional: per V14 (Mutator non-redundancy), property
changes go through Mutators — not through ever-growing surface params on
the spawn tool.

## When the user names a property

Examples that all need the compose pattern:
- "add a red sphere"
- "add a tilted cube" (rotation)
- "add a small box" (scale)
- "add a metallic sphere" (material — when materials Mutator lands)

## The chain

1. Call \`mesh.add({ kind, position })\` — the result text is JSON
   carrying \`newNodeId\` (the freshly spawned node's id). Read it.
2. Call \`agent.proposePlan\` with the matching Mutator and the
   \`newNodeId\` in \`targetSelectors\`. Common pairings:
   - color → \`mutator.setMaterialColor\` (\`color: "#rrggbb"\`)
   - rotation → \`mutator.rotate\` (\`axis, deltaDeg\`)
   - scale → \`mutator.scale\` (\`factor\`)

Both ops land in the same diff (atomic Cmd+Z).

## Issue both calls in the same round when possible

Tool calls within a single LLM round run in parallel for read-only
tools, but \`mesh.add\` is mutating — so \`agent.proposePlan\` typically
runs in the next round after \`mesh.add\`'s newNodeId is visible. That's
2 rounds for "add a red sphere" — comfortably inside the per-turn cap.

## What NOT to do

- Don't try to pass \`color\` to \`mesh.add\` — it will be ignored
  silently (the schema rejects unknown fields).
- Don't ask the user "what color?" if they already named it — they did.
- Don't dispatch a setMaterialColor Mutator before mesh.add returns —
  the new id doesn't exist yet.`,
};

const ANIMATION: StrategyResource = {
  topic: 'animation',
  description: 'How to animate a node — create a free-floating direct channel, append keyframes.',
  body: `# Animation (P3 — timeline = nodes)

Animation is data, not code. Every keyframe is a node; every channel is
a node; the timeline drawer renders projections of the DAG. The agent
authors animation by composing Mutators in the same shape as any other
edit.

Every animatable node is driven by FREE-FLOATING direct channels: a
\`KeyframeChannel<T>\` carries \`target\` (the node's dagId) + \`paramPath\`,
and a pure resolver (\`overlayChannels\`) overlays its sampled value on top
of the node — consumed by BOTH the renderer and the inspector (V57). There
is NO wrapper node: the animated node stays exactly where it is in the
scene; the channel reaches it by its \`target\` id, not a wire.

## The two-Mutator sequence

To animate \`<targetId>.<paramPath>\` from value v0 (at time t0) to v1
(at time t1):

1. **Create a typed channel + initial keyframe** (a single free-floating
   channel targeting the node — no layer, no wiring):
   \`\`\`json
   { "mutator": "mutator.timeline.addChannel",
     "spec": {
       "target": "<targetId>",
       "paramPath": "position",
       "valueType": "vec3",
       "channelId": "<targetId>_position_channel",
       "initialKeyframe": { "time": 0, "value": [0, 0, 0] }
     } }
   \`\`\`

2. **Append additional keyframes** (call once per sample, by channelId):
   \`\`\`json
   { "mutator": "mutator.timeline.keyframe",
     "spec": {
       "channelId": "<targetId>_position_channel",
       "time": 1,
       "value": [0, 2, 0]
     } }
   \`\`\`

The channelId is deterministic — \`<targetId>_<paramPath>_channel\` (with
non-alphanumerics → \`_\`) — so you can omit it on addChannel and still
reference it from later keyframe calls. Re-keying the same time replaces
the existing sample — no need for a "removeKeyframe" Mutator.

## Picking valueType

| paramPath example                    | valueType |
|--------------------------------------|-----------|
| \`position\`, \`rotation\`, \`scale\`, \`size\` | \`vec3\`    |
| \`intensity\`, \`fov\`, \`opacity\`        | \`number\`  |
| \`material.base.color\`                | \`color\`   |
| (rare; quaternion rigs)              | \`quat\`    |

## Easing defaults (no need to override unless asked)

- \`number\` → \`linear\` (predictable scrubbing on scalars)
- \`vec3\` / \`quat\` / \`color\` → \`cubic\` (smoothstep — natural spatial feel)

## "Bounce N times over D seconds"

A bounce is N up-down pairs over [0, D]. For a 3-bounce, 2-second loop
on the cube's Y position from ground (0) to peak (h):

- t=0    → [0, 0, 0]
- t=D/6  → [0, h, 0]    // up 1
- t=D/3  → [0, 0, 0]    // down 1
- t=D/2  → [0, h, 0]    // up 2
- t=2D/3 → [0, 0, 0]
- t=5D/6 → [0, h, 0]
- t=D    → [0, 0, 0]

Add the channel once (with the t=0 sample), then emit one keyframe
Mutator call per remaining sample. Cubic easing makes the bounce look
elastic; linear gives the cartoon stair-step look.

## What NOT to do

- Don't dispatch \`setParam\` directly on the target's position — that
  changes the static value, not the animation. Use a channel.
- Don't widen \`mesh.add\` with animation params — V14 says property
  changes go through Mutators, not the spawn tool.
- Don't call addChannel twice for the same (target, paramPath) — gate-4
  rejects the second with "channel already exists"; use keyframe to add
  more samples to the existing channel.
- Don't call keyframe before addChannel exists — gate-4 rejects with
  "channelId not in DAG".`,
};

const RENDERING: StrategyResource = {
  topic: 'rendering',
  description:
    'How to render frames to disk — RenderJob + addPass composition + per-frame summarize.',
  body: `# Rendering (P4 — render graph = render nodes)

Rendering is data, not code. Every render job is a node; every pass is a
node; the per-frame dispatch reads them and writes PNGs through
StorageCapability. The agent composes a render the same way it composes
any other edit.

## The two-step sequence

To render \`scene\` from \`camera\` for the next 2 seconds with a beauty +
id pass:

1. **Add a RenderJob via dag.exec** (no Mutator yet — RenderJob is opt-in
   and most projects don't seed one):
   \`\`\`json
   { "type": "addNode", "nodeId": "job",
     "nodeType": "RenderJob",
     "params": {
       "jobId": "my_job",
       "frameStart": 0,
       "frameEnd": 60,
       "fps": 30,
       "outputPath": "renders/my_job"
     } }
   \`\`\`

2. **Attach passes via mutator.render.addPass** (one Mutator per pass):
   \`\`\`json
   { "mutator": "mutator.render.addPass",
     "spec": { "jobId": "job", "passKind": "beauty" } }
   \`\`\`
   \`\`\`json
   { "mutator": "mutator.render.addPass",
     "spec": { "jobId": "job", "passKind": "id" } }
   \`\`\`

The Mutator auto-resolves the project's Scene + Camera + TimeSource and
wires all three into the new pass. If multiple Scenes / Cameras exist,
pass \`sceneId\` / \`cameraId\` explicitly.

## Pass kinds (v0.5)

| passKind  | Purpose                              | Format    |
|-----------|--------------------------------------|-----------|
| \`beauty\`  | Final composited RGB output         | rgba8     |
| \`id\`      | Per-object instance ID buffer       | rgba16f   |

Other passes from THESIS §43 (depth, normal, albedo, alpha, motionVector)
land in P5 / on demand — they're not in v0.5's pass catalog yet.

## Describing a frame

\`agent.render.summarizePass({ jobId, passKind, frame })\` returns the
pass's sourceHash + descriptor + the storage path it writes to. The
sourceHash flips when the scene, camera, params, or time change — equal
hash means equal pixels (V2 / §51 caching). Use this when the user asks
"is this frame different from frame N" or "what's the cost of rendering
this".

## What NOT to do

- Don't widen \`mesh.add\` or any spawn tool with render params — V14 says
  property changes go through Mutators, not the spawn tool.
- Don't dispatch directly to a pass node's params via setParam to "render
  it" — the pass evaluator returns metadata; actual frames write through
  the RenderJob's run side, not via DAG mutation.
- Don't add a RenderJob to a project that already has one without
  user confirmation — \`dag.inspect\` first; rendering jobs are sticky.
- Don't rely on a default \`outputPath\` — pass it explicitly. The default
  ("renders/job") collides if the project ever grows a second job.`,
};

// ---------------------------------------------------------------------------
// P5 Wave C — aiRender strategy resource (THESIS §28, §44).
// ---------------------------------------------------------------------------

const AI_RENDER: StrategyResource = {
  topic: 'aiRender',
  description:
    'AI render bridge — ComfyUI-mediated stylization presets, temporal coherence, cost preview, resume-on-failure.',
  body: `# aiRender — AI render bridge (P5)

The AI render bridge composes a stylization step on top of a RenderJob's
raw passes. ComfyUI runs locally; Basher feeds it raw frames + a prompt,
and reads stylized frames back. Temporal coherence is preserved by
conditioning each frame on the previous frame's stylized output.

## When to suggest the AI render bridge

- User says "stylize", "make it look like \${style}", "AI render", "anime",
  "concept art", "cinematic look".
- User has an existing RenderJob and wants the output stylized.
- User has a Beauty render and wants to know "what would this look like
  with stylized realism / anime / concept paint" — the dryRun probe is
  cheap; offer it.

Skip the AI bridge when:
- The user just wants raw renders (Beauty pass alone). RenderJob is enough.
- The user mentions specific shaders / materials / lighting tweaks —
  that's the rendering strategy resource, not aiRender.
- The user wants something the registered presets don't cover (e.g.
  3D-mesh-to-2D-line-art-only). Surface the gap; v0.6 adds meta-prompt
  preset authoring.

## Available presets (v0.5)

| presetId           | Required passes                | Demo case                             |
| ------------------ | ------------------------------ | ------------------------------------- |
| \`stylizedRealism\`  | Beauty + Depth + Normal        | Photoreal cube, golden hour           |

v0.6 adds anime + conceptPaint via meta-prompt authoring (THESIS §28).
Don't promise them in v0.5.

## How to wire an AI render pass

The agent's job is to compose three steps in order:

1. **Ensure the upstream RenderJob has the preset's required passes
   wired.** For \`stylizedRealism\`: Beauty + Depth + Normal must each
   land on the job's pass-input list. Use \`mutator.render.addPass\` for
   each missing pass kind.
2. **Add the AI pass.** \`mutator.render.addAIPass({ jobId, presetId,
   promptText, promptNegative? })\` adds a Prompt + ComfyUIWorkflow chain
   onto the job. The Mutator's preconditions reject if a required pass
   isn't already wired (the rejection diagnostic names the missing
   passes — call addPass for each, then retry).
3. **Optional: cost preview.** Call \`agent.render.dryRunWorkflow({
   workflowNodeId })\` to probe one frame and extrapolate. Useful for
   long renders. The probe writes the result to the canonical D-04
   path so the eventual full run cache-hits frame 0.

## Temporal coherence

Each frame N>0 is conditioned on frame N-1's stylized output via
ControlNet img2img on the prev-frame image. First frame uses a 1×1 black
zero-image. The execute layer (\`runComfyUIWorkflow\`) walks frames in
order — re-running with \`lastGoodFrame\` populated continues from the
next frame. Resume is automatic; the agent doesn't need to specify it.

## Cost preview

\`agent.render.dryRunWorkflow\` submits frame \`frameStart\` through
the configured ComfyUI capability, times it, and extrapolates. Returns
\`{ frames, estimatedSeconds, samplePath }\`. Surface the estimate AND
the sample path to the user — the sample frame is a real ComfyUI
output, not a mock.

## Failure modes

- **ComfyUI not running:** capability rejects; the agent should surface
  a clear error pointing at the ComfyUI server URL (default
  \`http://127.0.0.1:8188\`; settings override at \`comfyui.serverUrl\`).
- **Mid-frame failure:** \`runComfyUIWorkflow\` writes \`lastGoodFrame\`
  via the caller's setParam dispatch, then surfaces the error. User
  re-clicks "Render"; the function resumes from \`lastGoodFrame + 1\`.
- **Required pass not wired:** \`addAIPass\` precondition rejects with
  the missing-passes list in the diagnostic. Call \`addPass\` for each,
  retry.
- **Unknown preset:** schema enum rejects. v0.5 only registers
  \`stylizedRealism\`.

## Conventions

See \`.anvi/dcc-reference.md\` §21 (stylized render conventions) for the
authoritative answers on color space (sRGB PNG), frame numbering
(4-digit zero-pad), codec id (h264 / avc1.42E01F at the seam), prev-
frame placeholder name (\`prev_frame_image\`).

## Don't

- Don't author a new ComfyUI workflow JSON inline — register it as a
  preset in \`src/agent/strategy/presets/\`.
- Don't ship the prompt text as part of the workflow JSON — it's a
  Prompt node, the user can edit it without re-registering the preset.
- Don't request the AI render before the raw passes exist on disk — the
  preset's compile() reads pass bytes from the job's outputPath. Run
  \`runRenderJob\` first OR explain to the user that the order is "raw
  render first, then AI stylize."
- Don't expose the ComfyUI URL in chat unless the user asks. The
  default works for the standard local install.`,
};

export function registerAllStrategies(): void {
  registerStrategy(UNITS);
  registerStrategy(MATERIALS);
  registerStrategy(LIGHTING);
  registerStrategy(CAMERAS);
  registerStrategy(ASSET_CHOICE);
  registerStrategy(SPAWN_WITH_PROPERTIES);
  registerStrategy(ANIMATION);
  registerStrategy(RENDERING);
  registerStrategy(AI_RENDER);
}
