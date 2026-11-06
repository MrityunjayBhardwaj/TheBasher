import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';
import { buildSceneTreeRows } from './sceneTreeWalk';
import { makeSplitCube } from '../test-utils/splitCube';
import { importedChildOps } from '../test-utils/importedChildFixture';
import { buildDefaultDagState } from '../core/project/default';
import { buildAddPrimitiveOps } from './addPrimitives';
import { buildAddStudioLightOps } from './addStudioLight';
import { buildAddProfileOps } from './studioProfiles';
import {
  collectionMembersOf,
  hiddenNodes,
  newCollectionOps,
  setActiveCollectionOp,
} from './collections';
import { stripTargetRows } from './stripTargets';
import { reorderIndex } from './treeDropIntent';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  registerAllNodes();
});

function applyAll(state: DagState, ops: Op[]): DagState {
  let s = state;
  for (const op of ops) s = applyOp(s, op).next;
  return s;
}

function buildSceneOnly(): DagState {
  const state = applyAll(emptyDagState(), [
    { type: 'addNode', nodeId: 'n_scene', nodeType: 'Scene', params: {} },
  ]);
  return { ...state, outputs: { scene: { node: 'n_scene', socket: 'out' } } };
}

describe('buildSceneTreeRows — projection (THESIS.md §12)', () => {
  it('returns the Scene row for an empty project', () => {
    const rows = buildSceneTreeRows(buildSceneOnly());
    expect(rows).toHaveLength(1);
    expect(rows[0].nodeType).toBe('Scene');
    expect(rows[0].depth).toBe(0);
    expect(rows[0].parent).toBeUndefined();
  });

  it('walks Group children with parent linkage', () => {
    let state = buildSceneOnly();
    state = applyAll(state, [
      { type: 'addNode', nodeId: 'grp', nodeType: 'Group', params: {} },
      {
        type: 'connect',
        from: { node: 'grp', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ]);
    state = makeSplitCube(state, {
      objectId: 'box',
      size: [1, 1, 1],
      connectTo: { node: 'grp', socket: 'children' },
    }).state;
    const rows = buildSceneTreeRows(state);
    // Three rows, not four: the BoxData hangs off the Object's `data` socket, which is not a
    // scene socket, so the walk must not surface it as a sibling row in the outliner.
    expect(rows.map((r) => r.nodeType)).toEqual(['Scene', 'Group', 'Object']);
    expect(rows[1].parent).toEqual({ nodeId: 'n_scene', socket: 'children', index: 0 });
    expect(rows[2].parent).toEqual({ nodeId: 'grp', socket: 'children', index: 0 });
  });

  it('walks Transform → child via target socket', () => {
    let state = buildSceneOnly();
    state = applyAll(state, [
      { type: 'addNode', nodeId: 'tx', nodeType: 'Transform', params: { position: [1, 0, 0] } },
      {
        type: 'connect',
        from: { node: 'tx', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ]);
    state = makeSplitCube(state, {
      objectId: 'box',
      size: [1, 1, 1],
      connectTo: { node: 'tx', socket: 'target' },
    }).state;
    const rows = buildSceneTreeRows(state);
    expect(rows.map((r) => r.nodeType)).toEqual(['Scene', 'Transform', 'Object']);
    expect(rows[2].parent).toEqual({ nodeId: 'tx', socket: 'target', index: 0 });
  });

  it('expands a GltfAsset into nested imported-child rows (Option A, #91 Wave D)', () => {
    // Asset with two children: a parent "bone0" and its child "bone1".
    // nodeNameMap: childKey → GltfChild node id; childHierarchy: parent → children.
    let state = buildSceneOnly();
    state = applyAll(state, [
      {
        type: 'addNode',
        nodeId: 'gltf',
        nodeType: 'GltfAsset',
        params: {
          assetRef: 'assets/skinned-bar.glb',
          nodeNameMap: { bone0: 'child_b0', bone1: 'child_b1' },
          childHierarchy: { bone0: ['bone1'] },
        },
      },
      ...importedChildOps('child_b0', {
        assetRef: 'assets/skinned-bar.glb',
        childName: 'bone0',
      }),
      ...importedChildOps('child_b1', {
        assetRef: 'assets/skinned-bar.glb',
        childName: 'bone1',
        position: [0, 1, 0],
      }),
      {
        type: 'connect',
        from: { node: 'gltf', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ]);
    const rows = buildSceneTreeRows(state);
    // Scene → GltfAsset → bone0 (depth 2) → bone1 (depth 3).
    // #389 — the child rows say `Object`, because that is what an imported child now IS.
    // The outliner icons them through the `data` edge (`iconKindForNode`) like every other
    // split pair, and the DATA nodes are deliberately absent from the tree: a data node has
    // no pose and is not a scene child, so it has no row of its own here.
    expect(rows.map((r) => r.nodeType)).toEqual(['Scene', 'GltfAsset', 'Object', 'Object']);
    const gltfRow = rows[1];
    const bone0Row = rows[2];
    const bone1Row = rows[3];
    expect(gltfRow.nodeType).toBe('GltfAsset');
    // bone0 is a root child → directly under the asset.
    expect(bone0Row.display).toBe('bone0');
    expect(bone0Row.depth).toBe(gltfRow.depth + 1);
    expect(bone0Row.nodeId).toBe('child_b0'); // click selects the GltfChild node
    expect(bone0Row.parent).toBeUndefined(); // non-reorderable: no scene edge
    // bone1 nests one deeper under bone0.
    expect(bone1Row.display).toBe('bone1');
    expect(bone1Row.depth).toBe(bone0Row.depth + 1);
    expect(bone1Row.nodeId).toBe('child_b1');
    expect(bone1Row.parent).toBeUndefined();
  });

  it('produces the same tree shape for two non-identical DAGs that evaluate the same hierarchy', () => {
    // DAG A: Scene → Group → split cube
    let a = buildSceneOnly();
    a = applyAll(a, [
      { type: 'addNode', nodeId: 'grp', nodeType: 'Group', params: {} },
      {
        type: 'connect',
        from: { node: 'grp', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ]);
    a = makeSplitCube(a, {
      objectId: 'box',
      size: [1, 1, 1],
      connectTo: { node: 'grp', socket: 'children' },
    }).state;
    // DAG B: same shape but the Group has different params (passes through),
    // and node ids differ — including the DATA ids, which the walk must keep out of the
    // projection entirely for the two type sequences to agree.
    let b = buildSceneOnly();
    b = applyAll(b, [
      { type: 'addNode', nodeId: 'bb', nodeType: 'Group', params: {} },
      {
        type: 'connect',
        from: { node: 'bb', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ]);
    b = makeSplitCube(b, {
      objectId: 'aa',
      size: [1, 1, 1],
      connectTo: { node: 'bb', socket: 'children' },
    }).state;
    const ta = buildSceneTreeRows(a).map((r) => `${r.depth}:${r.nodeType}`);
    const tb = buildSceneTreeRows(b).map((r) => `${r.depth}:${r.nodeType}`);
    expect(ta).toEqual(tb);
  });
});

describe('buildSceneTreeRows — row.display identity (outliner labels)', () => {
  function sceneWithBox(): DagState {
    const state = buildSceneOnly();
    return makeSplitCube(state, {
      objectId: 'n_box_2',
      size: [1, 1, 1],
      connectTo: { node: 'n_scene', socket: 'children' },
    }).state;
  }

  function patchNode(state: DagState, id: string, patch: Record<string, unknown>): DagState {
    return { ...state, nodes: { ...state.nodes, [id]: { ...state.nodes[id]!, ...patch } } };
  }

  it('falls back to the node id (NOT the bare type) for an unnamed node', () => {
    // Two unnamed meshes used to both read their bare type — indistinct in the tree while
    // the inspector showed "n_box_2". The label now carries identity. Post-split the bare
    // type is 'Object', which every mesh, light and camera shares, so the failure this
    // guards against is strictly worse than it was: EVERY scene row would read alike.
    const box = buildSceneTreeRows(sceneWithBox()).find((r) => r.nodeId === 'n_box_2');
    expect(box?.display).toBe('n_box_2');
    expect(box?.display).not.toBe('Object');
  });

  it('prefers meta.name (matches the inspector identity)', () => {
    const box = buildSceneTreeRows(
      patchNode(sceneWithBox(), 'n_box_2', { meta: { name: 'Hero' } }),
    ).find((r) => r.nodeId === 'n_box_2');
    expect(box?.display).toBe('Hero');
  });

  it('uses params.name (Shot / AnimationClip / Character semantic label) over the id', () => {
    const box = buildSceneTreeRows(
      patchNode(sceneWithBox(), 'n_box_2', { params: { name: 'Intro' } }),
    ).find((r) => r.nodeId === 'n_box_2');
    expect(box?.display).toBe('Intro');
  });

  it('meta.name wins over params.name', () => {
    const box = buildSceneTreeRows(
      patchNode(sceneWithBox(), 'n_box_2', {
        meta: { name: 'Hero' },
        params: { name: 'Intro' },
      }),
    ).find((r) => r.nodeId === 'n_box_2');
    expect(box?.display).toBe('Hero');
  });
});

// #1505 — a collection lists every member under its row, whatever band the member hangs on: a
// light on the scene's `lights`, a light on the active profile's rig, a camera. Each row keeps the
// `parent` its top-level row had, so a drag from under the collection moves the real wire.
describe('#1505 — a collection lists its lights and cameras under it', () => {
  /** The default project, a new collection made active, then each thing added through Add. */
  function addedIntoCollection() {
    let s = buildDefaultDagState();
    const scene = s.outputs.scene!.node;
    const made = newCollectionOps(s)!;
    s = applyAll(s, made.ops);
    const col = made.collectionId;
    s = applyAll(s, [setActiveCollectionOp(s, col)!]);
    const addOne = (kind: 'PointLight' | 'PerspectiveCamera') => {
      const r = buildAddPrimitiveOps(s, kind, [0, 0, 0])!;
      s = applyAll(s, r.ops);
      return r.newNodeId;
    };
    const light = addOne('PointLight');
    const light2 = addOne('PointLight');
    const camera = addOne('PerspectiveCamera');
    const prof = buildAddProfileOps(s, 'Key', [0, 0, 0])!;
    s = applyAll(s, prof.ops);
    const studio = buildAddStudioLightOps(s, [0, 0, 0], prof.rigId)!;
    s = applyAll(s, studio.ops);
    return { s, scene, col, light, light2, camera, rigLight: studio.lightId, rigId: prof.rigId };
  }

  /** The same state with the collection holding nothing: what the top-level rows carry. */
  const withoutMembers = (s: DagState, col: string) =>
    applyAll(
      s,
      (s.nodes[col].inputs.members as { node: string; socket: string }[]).map((ref) => ({
        type: 'disconnect',
        from: ref,
        to: { node: col, socket: 'members' },
      })) as Op[],
    );

  it('each is a member, listed once, under the collection row, with its top-level parent', () => {
    const { s, scene, col, light, light2, camera, rigLight } = addedIntoCollection();
    const members = collectionMembersOf(s, col);
    for (const id of [light, light2, camera, rigLight]) expect(members).toContain(id);
    const rows = buildSceneTreeRows(s);
    const colRow = rows.find((r) => r.nodeId === col)!;
    const topLevel = buildSceneTreeRows(withoutMembers(s, col));
    const placed = [light, light2, camera, rigLight].map((id) => {
      const mine = rows.filter((r) => r.nodeId === id);
      const top = topLevel.find((r) => r.nodeId === id)!;
      return {
        id,
        count: mine.length,
        depth: mine[0]?.depth,
        underCollection: mine[0]?.key.startsWith(`${colRow.key}/`),
        parent: mine[0]?.parent,
        topParent: top.parent,
      };
    });
    for (const p of placed) {
      expect(p, p.id).toMatchObject({
        count: 1,
        depth: colRow.depth + 1,
        underCollection: true,
        parent: p.topParent,
      });
    }
    // The bands they come from: the scene's lights, the rig's lights, and a camera Add stands in
    // the scene's children (#1518).
    expect(placed.map((p) => p.parent?.socket)).toEqual(['lights', 'lights', 'children', 'lights']);
    expect(placed[0].parent?.nodeId).toBe(scene);
    expect(placed[2].parent?.nodeId).toBe(scene);
    // Nothing of theirs is left at the top level.
    expect(
      rows.filter((r) => r.depth === 1 && [light, light2, camera, rigLight].includes(r.nodeId)),
    ).toEqual([]);
  });

  it('the collection’s eye hides the rows under it', () => {
    const { s, col, light, camera, rigLight } = addedIntoCollection();
    const off = applyAll(s, [
      { type: 'setParam', nodeId: col, paramPath: 'viewport', value: false },
    ]);
    const hidden = hiddenNodes(off, 'viewport');
    const under = buildSceneTreeRows(off)
      .filter((r) => r.key.includes(`/collection/${col}/`))
      .map((r) => r.nodeId);
    for (const id of [light, camera, rigLight]) {
      expect(under).toContain(id);
      expect(hidden.has(id), id).toBe(true);
    }
  });

  it('a reorder from the rows under the collection moves the scene’s light wire', () => {
    const { s, scene, light, light2 } = addedIntoCollection();
    const rows = buildSceneTreeRows(s);
    const src = rows.find((r) => r.nodeId === light2)!;
    const dst = rows.find((r) => r.nodeId === light)!;
    // The ops SceneTree's drop dispatches for a reorder (`onDrop`, intent 'reorder').
    const index = reorderIndex(src.parent!.index, dst.parent!.index, 'before')!;
    const to = { node: dst.parent!.nodeId, socket: dst.parent!.socket };
    const ref = { node: light2, socket: 'out' };
    const t = applyAll(s, [
      { type: 'disconnect', from: ref, to },
      { type: 'connect', from: ref, to, index },
    ]);
    const lights = (t.nodes[scene].inputs.lights as { node: string }[]).map((r) => r.node);
    expect(lights.indexOf(light2)).toBeLessThan(lights.indexOf(light));
    expect(lights.filter((id) => id === light2)).toHaveLength(1);
  });
});

describe('#1505 — a member held in more than one place', () => {
  it('a camera nested in a Group and also in a collection is listed once, under the Group', () => {
    let s = buildDefaultDagState();
    const scene = s.outputs.scene!.node;
    const made = newCollectionOps(s)!;
    s = applyAll(s, made.ops);
    const cam = buildAddPrimitiveOps(s, 'PerspectiveCamera', [0, 0, 0])!;
    s = applyAll(s, [
      ...cam.ops,
      { type: 'addNode', nodeId: 'grp', nodeType: 'Group', params: {} },
      {
        type: 'connect',
        from: { node: 'grp', socket: 'out' },
        to: { node: scene, socket: 'children' },
      },
      // Out of the scene's children, where Add stood it (#1518), and into the Group.
      {
        type: 'disconnect',
        from: { node: cam.newNodeId, socket: 'out' },
        to: { node: scene, socket: 'children' },
      },
      {
        type: 'connect',
        from: { node: cam.newNodeId, socket: 'out' },
        to: { node: 'grp', socket: 'children' },
      },
      {
        type: 'connect',
        from: { node: cam.newNodeId, socket: 'out' },
        to: { node: made.collectionId, socket: 'members' },
      },
    ]);
    const rows = buildSceneTreeRows(s).filter((r) => r.nodeId === cam.newNodeId);
    expect(rows.map((r) => r.parent)).toEqual([{ nodeId: 'grp', socket: 'children', index: 0 }]);
  });

  it('a rig light nested in a Group and also in a collection is listed once, under the Group', () => {
    let s = buildDefaultDagState();
    const scene = s.outputs.scene!.node;
    const made = newCollectionOps(s)!;
    s = applyAll(s, made.ops);
    const prof = buildAddProfileOps(s, 'Key', [0, 0, 0])!;
    s = applyAll(s, prof.ops);
    const studio = buildAddStudioLightOps(s, [0, 0, 0], prof.rigId)!;
    s = applyAll(s, studio.ops);
    const ref = { node: studio.lightId, socket: 'out' };
    s = applyAll(s, [
      { type: 'addNode', nodeId: 'grp', nodeType: 'Group', params: {} },
      {
        type: 'connect',
        from: { node: 'grp', socket: 'out' },
        to: { node: scene, socket: 'children' },
      },
      { type: 'connect', from: ref, to: { node: 'grp', socket: 'children' } },
      { type: 'connect', from: ref, to: { node: made.collectionId, socket: 'members' } },
    ]);
    const rows = buildSceneTreeRows(s).filter((r) => r.nodeId === studio.lightId);
    expect(rows.map((r) => r.parent)).toEqual([{ nodeId: 'grp', socket: 'children', index: 0 }]);
  });

  it('a member on two of the scene’s lists is listed under the collection by the first', () => {
    let s = buildDefaultDagState();
    const scene = s.outputs.scene!.node;
    const made = newCollectionOps(s)!;
    s = applyAll(s, made.ops);
    const light = buildAddPrimitiveOps(s, 'PointLight', [0, 0, 0])!;
    s = applyAll(s, light.ops);
    const ref = { node: light.newNodeId, socket: 'out' };
    s = applyAll(s, [
      { type: 'connect', from: ref, to: { node: scene, socket: 'children' } },
      { type: 'connect', from: ref, to: { node: made.collectionId, socket: 'members' } },
    ]);
    const under = buildSceneTreeRows(s).filter(
      (r) => r.nodeId === light.newNodeId && r.key.includes('/collection/'),
    );
    expect(under.map((r) => r.parent?.socket)).toEqual(['children']);
  });

  it('one in two collections has a row under each, with the same real parent', () => {
    let s = buildDefaultDagState();
    const scene = s.outputs.scene!.node;
    const a = newCollectionOps(s)!;
    s = applyAll(s, a.ops);
    const b = newCollectionOps(s)!;
    s = applyAll(s, b.ops);
    s = applyAll(s, [setActiveCollectionOp(s, a.collectionId)!]);
    const light = buildAddPrimitiveOps(s, 'PointLight', [0, 0, 0])!;
    const camera = buildAddPrimitiveOps(applyAll(s, light.ops), 'PerspectiveCamera', [0, 0, 0])!;
    s = applyAll(s, [...light.ops, ...camera.ops]);
    for (const id of [light.newNodeId, camera.newNodeId]) {
      s = applyAll(s, [
        {
          type: 'connect',
          from: { node: id, socket: 'out' },
          to: { node: b.collectionId, socket: 'members' },
        },
      ]);
    }
    const allRows = buildSceneTreeRows(s);
    const rowsOf = (id: string) => allRows.filter((r) => r.nodeId === id);
    for (const id of [light.newNodeId, camera.newNodeId]) {
      expect(rowsOf(id).map((r) => r.key)).toEqual([
        `${scene}/collection/${a.collectionId}/${id}`,
        `${scene}/collection/${b.collectionId}/${id}`,
      ]);
      expect(rowsOf(id)[0].parent).toEqual(rowsOf(id)[1].parent);
    }
    expect(rowsOf(light.newNodeId)[0].parent?.socket).toBe('lights');
    expect(rowsOf(camera.newNodeId)[0].parent?.socket).toBe('children');
    // A row key is what the outliner tells rows apart by; a nodeId may repeat, a key never.
    const keys = allRows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    // The NLA's target list asks for nodes, not rows.
    const targets = stripTargetRows(s).map((t) => t.id);
    expect(targets.filter((id) => id === light.newNodeId)).toHaveLength(1);
    expect(new Set(targets).size).toBe(targets.length);
  });
});
