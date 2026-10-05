// Project file format. Versioned schema (V4): every saved project carries
// a `formatVersion` and `nodeVersions` so future schema bumps run through
// the migration ladder rather than crashing on load.
//
// V0.5 ships formatVersion=1 only. The first node-type version bump (P3+)
// triggers the first migration; the runner is wired and tested today.
//
// formatVersion=2 (v0.7 #199): retires the AnimationLayer wrapper. A v1 file is
// rewritten by the `migrateAnimationLayers` FORMAT migration (runs on raw JSON
// BEFORE this schema parses) — each layer's edges are reversed onto the wrapped
// node, its channels re-targeted + their gate/blend folded on, and the layer
// node deleted. After it runs no AnimationLayer node exists, so the (now-removed)
// node type is never looked up. REF: docs/UNIFICATION-DESIGN.md §4; krama K5.
//
// formatVersion=3 (object↔data split, #365 Phase 5a): a fused `BoxMesh` is split
// into an `Object` (owns the transform — INHERITS the old id, so every channel /
// constraint / selection / edge that named the box still resolves) + a fresh
// `BoxData` (owns geometry `size` + material). `migrateFusedBoxToSplit` runs on
// raw JSON BEFORE this schema parses; it normalizes each box through BoxMesh's
// own version ladder first (so a v2-era material keeps its byte-identical look),
// re-targets `size`/`material.*` channels to the data node, and leaves
// `position`/`rotation`/`scale` channels on the inherited-id Object.
// REF: docs/OBJECT-DATA-SPLIT-DESIGN.md §5; krama K5.
//
// REF: THESIS.md §52, vyapti V4, krama K5.

import { z } from 'zod';
import { NodeSchema, NodeIdSchema, NodeRefSchema } from '../dag/types';

// v4 (#384 Stage C · C1): split each fused SphereMesh into Object + SphereData —
// the per-kind repeat of the v3 box split. See migrations.ts formatMigrations[3].
// v5 (#385 Stage C · C2): split each fused Curve into Object + CurveData (the FIRST
// non-mesh data). See migrations.ts formatMigrations[4].
// v6 (#386 Stage C · C3): split the four posable lights into Object + LightData (the
// SECOND non-mesh data; AmbientLight stays fused). See migrations.ts formatMigrations[5].
// v7 (#387 Stage C · C4): split the two fused cameras into Object + CameraData (the
// THIRD non-mesh data, and the first kind whose renderer never reads the evaluated
// value — the pose road reads the pair's raw params). See migrations.ts
// formatMigrations[6].
// v8 (#388 Stage C · C5): split each fused `BakedMesh` into Object + BakedData — the
// last node that still minted a fused pair, and the FIRST data half that is genuinely
// render geometry without riding the `MeshData` road (an OPFS-persisted buffer reached
// asynchronously, not a recipe rebuilt from params). See migrations.ts
// formatMigrations[7].
// v9 (#609): fold each `ParamDriver`'s `inVec` binding onto its `in` socket — a socket
// id is a persisted binding key, so it cannot ride the per-node ladder. See
// migrations.ts formatMigrations[8].
// v10 (#915): drop the per-bone channels the retired eager bake wrote and nobody
// authored. They carry no Cycles modifier, so they HOLD past the clip's duration where
// the clip they copied WRAPS — every project saved before copy-on-write (#889) freezes
// its whole rig at the end of the first cycle. Only channels bit-identical to a
// re-derivation from their own bound clip are dropped; anything edited is kept. See
// migrations.ts formatMigrations[9].
// v11 (#920): drop the `TimeSource -> AnimationClip.time` binding the import chains used
// to write. The node no longer declares a `time` input — a clip is a description, not a
// sample at an instant — but the evaluator resolves a node's OWN saved bindings rather
// than its definition's declared inputs, so the dead edge is still followed and its hash
// still lands in the cache key. Measured over ten frames: with the edge, ten distinct
// cache entries; without it, one. Left in place the clip re-evaluates every frame and the
// cache grows without bound, which is the cost #920 exists to remove. See migrations.ts
// formatMigrations[10].
// v12 (#930): one vocabulary for what a clip does past its last key. `loop` was a BOOLEAN
// on `AnimationClip` whose `true` meant cycle-WITH-OFFSET, and `'loop' | 'clamp'` on
// `TransformClip` — two spellings with OPPOSITE defaults, and cycle-in-place had no
// spelling at all. The value is persisted, so the pass writes every stored clip's
// behaviour EXPLICITLY; that is what makes changing the schema default safe, and it is
// why `true` maps to `cycle-offset` rather than `cycle` — plain `cycle` would take the
// travel out of every stored walk. See migrations.ts formatMigrations[11].
// v13 (#389 Stage C · C6): split each fused `GltfChild` into Object + GltfData. Its OWN
// format version for the same reason as every split above: a project saved at an earlier
// version carrying a fused imported child would never re-run an earlier pass, so its child
// would never split — and unlike the earlier kinds there is no fused fallback left to
// render it, because `GltfChild` retires in the same change. See migrations.ts
// formatMigrations[12].
// v15 (#1203): an armature Object carries the clip that poses it on an `action` edge. The band
// used to choose the pose by a rule; a saved rig would stop playing without the pass that writes
// the rule down as the edge. See migrations.ts formatMigrations[14].
// v16 (#1224): the armature Object takes the pose wire — `action` (a clip) becomes `pose`, and each
// saved edge is re-pointed to its producer's pose output. See migrations.ts formatMigrations[15].
// v17 (#1225): the retarget reads the pose wire — `RetargetClip.sourceClip` becomes `source`, each
// saved edge re-pointed to its producer's pose output. See migrations.ts formatMigrations[16].
// v18 (#1225): locomotion reads the pose wire — `LocomotionState.clip` becomes `pose`, re-pointed
// the same way. See migrations.ts formatMigrations[17].
// v19 (#1316): a stored texture ref's wrap and filters are NAMES — glTF's sampler vocabulary —
// instead of numbers that were glTF's on one road and three.js's on the other. See migrations.ts
// formatMigrations[18].
// v20 (#1227): an `AnimationClip` stores its motion as timed poses — bones by NAME, quaternions —
// instead of a key per bone INDEX with XYZ euler angles. See migrations.ts formatMigrations[19].
// v21 (#1503): visibility is the `viewport` and `render` params, not `meta.hidden` — a hidden node
// is saved off in both, which is what `meta.hidden` hid it from. See migrations.ts
// formatMigrations[20].
export const PROJECT_FORMAT_VERSION = 21;

export const ProjectSchema = z.object({
  formatVersion: z.literal(PROJECT_FORMAT_VERSION),
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Per-node-type schema versions present in this file. Migration runner
   *  reads this on load and steps each node up to the current registered
   *  version. (THESIS.md §52.) */
  nodeVersions: z.record(z.string(), z.number().int().nonnegative()),
  /** The DAG itself — nodes keyed by id, plus the named output sockets. */
  state: z.object({
    nodes: z.record(NodeIdSchema, NodeSchema),
    outputs: z.record(z.string(), NodeRefSchema),
  }),
});

export type Project = z.infer<typeof ProjectSchema>;

export const PROJECT_FILENAME = 'project.json';

/**
 * #1302 — what a project picker shows, stored beside `project.json` so listing reads a few hundred
 * bytes per project instead of every project in full (one example is a ~9.5 MB captured scene).
 */
export const PROJECT_META_FILENAME = 'meta.json';

export const ProjectMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  formatVersion: z.number(),
  nodeCount: z.number().int().nonnegative(),
});

export type ProjectMetadata = z.infer<typeof ProjectMetadataSchema>;
