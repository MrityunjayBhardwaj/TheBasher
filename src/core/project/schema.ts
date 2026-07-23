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
export const PROJECT_FORMAT_VERSION = 5;

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
