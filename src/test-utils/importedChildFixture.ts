// The imported-child PAIR, as a fixture — the one place a test says "a glTF child" (#389).
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────
//
// Before the split, a test wrote one node: `{ type: 'GltfChild', params: { assetRef,
// childName, position, rotation, scale } }`. Twenty files did, and each one spelled it out
// by hand. The split makes that shape two nodes and an edge between them, which is three
// facts a fixture has to get right — the data node's id, the direction of the `data` edge,
// and which half each param belongs to. Twenty hand-written copies of that is twenty
// chances to build a pair the product cannot build, and a fixture that is wrong in the
// same direction as the code under test passes.
//
// So the shape lives here once, beside `splitOps` in `splitKinds.ts`, which does the same
// job for the kinds a test CAN mint from primitives. This one is separate rather than a
// seventh entry there because an imported child is not mintable that way: its geometry is
// a reference into a loaded asset clone, so what a unit fixture needs is the NODE SHAPE
// without any pretence that the pair would draw.
//
// ── THE TWO IDIOMS, BOTH SERVED ──────────────────────────────────────────────────────
//
// Fixtures in this codebase come in two kinds and both are legitimate:
//
//   · `importedChildOps` — `addNode`/`connect` ops pushed through `applyOp`, so the real
//     zod schemas validate the params. Use this wherever the test already builds state
//     through ops: it is the only form that proves the pair is CONSTRUCTIBLE.
//   · `importedChildNodes` — plain node literals for a hand-built table. Cheaper, and
//     necessary for the readers typed structurally (`NodeLike`, `ClipWalkNode`,
//     `GraphNodeLike`) that never see a `DagState` at all.
//
// ⚠️ The two agree BY CONSTRUCTION — the literal form is what the op form produces — and
// that is the property worth keeping. Two fixture builders that drifted would let a unit
// row pass against a shape the ops road cannot make, which is the failure `splitKinds.ts`
// documents for its own two tiers.
//
// REF: src/nodes/GltfData.ts; src/nodes/ObjectNode.ts (`overridden`);
//      src/app/importedChild.ts (the reader every consumer goes through);
//      src/test-utils/splitKinds.ts (`splitOps` — the same job for mintable kinds).

import type { Vec3 } from '../nodes/types';

/** What an imported child is, as a fixture states it. Every field has a usable default. */
export interface ImportedChildFixture {
  readonly assetRef?: string;
  readonly childName?: string;
  readonly position?: Vec3;
  readonly rotation?: Vec3;
  readonly scale?: Vec3;
  /**
   * The manual-override flags. SPARSE and on the OBJECT, mirroring the live schema: omit
   * for a child nobody has posed, and it carries no key at all rather than three `false`s.
   */
  readonly overridden?: { position?: boolean; rotation?: boolean; scale?: boolean };
  /** Slot 0's captured material, or `null` for a bone/empty — the schema is nullable. */
  readonly material?: unknown;
  /** The full table, for a multi-primitive child only. Absent ⇒ one slot, and it is
   *  `material` (the `dataSlotsOnly` rule). */
  readonly materialSlots?: readonly unknown[];
}

/**
 * The data half's id for a fixture's Object id.
 *
 * Its own function so a test never hardcodes the suffix: the ids the product mints differ
 * by road (`gltfChildDataDagId` at import, `freshDataId` in the migration), so a fixture
 * that spelled one of them would be asserting a derivation rather than using one.
 */
export function importedChildDataIdFor(objectId: string): string {
  return `${objectId}__data`;
}

function halves(objectId: string, fx: ImportedChildFixture) {
  return {
    dataId: importedChildDataIdFor(objectId),
    data: {
      assetRef: fx.assetRef ?? 'asset-a',
      childName: fx.childName ?? 'Cube',
      material: fx.material ?? null,
      ...(fx.materialSlots ? { materialSlots: fx.materialSlots } : {}),
    },
    object: {
      position: fx.position ?? ([0, 0, 0] as Vec3),
      rotation: fx.rotation ?? ([0, 0, 0] as Vec3),
      scale: fx.scale ?? ([1, 1, 1] as Vec3),
      ...(fx.overridden ? { overridden: fx.overridden } : {}),
    },
  };
}

/** The three ops that create one imported-child pair, in dependency order. */
export function importedChildOps(
  objectId: string,
  fx: ImportedChildFixture = {},
): { type: string; [k: string]: unknown }[] {
  const { dataId, data, object } = halves(objectId, fx);
  return [
    { type: 'addNode', nodeId: dataId, nodeType: 'GltfData', params: data },
    { type: 'addNode', nodeId: objectId, nodeType: 'Object', params: object },
    {
      type: 'connect',
      from: { node: dataId, socket: 'out' },
      to: { node: objectId, socket: 'data' },
    },
  ];
}

/** The same pair as plain node literals, keyed by id — for a hand-built node table. */
export function importedChildNodes(
  objectId: string,
  fx: ImportedChildFixture = {},
): Record<string, { id: string; type: string; version: number; params: unknown; inputs: unknown }> {
  const { dataId, data, object } = halves(objectId, fx);
  return {
    [dataId]: { id: dataId, type: 'GltfData', version: 1, params: data, inputs: {} },
    [objectId]: {
      id: objectId,
      type: 'Object',
      version: 1,
      params: object,
      inputs: { data: { node: dataId, socket: 'out' } },
    },
  };
}
