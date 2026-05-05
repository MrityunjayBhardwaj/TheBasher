# Basher

> A film is a graph that evaluates to a sequence of frames. The director —
> human, agent, or both — edits the graph. The graph evaluates the film.

Director-first, agent-native, procedural AI video platform.

**Status:** v0.5 P0 (Foundation + DAG core). Five node types, R3F viewport,
OPFS persistence, ACES + SMAA PostFx, dev-only Blender bridge.

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
  nodes/             # PerspectiveCamera, DirectionalLight, BoxMesh, Scene, RenderOutput
  app/               # boot, Layout (CSS-grid named regions), Mode/SelectionStore, Inspector
  viewport/          # R3F Canvas + SceneFromDAG (DAG → primitives)
  render/            # PostFx (ACES + SMAA), FpsMeter
  integrations/blender/  # capability + browser-poll bridge
tools/
  vite/              # vite-plugin-blender-mock (dev-only middleware)
  blender-companion/ # Python http.server companion script
.anvi/               # dharana, vyapti, krama, hetvabhasa catalogues
THESIS.md            # source of truth for v0.5
```

## Disciplines (active in P0)

- **Op system is the only mutation path.** Stores never set state directly.
- **Pure nodes are bit-exact reproducible.** Lint bans `Math.random` /
  `Date.now` / `performance.now` / `crypto.randomUUID` in `src/nodes/**`.
- **Time enters as a socket.** No closures, no globals.
- **Versioned node schemas + migration runner.** First bump triggers the
  first migration before the second bump is allowed.
- **Permissive licenses only.** `license-audit` is a CI gate. No GPL.
- **Capability interfaces decouple browser/native.** Storage and Blender
  bridge already follow this; v0.6 Tauri swap is a one-line provider change.

## Phase map (11 weeks to v0.5)

| Phase  | Description                      | Status      |
| ------ | -------------------------------- | ----------- |
| **P0** | **Foundation + DAG core**        | **shipped** |
| P1     | First node types + Asset Library | next        |
| P2     | Character + Move (as nodes)      |             |
| P2.5   | AI Agent on the DAG              |             |
| P3     | Timeline = animation nodes       |             |
| P4     | Render graph = render nodes      |             |
| P5     | AI Render Bridge                 |             |
| P6     | Splats node                      |             |
| P7     | PlayCanvas export                |             |
| P8     | Progressive UX + Demo            |             |

## License

MIT. See [LICENSE](./LICENSE). Permissive deps only — license posture is
enforced by CI.
