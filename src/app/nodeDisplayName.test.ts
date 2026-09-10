// #1010 — the display-name resolver, and the one rule it has to keep.
//
// A node that HAS a name never shows as a bare id; a node that has none still does.
// Both directions, because only the pair is a gate: a resolver that returned the name
// for everything would pass the first row alone, and a resolver that returned the id
// for everything would pass the second alone.
//
// The imported child is the case that made this an issue. Its id is content-addressed
// (`gltfChildDagId` = a hash, #389) and that is load-bearing, so the id CANNOT be made
// readable — the name has to be resolved beside it. It lives on the child's data half
// as `childName`, which is the same string the outliner's `nodeNameMap` key carries.
//
// ⚠️ Every id here is minted by the PRODUCT's own function. Spelling a hash by hand
// would assert the id scheme rather than the feature, and would keep passing after the
// scheme changed underneath it.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, __resetRegistryForTests } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { importedChildOps } from '../test-utils/importedChildFixture';
import { gltfChildDagId } from '../core/import/gltfImportChain';
import { importedChildOf } from './importedChild';
import { buildSceneTreeRows, nodeDisplayName } from './sceneTreeWalk';

const ASSET = 'assets/character.glb';
const BONES = ['mixamorig_Hips', 'mixamorig_LeftArm', 'mixamorig_Spine'] as const;

function withImportedBones(): { state: DagState; ids: Record<string, string> } {
  let state = buildDefaultDagState();
  const ids: Record<string, string> = {};
  const nodeNameMap: Record<string, string> = {};
  for (const name of BONES) {
    ids[name] = gltfChildDagId(ASSET, name);
    nodeNameMap[name] = ids[name];
  }
  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: 'n_asset',
      nodeType: 'GltfAsset',
      params: { assetRef: ASSET, nodeNameMap },
    },
    ...BONES.flatMap(
      (name) =>
        importedChildOps(ids[name], {
          assetRef: ASSET,
          childName: name,
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        }) as Op[],
    ),
  ];
  // Wired into the scene — `buildSceneTreeRows` walks from the `scene` output, so an
  // unconnected asset projects no rows at all and every outliner assertion below would
  // pass vacuously against an empty list.
  ops.push({
    type: 'connect',
    from: { node: 'n_asset', socket: 'out' },
    to: { node: 'n_scene', socket: 'children' },
  });
  for (const op of ops) state = applyOp(state, op).next;
  return { state, ids };
}

describe('nodeDisplayName — a node with a name never shows as a bare id (#1010)', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('resolves every imported child to its name, not its content hash', () => {
    const { state, ids } = withImportedBones();

    // The denominator FIRST: a census over an empty set passes vacuously, and a
    // fixture whose children carry no name would make the row below meaningless.
    const named = BONES.filter((n) => importedChildOf(state.nodes, ids[n])?.childName === n);
    expect(named).toEqual([...BONES]);

    const shown = BONES.map((n) => nodeDisplayName(state.nodes, ids[n]));
    expect(shown).toEqual([...BONES]);

    // And say the failure the issue described out loud: none of them is the id.
    expect(shown.filter((s, i) => s === ids[BONES[i]])).toEqual([]);
  });

  it('still shows the id for a node that has no name — the control direction', () => {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_plain',
      nodeType: 'Object',
      params: {},
    }).next;
    expect(nodeDisplayName(state.nodes, 'n_plain')).toBe('n_plain');
  });

  it('lets a director-authored rename beat the imported name', () => {
    const { state: base, ids } = withImportedBones();
    const id = ids['mixamorig_LeftArm'];
    const state = applyOp(base, { type: 'setMeta', nodeId: id, name: 'left arm' }).next;
    expect(nodeDisplayName(state.nodes, id)).toBe('left arm');
  });

  it('is total — an id no node answers to resolves to the id itself', () => {
    const { state } = withImportedBones();
    expect(nodeDisplayName(state.nodes, 'n_not_here')).toBe('n_not_here');
  });
});

describe('the outliner row goes through the same resolver (#1010)', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  // The outliner used to render the `nodeNameMap` KEY, which is a second answer to a
  // question the resolver owns. It agreed for an un-renamed bone — the key and
  // `childName` are the same string — and that agreement is exactly why the drift was
  // invisible until a rename made them differ.
  it('shows a renamed bone under its new name, not the map key', () => {
    const { state: base, ids } = withImportedBones();
    const id = ids['mixamorig_LeftArm'];

    // The denominator: prove the bone HAS an outliner row before asserting its label.
    const before = buildSceneTreeRows(base).filter((r) => r.nodeId === id);
    expect(before.map((r) => r.display)).toEqual(['mixamorig_LeftArm']);

    const state = applyOp(base, { type: 'setMeta', nodeId: id, name: 'left arm' }).next;
    const after = buildSceneTreeRows(state).filter((r) => r.nodeId === id);
    expect(after.map((r) => r.display)).toEqual(['left arm']);
  });

  // A key whose node is gone keeps the key as its label. Nothing prunes `nodeNameMap`,
  // so this row is reachable, and what a stale entry SHOULD do is a different question
  // from which of two strings a live one shows — this pins that #1010 did not answer it.
  it('keeps the map key for an entry whose node is gone', () => {
    const { state: base, ids } = withImportedBones();
    const id = ids['mixamorig_Spine'];
    const state = applyOp(base, { type: 'removeNode', nodeId: id }).next;

    // Denominator again: the node is really gone AND the map still names it.
    expect(state.nodes[id]).toBeUndefined();
    const map = (state.nodes['n_asset'].params as { nodeNameMap: Record<string, string> })
      .nodeNameMap;
    expect(map['mixamorig_Spine']).toBe(id);

    const rows = buildSceneTreeRows(state).filter((r) => r.nodeId === id);
    expect(rows.map((r) => r.display)).toEqual(['mixamorig_Spine']);
  });
});
