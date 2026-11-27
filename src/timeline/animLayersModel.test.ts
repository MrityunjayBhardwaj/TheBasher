// #1956 — what the drawer's Anim Layers tab lists, and the three edits its footer runs.
//
// The native skinned bar (Blender's own export) imports as an armature Object whose pose reads a
// base layer holding the file's keys, on the skeleton's rest pose (#1211). Every case reads the
// real import, and every edit goes through the shared stack edit or the agent's bake verb.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { buildNativeGltfImportOps } from '../core/import/nativeGltfImport';
import { registerAllNodes } from '../nodes/registerAll';
import { poseLayerChain } from '../app/animate/poseChain';
import {
  addLayerPlan,
  animLayerSubjectOf,
  animLayersView,
  bakeDownArgs,
  deleteLayerPlan,
  filterLayerRows,
  layerToggleArgs,
  type AnimLayerRow,
} from './animLayersModel';
import { getMutator, registerAllMutators } from '../agent/mutators';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

interface Bar {
  readonly state: DagState;
  readonly armature: string;
  readonly mesh: string;
  readonly base: string;
}

async function bar(): Promise<Bar> {
  let state = buildDefaultDagState();
  const bytes = readFileSync('public/assets/skinned-bar.glb');
  const result = await buildNativeGltfImportOps({
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    assetRef: 'user-imports/native/skinned-bar.glb',
    sceneNodeId: state.outputs.scene!.node,
    storeImage: async () => 'img',
  });
  if ('refused' in result) throw new Error(result.refused);
  for (const op of result.ops) state = applyOp(state, op).next;
  const modifier = Object.values(state.nodes).find((n) => n.type === 'ArmatureModifier')!;
  const armature = (modifier.inputs.armature as { node: string }).node;
  const mesh = Object.values(state.nodes).find(
    (n) => n.type === 'Object' && n.id !== armature && reaches(state, n.id, modifier.id),
  )!.id;
  const base = poseLayerChain(state.nodes as never, armature).base!;
  return { state, armature, mesh, base };
}

/** Whether `objectId`'s data lane passes through `nodeId`. */
function reaches(state: DagState, objectId: string, nodeId: string): boolean {
  let at = (state.nodes[objectId].inputs.data as { node?: string } | undefined)?.node;
  for (let n = 0; at && n < 32; n++) {
    if (at === nodeId) return true;
    const next = state.nodes[at]?.inputs;
    at =
      (next?.in as { node?: string } | undefined)?.node ?? (next?.data as { node?: string })?.node;
  }
  return false;
}

function apply(state: DagState, ops: readonly Op[]): DagState {
  let next = state;
  for (const op of ops) next = applyOp(next, op).next;
  return next;
}

function added(state: DagState, subject: string): { state: DagState; id: string } {
  const plan = addLayerPlan(state, subject);
  if (!plan.ok) throw new Error(plan.reason);
  return { state: apply(state, plan.ops), id: plan.nodeId };
}

describe('animLayerSubjectOf — whose layers the tab lists', () => {
  it('is null with nothing selected', () => {
    expect(animLayerSubjectOf(buildDefaultDagState(), null)).toBeNull();
  });

  it('is the armature itself, its skinned mesh, or the Object a selected layer poses', async () => {
    const { state, armature, mesh, base } = await bar();
    expect(animLayerSubjectOf(state, armature)).toBe(armature);
    expect(animLayerSubjectOf(state, mesh)).toBe(armature);
    expect(animLayerSubjectOf(state, base)).toBe(armature);
  });

  it('is null for an object that is no character (the default cube)', () => {
    const state = buildDefaultDagState();
    const cube = Object.values(state.nodes).find((n) => n.type === 'Object')!.id;
    expect(animLayerSubjectOf(state, cube)).toBeNull();
  });
});

