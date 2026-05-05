# Basher

> A film is a graph that evaluates to a sequence of frames. The director —
> human, agent, or both — edits the graph. The graph evaluates the film.

Director-first, agent-native, procedural AI video platform.

**Status:** v0.5 P2.6 (Editor polish: toolbar + shading + UV scaffold).
TransformToolbar across the top (Move/Rotate/Scale + Snap + Studio/Rendered
shading + 3D View/UV Editor space). Editor-only studio fill rig so dim
DAGs are still visible while editing — Rendered mode reverts to DAG-only
lights for production parity. Read-only UV editor scaffold for BoxMesh.
On top of P2.1: selection multi-select, click-to-pick, Inspector
drag-scrub, NPanel overlay, File/Edit/Select/View menu bar with keyboard
shortcuts, camera-from-view, Frame Selected (F) / Frame All (Home). P2
ships 23 node types, Time as a typed socket (V3 ALIGNED), the Character
+ walkTo chain, multi-character cache isolation, scrubbable playhead.
P0+P1 still ships: R3F viewport with recursive Mesh dispatcher,
OPFS-backed asset library, drag-drop import, scene tree, TransformControls
gizmo, deterministic ScatterNode.

## What is this

Three failure modes for AI video tools today:

- **Sora-class:** the model does everything; the director is a passenger.
- **Blender + AI plugins:** the director does everything; AI is a render filter.
- **Theatre.js + R3F from scratch:** months of plumbing.

Basher commits to a single primitive — **a typed, lazily-evaluated node in a
DAG with deterministic evaluation given a seed.** Every surface (viewport,
timeline, scene tree, chat) is a projection of that one DAG. AI agents and
humans both edit through the same five Op primitives.

Read [THESIS.md](./THESIS.md) for the full argument, the plan, and the
disciplines. Every PR references the section it implements or amends.

## Quickstart

```bash
npm install
npm run dev          # http://localhost:5180
```

```bash
npm run typecheck    # strict TS
npm run lint         # ESLint, incl. V2 purity rule on src/nodes/**
npm test             # vitest unit suite
npm run test:e2e     # playwright acceptance tests
npm run license-audit
```

## Layout

```
src/
  core/dag/          # types, ops (5 primitives), evaluator, registry, store
  core/storage/      # StorageCapability + OpfsStorage / TauriStorage / MemoryStorage
  core/project/      # schema (versioned), migrations runner, save/load, default DAG
  nodes/             # 23 node types: cameras, lights, meshes (P0+P1) plus the P2
                     # Time chain — TimeSource (the impure singleton), Skeleton,
                     # PosedSkeleton, AnimationClip, Navmesh, WalkPath,
                     # LocomotionState, Character. All pure where possible.
  app/               # boot, Layout (CSS-grid), Clock (rAF), Timebar (scrub),
                     # Library, AssetDropZone, SceneTree, Gizmo, Inspector,
                     # mode/selection/time stores, asset/{catalog, seedOpfs,
                     # opfsLoader, dropChain}, character/{walkTo, GroundClick}
  viewport/          # R3F Canvas + SceneFromDAG (recursive DAG → primitives)
  render/            # PostFx (ACES + SMAA), FpsMeter
  integrations/blender/  # capability + browser-poll bridge
tools/
  vite/              # vite-plugin-blender-mock (dev-only middleware)
  blender-companion/ # Python http.server companion script
.anvi/               # dharana, vyapti, krama, hetvabhasa catalogues
THESIS.md            # source of truth for v0.5
```

## Disciplines (active in P0 + P1 + P2)

- **Op system is the only mutation path.** Stores never set state directly.
- **Pure nodes are bit-exact reproducible.** Lint bans `Math.random` /
  `Date.now` / `performance.now` / `crypto.randomUUID` / `useFrame` /
  `useThree` in `src/nodes/**`.
- **Time enters as a socket (V3 ALIGNED, P2).** Pure consumers (Animation
  Clip / PosedSkeleton / LocomotionState / Character) wire their `time`
  input to the `TimeSource` singleton — the only impure time producer.
  TimeSource's hash flips per frame, propagating through `inputHashes` to
  re-evaluate every downstream pure node bit-exactly.
- **Versioned node schemas + migration runner.** First bump triggers the
  first migration before the second bump is allowed.
- **Permissive licenses only.** `license-audit` is a CI gate. No GPL.
- **Capability interfaces decouple browser/native.** Storage and Blender
  bridge already follow this; v0.6 Tauri swap is a one-line provider change.
- **Materials are data, not code (V9, P1).** `MaterialOverride` exposes
  preset PBR scalars only — no shader source surface in v0.5. TSL deferred
  to P4 per `.anvi/dharana.md` §3.

## Phase map (11 weeks to v0.5)

| Phase  | Description                                     | Status      |
| ------ | ----------------------------------------------- | ----------- |
| **P0** | **Foundation + DAG core**                       | **shipped** |
| **P1** | **First node types + Asset Library**            | **shipped** |
| **P2** | **Character + Move (as nodes)**                 | **shipped** |
| P2.1   | Viewport polish + menu bar                      | **shipped** |
| P2.6   | Editor polish (toolbar + shading + UV scaffold) | **shipped** |
| P2.5   | AI Agent on the DAG                             | next        |
| P3     | Timeline = animation nodes                      |             |
| P4     | Render graph = render nodes                     |             |
| P5     | AI Render Bridge                                |             |
| P6     | Splats node                                     |             |
| P7     | PlayCanvas export                               |             |
| P8     | Progressive UX + Demo                           |             |

## License

MIT. See [LICENSE](./LICENSE). Permissive deps only — license posture is
enforced by CI.
