# Basher

Director-first, agent-native, procedural video platform. The entire project —
geometry, characters, animation, render passes, and AI render jobs — is one
directed acyclic graph of typed, lazily-evaluated nodes. Every editing surface
(viewport, timeline, scene tree, inspector, agent chat) reads from and writes to
that single graph. Humans and AI agents edit through the same operations.

## Model

The system is built on one primitive: a **typed node in a DAG**, evaluated
lazily and deterministically for a given seed. Two consequences follow:

- **One source of truth.** The viewport, canvas timeline, scene tree, NPanel
  inspector, and agent transcript are all projections of the same graph. There
  is no separate scene format, animation format, or render format to keep in
  sync.
- **Deterministic evaluation.** Pure nodes are bit-exact reproducible. Caching,
  undo, and agent diffing all rely on a content hash that propagates through
  node inputs, so a change re-evaluates exactly the affected subgraph.

All mutation flows through five Op primitives — `addNode`, `removeNode`,
`connect`, `disconnect`, `setParam`. Stores never mutate state directly; agents
emit the same Ops a human action produces.

## Current capabilities

- **DAG core** — 42 registered node types, lazy evaluator with input-hash
  caching, versioned project schema with a migration runner, and OPFS-backed
  persistence.
- **Node library** — cameras (perspective/orthographic), five light types,
  meshes, groups/transforms, `ScatterNode`, and a glTF asset pipeline.
- **glTF import** — self-hosted Draco + Basis decoders (no CDN dependency),
  single-file `.glb`, multi-file `.gltf` + `.bin` + textures, skinned-mesh
  deformation, embedded TRS animation clip extraction, and disk import (drag a
  file/folder onto the viewport or **File → Import glTF…**) persisted in a
  reusable **My Imports** Library section.
- **Character & locomotion** — `Skeleton` / `PosedSkeleton` / `Character`,
  navmesh + `WalkPath` + `LocomotionState`, multi-character cache isolation.
- **Timeline & animation authoring** — keyframe channels (number / vec3 / quat /
  color), animation layers, clip selection, dopesheet + curve editor on a
  canvas-2D timeline, keyframe drag-to-retime, channel simplification (RDP),
  and BVH/FBX animation import with bone-name retargeting.
- **AI agent on the DAG** — natural-language requests resolve through an
  Identify → Mutator → Diff → apply pipeline. 17 Mutators (translate, rotate,
  scale, duplicate, keyframe, retarget, randomize, add render pass, …) and 9
  agent tools, all gated by a Diff preview before application.
- **Render graph** — Beauty / ID / Depth / Normal passes feeding a `RenderJob`.
- **AI render bridge** — ComfyUI workflow + Prompt nodes, a stylized-realism
  preset with Depth/Normal ControlNet inputs, and `VideoStitch` for assembling
  frames (WebCodecs with an ffmpeg-wasm fallback).
- **Editor** — Blender-style Add menu (Shift+A), transform gizmos tracking
  evaluated transforms, multi-select, NPanel inspector with drag-scrub, full
  menu bar with keyboard shortcuts, and a WCAG-audited design system.

`THESIS.md` is the design source of truth. Every PR references the section it
implements or amends.

## Quickstart

```bash
npm install
npm run dev          # http://localhost:5180
```

Verification scripts:

```bash
npm run typecheck    # strict TypeScript (tsc -b --noEmit)
npm run lint         # ESLint, incl. the purity rule on src/nodes/**
npm run format:check # Prettier
npm test             # Vitest unit suite
npm run test:e2e     # Playwright acceptance suite (29 specs)
npm run license-audit # dependency license gate
```

CI runs `lint` (ESLint + Prettier), `typecheck`, `test`, `test:e2e`, and
`license-audit`; all five gate merge.

## Layout

```
src/
  core/dag/          # types, 5 Op primitives, evaluator, hash, registry, store
  core/storage/      # StorageCapability + OpfsStorage / TauriStorage / MemoryStorage
  core/project/      # versioned schema, migration runner, save/load, default DAG
  core/import/       # glTF / BVH / FBX import chains + bone-name retargeting
  core/comfy/        # ComfyUI workflow types
  nodes/             # 42 node types (cameras, lights, meshes, time/animation,
                     # render passes, AI render bridge, aggregators) + registry
  agent/             # identify, mutators (17), tools (9), diff, strategy,
                     # session, telemetry, transport
  app/               # boot, Layout, stores, MenuBar, NPanel, AssetDropZone,
                     # AssetsPopover, Gizmo, asset/ (glTF import + OPFS resolver),
                     # animate/, character/, timeline/
  viewport/          # R3F Canvas + SceneFromDAG (recursive DAG -> primitives)
  timeline/          # canvas-2D TimelineCanvas, CurveEditor, geometry, selection
  render/            # PostFx (ACES + SMAA), pass/job/stitch runners, encoders
  a11y/              # WCAG contrast utilities
  integrations/blender/  # capability interface + browser-poll bridge
public/draco, public/basis  # self-hosted glTF decoders (THESIS §48: no CDN)
scripts/             # license audit, asset seeding, fixture generators
tests/e2e/           # Playwright specs
.anvi/               # dharana, vyapti, krama, hetvabhasa catalogues
THESIS.md            # design source of truth
```

## Disciplines

These are enforced, not aspirational:

- **The Op system is the only mutation path.** Stores never call `set` on graph
  state directly; every change is an Op, so human and agent edits share one
  applier, one undo stack, and one diff surface.
- **Pure nodes are bit-exact reproducible.** ESLint bans `Math.random`,
  `Date.now`, `performance.now`, `crypto.randomUUID`, `useFrame`, and `useThree`
  in `src/nodes/**`. Node ids are content-addressed over `(args, state)`.
- **Time enters as a typed socket.** Pure consumers wire their `time` input to
  the single `TimeSource` producer; its per-frame hash propagates through
  `inputHashes` to re-evaluate downstream nodes deterministically.
- **Project schemas are versioned with a migration runner.** A schema bump
  requires a migration before the next bump is allowed.
- **Capability interfaces decouple browser from native.** Storage and the
  Blender bridge are providers behind an interface; the Tauri swap is a provider
  change, not a rewrite.
- **Materials are data, not code.** `MaterialOverride` exposes preset PBR
  scalars; no shader-source surface ships in the current milestone.
- **Permissive licenses only.** `license-audit` is a CI gate. No GPL
  dependencies.

## Roadmap

Shipped: DAG foundation, node library + asset pipeline, character/locomotion,
the AI agent on the DAG, the timeline + animation authoring, the render graph,
the AI render bridge, and the editor design system. Animation import and glTF
disk import landed as follow-on work on the animation milestone.

Deferred: Gaussian Splat nodes, PlayCanvas export, and progressive onboarding
UX. See `THESIS.md` §37–47 for the original phase plan and the rationale behind
each cut or reorder.

## License

MIT. See [LICENSE](./LICENSE). Permissive dependencies only — enforced by CI.