describe('animLayersView — the rows, top applied last', () => {
  it('says why it lists nothing: no selection, or not a character', () => {
    const state = buildDefaultDagState();
    expect(animLayersView(state, null).empty).toBe('nothing-selected');
    const cube = Object.values(state.nodes).find((n) => n.type === 'Object')!.id;
    expect(animLayersView(state, cube).empty).toBe('not-a-character');
  });

  it('a fresh import holds no layer rows, and its base layer is the locked bottom row', async () => {
    const { state, armature, base } = await bar();
    const view = animLayersView(state, armature);
    expect(view.empty).toBeNull();
    expect(view.subject).toBe(armature);
    expect(view.rows).toEqual([]);
    expect(view.base?.id).toBe(base);
    expect(view.base?.locked).toBe(true);
    expect(view.canAdd).toBe(true);
  });

  it('lists layers top applied last: a layer added later sits above one added earlier', async () => {
    const { state: s0, armature, base } = await bar();
    const first = added(s0, armature);
    const second = added(first.state, armature);
    const view = animLayersView(second.state, armature);
    expect(view.rows.map((r) => r.id)).toEqual([second.id, first.id]);
    // The base stays at the bottom, apart from the rows.
    expect(view.base?.id).toBe(base);
    // And that is the order the wire applies them in: the Object reads the newest first.
    expect(poseLayerChain(second.state.nodes as never, armature).layers).toEqual([
      second.id,
      first.id,
      base,
    ]);
  });

  it('reads each layer as it is: mode, weight, mute, solo and how many weight keys it holds', async () => {
    const { state: s0, armature } = await bar();
    const { state: s1, id } = added(s0, armature);
    const s2 = apply(s1, [
      { type: 'setParam', nodeId: id, paramPath: 'mode', value: 'additive' },
      { type: 'setParam', nodeId: id, paramPath: 'weight', value: 0.5 },
      { type: 'setParam', nodeId: id, paramPath: 'mute', value: true },
      { type: 'setParam', nodeId: id, paramPath: 'solo', value: true },
      {
        type: 'setParam',
        nodeId: id,
        paramPath: 'channels',
        value: [
          {
            bone: '',
            component: 'weight',
            keyframes: [
              { time: 0, value: 0 },
              { time: 1, value: 1 },
            ],
          },
        ],
      },
    ] as Op[]);
    const [row] = animLayersView(s2, armature).rows;
    expect(row).toMatchObject({
      id,
      kind: 'layer',
      mode: 'additive',
      weight: 0.5,
      mute: true,
      solo: true,
      weightKeys: 2,
      locked: false,
    });
  });
});

describe('the footer edits', () => {
  it('Add is refused, with a reason, where there is no character', () => {
    const state = buildDefaultDagState();
    const cube = Object.values(state.nodes).find((n) => n.type === 'Object')!.id;
    expect(animLayersView(state, cube).canAdd).toBe(false);
    expect(addLayerPlan(state, cube).ok).toBe(false);
  });

  it('Add works on a character whose pose is unwired, or wired straight to the skeleton', async () => {
    const { state, armature } = await bar();
    const feed = state.nodes[armature].inputs.pose as { node: string; socket: string };
    const bare = apply(state, [
      { type: 'disconnect', from: feed, to: { node: armature, socket: 'pose' } },
    ] as Op[]);
    const one = added(bare, armature);
    expect(poseLayerChain(one.state.nodes as never, armature).layers).toEqual([one.id]);
    const skeleton = (state.nodes[armature].inputs.data as { node: string }).node;
    const direct = apply(bare, [
      {
        type: 'connect',
        from: { node: skeleton, socket: 'pose' },
        to: { node: armature, socket: 'pose' },
      },
    ] as Op[]);
    const two = added(direct, armature);
    const chain = poseLayerChain(two.state.nodes as never, armature);
    expect(chain.layers).toEqual([two.id]);
    expect(chain.source).toEqual({ node: skeleton, socket: 'pose' });
  });

  it('Delete takes a layer out and joins the wire back up', async () => {
    const { state: s0, armature, base } = await bar();
    const a = added(s0, armature);
    const b = added(a.state, armature);
    const plan = deleteLayerPlan(b.state, armature, a.id);
    if (!plan.ok) throw new Error(plan.reason);
    const after = apply(b.state, plan.ops);
    expect(after.nodes[a.id]).toBeUndefined();
    expect(poseLayerChain(after.nodes as never, armature).layers).toEqual([b.id, base]);
  });

  it('Delete is refused on the locked base, and on a node that is no layer of the subject', async () => {
    const { state, armature, base } = await bar();
    expect(deleteLayerPlan(state, armature, base).ok).toBe(false);
    expect(deleteLayerPlan(state, armature, 'nope').ok).toBe(false);
  });

  it('Bake down bakes at the selected layer into a free layer id, never at the base', async () => {
    const { state: s0, armature, base } = await bar();
    const { state, id } = added(s0, armature);
    const args = bakeDownArgs(state, armature, id);
    expect(args).toMatchObject({ object: armature, at: id, poses: 'every' });
    expect(typeof args?.layerId).toBe('string');
    expect(state.nodes[args!.layerId]).toBeUndefined();
    expect(bakeDownArgs(state, armature, base)).toBeNull();
  });
});

