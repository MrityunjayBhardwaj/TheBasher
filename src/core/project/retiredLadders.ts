// The param ladders of RETIRED node types — owned by the migration layer, not the registry.
//
// ── WHY THIS EXISTS (#365 Phase 5) ─────────────────────────────────────────────────────
//
// Ten fused node types were retired by the object↔data split. Until now their full
// `NodeDefinition`s stayed REGISTERED — schema, sockets, inspector sections, param homes,
// a throwing `evaluate` — for one reason: the split migrations normalise an old fused node
// through its OWN version ladder before splitting it, and they reached that ladder through
// `getNodeType('BoxMesh')`. So ten dead node types sat in the live registry, indexed by
// `listNodeTypes()`, carrying param homes for a shape nothing can construct, because a
// migration needed two fields off each of them.
//
// The dependency was the wrong way round. A retired type's ladder is not registry data —
// nothing evaluates it, nothing routes params to it, nothing can create one. It is
// MIGRATION data: the record of how that type's params changed while it still existed.
// Homing it here lets the relic definitions be deleted outright, which is what #365 Phase 5
// is for, and removes the standing invitation to read a retired type as if it were live.
//
// ── WHAT MOVED, AND WHAT TURNED OUT TO BE NOTHING ─────────────────────────────────────
//
// Measured before moving: of the ten retired types, only THREE carry a ladder with any
// steps in it — the box and the sphere (v4, three steps each: the transform band's `scale`,
// then two inline-material shape changes) and the curve (v2, one step: bare `Vec3[]` points
// gaining stable ids). The other seven were all `version: 1` with no `migrations` at all, so
// the normalisation loop over them could never execute a single step. They contributed
// nothing to any migration and were kept alive by the shape of the lookup rather than by
// any need.
//
// ⚠️ THESE FUNCTIONS ARE FROZEN. They describe param shapes that existed in shipped saves,
// so they are history rather than code that may be improved. A change here does not fix an
// old project — it rewrites what an old project is read AS. The only correct edit is
// appending a step for a change made while the type was still live, which cannot happen
// again for any type in this file.
//
// REF: src/core/project/migrations.ts (the six split passes — the only consumer);
//      src/test-utils/splitKinds.ts (`fusedTypes` — the same retirement, stated for gates);
//      src/nodes/materialSchema.ts (the two inline-material steps the box/sphere ladders
//      call); docs/OBJECT-DATA-SPLIT-DESIGN.md §7 (Phase 5); issues #365, #231.

import { mintId } from '../../app/identifiedArray';
import { hydrateInlineMaterial, migrateInlineMaterialV2toV3 } from '../../nodes/materialSchema';

/**
 * The curve point shape, spelled STRUCTURALLY rather than imported.
 *
 * The live `CurvePoint` is exported from a module this layer must not depend on: a ladder
 * describes a shape that existed in SHIPPED SAVES, and importing the current type would
 * silently re-point this history at whatever that type becomes next. Structural and local
 * is the honest spelling — if the live type moves on, this one stays describing what was
 * actually written to disk.
 */
type MigratedCurvePoint = { id: string; co: [number, number, number] };

/** A retired type's param history: the version it died at, and how to walk up to it. */
export interface RetiredLadder {
  /** The `version` the type carried when it was retired. */
  readonly version: number;
  /** `migrations[v]` upgrades params from version v to v+1. Absent ⇒ nothing to do. */
  readonly migrations?: Readonly<Record<number, (old: unknown) => unknown>>;
}

/**
 * Every retired node type, keyed by the `type` string that appears in old saves.
 *
 * All ten are listed even though seven have no steps, because the SET is the useful fact:
 * a save naming a type absent from here is not a retired node, it is an unknown one, and
 * those are different diagnoses. The counts are pinned in `migrations.test.ts`.
 */
export const RETIRED_LADDERS: Readonly<Record<string, RetiredLadder>> = {
  // ── The three with real history ──────────────────────────────────────────────────────
  BoxMesh: {
    version: 4,
    migrations: {
      // v0.6 #1 — the non-destructive TRS band arrives. Identity scale, so a migrated
      // project renders byte-identically (the renderer ignored scale until Wave 3).
      1: (old) => ({ ...(old as object), scale: [1, 1, 1] }),
      // v0.6 #2 (#178) — {name,color} becomes the OpenPBR IR. Seeds the CURRENT-LOOK
      // constants rather than the new-node defaults, deliberately: a saved project must
      // keep looking the way it looked, which is not how a fresh box looks.
      2: (old) => ({
        ...(old as object),
        material: migrateInlineMaterialV2toV3((old as { material?: unknown }).material),
      }),
      // v0.6 #3 (#181) — the inline material gains `uvTransform`, filled with identity.
      3: (old) => ({
        ...(old as object),
        material: hydrateInlineMaterial((old as { material?: unknown }).material),
      }),
    },
  },
  SphereMesh: {
    version: 4,
    migrations: {
      1: (old) => ({ ...(old as object), scale: [1, 1, 1] }),
      2: (old) => ({
        ...(old as object),
        material: migrateInlineMaterialV2toV3((old as { material?: unknown }).material),
      }),
      3: (old) => ({
        ...(old as object),
        material: hydrateInlineMaterial((old as { material?: unknown }).material),
      }),
    },
  },
  Curve: {
    version: 2,
    migrations: {
      // #454 — bare positions become points with stable ids, so a keyframe on a control
      // point survives an insertion earlier in the list.
      1: (old) => {
        const legacy = ((old as { points?: unknown }).points ?? []) as [number, number, number][];
        const points: MigratedCurvePoint[] = [];
        for (const co of legacy) {
          points.push({
            id: mintId(
              points.map((p) => p.id),
              'cp',
            ),
            co,
          });
        }
        return { ...(old as object), points };
      },
    },
  },

  // ── The seven that never changed shape while they were live ──────────────────────────
  // No `migrations` key rather than an empty object: absent means "there was never a step",
  // which is the true statement, and an empty object would read as "the steps were removed".
  BakedMesh: { version: 1 },
  DirectionalLight: { version: 1 },
  PointLight: { version: 1 },
  SpotLight: { version: 1 },
  AreaLight: { version: 1 },
  PerspectiveCamera: { version: 1 },
  OrthographicCamera: { version: 1 },
};

/**
 * Walk a retired node's params up to the version it was retired at.
 *
 * Replaces the identical loop that appeared once per split pass, each reaching into the
 * registry for a definition that only existed to be read here. `recorded` is the node's own
 * saved `version`; when it is absent the params are already assumed current, which matches
 * what every pass did before.
 */
export function normalizeRetiredParams(
  type: string,
  recorded: unknown,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const ladder = RETIRED_LADDERS[type];
  if (!ladder) return params;
  let out = params;
  let v = typeof recorded === 'number' ? recorded : ladder.version;
  // Bounded: a ladder whose step forgot to advance the version would otherwise spin here.
  let safety = 64;
  while (v < ladder.version && safety-- > 0) {
    const step = ladder.migrations?.[v];
    if (!step) break;
    out = step(out) as Record<string, unknown>;
    v++;
  }
  return out;
}
