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
prefer \`mutator.setMaterialColor\` — it touches \`material.color\`
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
  description:
    'How to animate a node — wrap with AnimationLayer, add a typed channel, append keyframes.',
  body: `# Animation (P3 — timeline = nodes)

Animation is data, not code. Every keyframe is a node; every channel is
a node; the timeline drawer renders projections of the DAG. The agent
authors animation by composing Mutators in the same shape as any other
edit.

## The three-Mutator sequence

To animate \`<targetId>.<paramPath>\` from value v0 (at time t0) to v1
(at time t1):

1. **Wrap the target in an AnimationLayer** (skip if it's already
   wrapped — \`dag.inspect\` to confirm):
   \`\`\`json
   { "mutator": "mutator.timeline.addLayer",
     "spec": { "targetSelectors": ["<targetId>"], "layerIds": ["<targetId>_layer"] } }
   \`\`\`

2. **Add a typed channel + initial keyframe** (creates the channel and
   wires it to the layer's animation socket + the project TimeSource):
   \`\`\`json
   { "mutator": "mutator.timeline.addChannel",
     "spec": {
       "layerId": "<targetId>_layer",
       "target": "<targetId>",
       "paramPath": "position",
       "valueType": "vec3",
       "channelId": "<targetId>_position_channel",
       "initialKeyframe": { "time": 0, "value": [0, 0, 0] }
     } }
   \`\`\`

3. **Append additional keyframes** (call once per sample):
   \`\`\`json
   { "mutator": "mutator.timeline.keyframe",
     "spec": {
       "channelId": "<targetId>_position_channel",
       "time": 1,
       "value": [0, 2, 0]
     } }
   \`\`\`

Re-keying the same time replaces the existing sample — no need for a
"removeKeyframe" Mutator.

## Picking valueType

| paramPath example                    | valueType |
|--------------------------------------|-----------|
| \`position\`, \`rotation\`, \`scale\`, \`size\` | \`vec3\`    |
| \`intensity\`, \`fov\`, \`opacity\`        | \`number\`  |
| \`material.color\`                     | \`color\`   |
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

Emit one keyframe Mutator call per sample. Cubic easing makes the bounce
look elastic; linear gives the cartoon stair-step look.

## What NOT to do

- Don't dispatch \`setParam\` directly on the target's position — that
  changes the static value, not the animation. Use a channel.
- Don't widen \`mesh.add\` with animation params — V14 says property
  changes go through Mutators, not the spawn tool.
- Don't create a second AnimationLayer wrapping an already-wrapped
  target — addLayer's gate-4 rejects with a pointer to addChannel.
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

export function registerAllStrategies(): void {
  registerStrategy(UNITS);
  registerStrategy(MATERIALS);
  registerStrategy(LIGHTING);
  registerStrategy(CAMERAS);
  registerStrategy(ASSET_CHOICE);
  registerStrategy(SPAWN_WITH_PROPERTIES);
  registerStrategy(ANIMATION);
  registerStrategy(RENDERING);
}