describe('filterLayerRows', () => {
  it('keeps rows whose name holds the text, case ignored; empty text keeps all', async () => {
    const { state: s0, armature } = await bar();
    const a = added(s0, armature);
    const b = added(a.state, armature);
    const named = apply(b.state, [
      { type: 'setParam', nodeId: a.id, paramPath: 'name', value: 'Head turn' },
      { type: 'setParam', nodeId: b.id, paramPath: 'name', value: 'Foot tweak' },
    ] as Op[]);
    const rows = animLayersView(named, armature).rows;
    expect(filterLayerRows(rows, '').map((r) => r.id)).toEqual([b.id, a.id]);
    expect(filterLayerRows(rows, 'HEAD').map((r) => r.id)).toEqual([a.id]);
    expect(filterLayerRows(rows, '  ').map((r) => r.id)).toEqual([b.id, a.id]);
  });
});

describe('layerToggleArgs (#1927 — the footer speaks the agent’s layer-state verb)', () => {
  const row = (over: Partial<AnimLayerRow>): AnimLayerRow => ({
    id: 'L1',
    kind: 'layer',
    name: 'Layer 1',
    mode: 'override',
    weight: 1,
    mute: false,
    solo: false,
    weightKeys: 0,
    locked: false,
    ...over,
  });

  it('flips the one field asked, on the picked layer', () => {
    expect(layerToggleArgs(row({}), 'mute')).toEqual({ layerId: 'L1', mute: true });
    expect(layerToggleArgs(row({ mute: true }), 'mute')).toEqual({ layerId: 'L1', mute: false });
    expect(layerToggleArgs(row({}), 'solo')).toEqual({ layerId: 'L1', solo: true });
    expect(layerToggleArgs(row({ solo: true }), 'solo')).toEqual({ layerId: 'L1', solo: false });
  });

  it('refuses the locked base and a Rig', () => {
    expect(layerToggleArgs(row({ locked: true }), 'mute')).toBeNull();
    expect(layerToggleArgs(row({ kind: 'rig', mode: null, weight: null }), 'solo')).toBeNull();
  });

  it('its spec is one the registered verb accepts, and builds the one setParam it names', () => {
    registerAllMutators();
    const m = getMutator('mutator.pose.setPoseLayerState');
    expect(m, 'the layer-state verb is registered').toBeDefined();
    const spec = layerToggleArgs(row({}), 'solo')!;
    const parsed = m!.spec.safeParse(spec);
    expect(parsed.success).toBe(true);
    expect(m!.build(parsed.data as never, {} as never, {} as never)).toEqual([
      { type: 'setParam', nodeId: 'L1', paramPath: 'solo', value: true },
    ]);
  });
});
