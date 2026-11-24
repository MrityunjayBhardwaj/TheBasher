// #1957 — the frame around the inspector's stacks: which stacks a selection has, with counts, the
// apply-order flow, and which stack a selected row belongs to. (No stack presets exist, so the
// frame draws no presets bar: there is nothing for one to offer.)

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { buildNativeGltfImportOps } from '../core/import/nativeGltfImport';
import { registerAllNodes } from '../nodes/registerAll';
import { attachStepOps } from '../core/dag/chainEdit';
import { buildAddConstraintOps } from './constraintStack';
import { buildAddMaterialOpOps, buildAddModifierOps, resolveStackBase } from './operatorStack';
import { addLayerPlan } from '../timeline/animLayersModel';
import {
  effectiveStack,
  flowOf,
  FRAME_SECTIONS,
  frameStackOf,
  stackFrameOf as frameOf,
} from './stackFrameModel';
import { resolveDataKind } from './modifierGeometry';

const stackFrameOf = (state: DagState, id: string | null) =>
  frameOf(state, id, (s, dataId) => resolveDataKind(s, dataId));

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);

function boxScene() {
  const state = buildDefaultDagState();
  const box = Object.values(state.nodes).find(
    (n) =>
      n.type === 'Object' &&
      state.nodes[(n.inputs.data as { node?: string } | undefined)?.node ?? '']?.type === 'BoxData',
  )!.id;
  return { state, box };
}

/** The box with one Track To and two Arrays. */
function dressedBox() {
  const { state: s0, box } = boxScene();
  const c = buildAddConstraintOps(s0, box, 'TrackTo')!;
  let state = apply(s0, c.ops);
  const base = resolveStackBase(state, box);
  const m1 = buildAddModifierOps(state, base, 'ArrayModifier')!;
  state = apply(state, m1.ops);
  const m2 = buildAddModifierOps(state, base, 'ArrayModifier')!;
  state = apply(state, m2.ops);
  return { state, box, base, constraint: c.constraintId };
}

describe('stackFrameOf', () => {
  it('is null with nothing selected, or for a node no stack hangs off', () => {
    const { state } = boxScene();
    expect(stackFrameOf(state, null)).toBeNull();
    const scene = state.outputs.scene!.node;
    expect(stackFrameOf(state, scene)).toBeNull();
  });

  it('a plain box: Modifiers, Constraints and Materials, each counted at 0, and no anim layers', () => {
    const { state, box } = boxScene();
    const view = stackFrameOf(state, box)!;
    expect(view.object).toBe(box);
    expect(view.stacks.map((s) => [s.kind, s.count])).toEqual([
      ['modifiers', 0],
      ['constraints', 0],
      ['materials', 0],
    ]);
    expect(view.animLayers).toBeNull();
  });

  it('counts what each stack holds', () => {
    const { state, box, base } = dressedBox();
    const withMaterial = apply(state, buildAddMaterialOpOps(state, base, 'SetMaterialOp')!.ops);
    const view = stackFrameOf(withMaterial, box)!;
    expect(view.stacks.map((s) => [s.kind, s.count])).toEqual([
      ['modifiers', 2],
      ['constraints', 1],
      ['materials', 1],
    ]);
  });

  it('a constraint that is both edge-less and wired into the lane counts once', () => {
    const { state, box, constraint } = dressedBox();
    const ops = attachStepOps(state, box, constraint);
    if (!ops) throw new Error('the box has no chain to attach to');
    const wired = apply(state, ops);
    expect(stackFrameOf(wired, box)?.stacks.find((s) => s.kind === 'constraints')?.count).toBe(1);
    expect(stackFrameOf(wired, constraint)?.member).toBe('constraints');
  });

  it('a selected row names its stack and keeps the frame on its object', async () => {
    const { state, box, constraint } = dressedBox();
    const modifier = Object.values(state.nodes).find((n) => n.type === 'ArrayModifier')!.id;
    expect(stackFrameOf(state, modifier)).toMatchObject({ object: box, member: 'modifiers' });
    expect(stackFrameOf(state, constraint)).toMatchObject({ object: box, member: 'constraints' });
    expect(stackFrameOf(state, box)?.member).toBeNull();
  });

  it('a camera has constraints only: no data lane, so no modifier or material stack', () => {
    const state = buildDefaultDagState();
    const camera = Object.values(state.nodes).find(
      (n) =>
        n.type === 'Object' &&
        state.nodes[(n.inputs.data as { node?: string } | undefined)?.node ?? '']?.type ===
          'CameraData',
    );
    if (!camera) throw new Error('the default scene has no split camera to check');
    // #1960 — Modifiers stays as a tab the camera cannot take, so its note lives in the frame.
    expect(
      stackFrameOf(state, camera.id)?.stacks.map((s) => [s.kind, s.count, s.available]),
    ).toEqual([
      ['modifiers', 0, false],
      ['constraints', 0, true],
    ]);
  });

  it('a light, like a camera: an unavailable Modifiers tab, Constraints, and no Materials', () => {
    const state = buildDefaultDagState();
    const light = Object.values(state.nodes).find(
      (n) =>
        n.type === 'Object' &&
        state.nodes[(n.inputs.data as { node?: string } | undefined)?.node ?? '']?.type ===
          'LightData',
    );
    if (!light) throw new Error('the default scene has no split light to check');
    expect(stackFrameOf(state, light.id)?.stacks.map((s) => [s.kind, s.available])).toEqual([
      ['modifiers', false],
      ['constraints', true],
    ]);
  });

  it('a box can take every stack', () => {
    const { state, box } = boxScene();
    expect(stackFrameOf(state, box)?.stacks.every((s) => s.available)).toBe(true);
  });

  it('a character counts its pose layers above the base', async () => {
    let state = buildDefaultDagState();
    const bytes = readFileSync('public/assets/skinned-bar.glb');
    const r = await buildNativeGltfImportOps({
      buffer: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
      assetRef: 'user-imports/native/skinned-bar.glb',
      sceneNodeId: state.outputs.scene!.node,
      storeImage: async () => 'img',
    });
    if ('refused' in r) throw new Error(r.refused);
    state = apply(state, r.ops);
    const mod = Object.values(state.nodes).find((n) => n.type === 'ArmatureModifier')!;
    const armature = (mod.inputs.armature as { node: string }).node;
    expect(stackFrameOf(state, armature)?.animLayers).toEqual({ subject: armature, count: 0 });
    const plan = addLayerPlan(state, armature);
    if (!plan.ok) throw new Error(plan.reason);
    state = apply(state, plan.ops);
    expect(stackFrameOf(state, armature)?.animLayers).toEqual({ subject: armature, count: 1 });
  });
});

describe('flowOf — the order the stacks apply in', () => {
  it('reads Anim layers → Constraints → Modifiers, leaving out what does not apply', async () => {
    const { state, box } = dressedBox();
    const view = stackFrameOf(state, box)!;
    expect(flowOf(view).map((f) => [f.kind, f.count])).toEqual([
      ['constraints', 1],
      ['modifiers', 2],
    ]);
    const withLayers = { ...view, animLayers: { subject: 'x', count: 3 } };
    expect(flowOf(withLayers).map((f) => f.kind)).toEqual([
      'animLayers',
      'constraints',
      'modifiers',
    ]);
  });
});

describe('effectiveStack — which stack shows', () => {
  it('a selected row shows its own stack; else the stored one where it applies; else the first', () => {
    const { state, box, constraint } = dressedBox();
    const view = stackFrameOf(state, box)!;
    expect(effectiveStack(view, 'materials')).toBe('materials');
    expect(effectiveStack(view, 'constraints')).toBe('constraints');
    const member = stackFrameOf(state, constraint)!;
    expect(effectiveStack(member, 'modifiers')).toBe('constraints');
    const cameraLike = { ...view, stacks: view.stacks.filter((s) => s.kind === 'constraints') };
    expect(effectiveStack(cameraLike, 'modifiers')).toBe('constraints');
  });

  // #1960 — a stack the object cannot take shows only while its tab is picked on that object.
  it('never falls back to a stack the object cannot take; a peek at it shows it', () => {
    const { state, box } = dressedBox();
    const view = stackFrameOf(state, box)!;
    const camera = {
      ...view,
      stacks: view.stacks
        .filter((s) => s.kind !== 'materials')
        .map((s) =>
          s.kind === 'modifiers' ? { ...s, count: 0, members: [], available: false } : s,
        ),
    };
    const drawable = ['modifiers', 'constraints'] as const;
    expect(effectiveStack(camera, 'modifiers', drawable)).toBe('constraints');
    expect(effectiveStack(camera, 'materials', drawable)).toBe('constraints');
    expect(effectiveStack(camera, 'constraints', drawable, 'modifiers')).toBe('modifiers');
    // A peek at a stack that is available, or that this selection cannot draw, changes nothing.
    expect(effectiveStack(view, 'constraints', undefined, 'modifiers')).toBe('constraints');
    expect(effectiveStack(camera, 'constraints', ['constraints'], 'modifiers')).toBe('constraints');
    // The flow strip leaves an unavailable stack out.
    expect(flowOf(camera).map((f) => f.kind)).toEqual(['constraints']);
  });
});

// #1959 — the frame holds the stack it shows: the sections that draw each stack go inside it.
describe('frameStackOf — which inspector sections the frame takes in', () => {
  it('takes the Modifier, Constraint, Constraint Stack and Material sections for the stacks it offers', () => {
    const { state, box } = dressedBox();
    const view = stackFrameOf(state, box)!;
    expect(frameStackOf(view, 'modifier')).toBe('modifiers');
    expect(frameStackOf(view, 'constraint')).toBe('constraints');
    expect(frameStackOf(view, 'stack')).toBe('constraints');
    expect(frameStackOf(view, 'material')).toBe('materials');
    // Every other section stays a section of its own.
    for (const other of ['transform', 'driver', 'mesh', 'slots', 'camera', 'light'] as const) {
      expect(frameStackOf(view, other)).toBeNull();
    }
  });

  it('leaves a section alone where the frame does not show, or does not offer its stack', () => {
    expect(frameStackOf(null, 'modifier')).toBeNull();
    const { state, box } = dressedBox();
    const view = stackFrameOf(state, box)!;
    // A frame without a Materials stack leaves the Material section alone.
    const constraintsOnly = {
      ...view,
      stacks: view.stacks.filter((s) => s.kind === 'constraints'),
    };
    expect(frameStackOf(constraintsOnly, 'modifier')).toBeNull();
    expect(frameStackOf(constraintsOnly, 'material')).toBeNull();
    expect(frameStackOf(constraintsOnly, 'constraint')).toBe('constraints');
  });

  it("takes a camera's Modifier section in, as the unavailable tab that carries its note (#1960)", () => {
    const state = buildDefaultDagState();
    const camera = Object.values(state.nodes).find(
      (n) =>
        n.type === 'Object' &&
        state.nodes[(n.inputs.data as { node?: string } | undefined)?.node ?? '']?.type ===
          'CameraData',
    )!;
    const view = stackFrameOf(state, camera.id);
    expect(frameStackOf(view, 'modifier')).toBe('modifiers');
    expect(frameStackOf(view, 'material')).toBeNull();
  });

  it('every stack the switch offers has a section to draw it', () => {
    for (const kind of ['modifiers', 'constraints', 'materials'] as const) {
      expect(FRAME_SECTIONS[kind].length).toBeGreaterThan(0);
    }
  });
});

describe('effectiveStack — with the stacks the inspector can draw for this selection', () => {
  it('shows a stack the selection can draw when the stored one cannot be drawn here', () => {
    const { state, box, base } = dressedBox();
    // The box's data node selected: only its material section is on screen.
    const view = stackFrameOf(state, base)!;
    expect(view.object).toBe(box);
    expect(effectiveStack(view, 'modifiers', ['materials'])).toBe('materials');
    expect(effectiveStack(view, 'materials', ['materials'])).toBe('materials');
    // The object selected draws them all: the stored one wins.
    const objectView = stackFrameOf(state, box)!;
    expect(
      effectiveStack(objectView, 'constraints', ['modifiers', 'constraints', 'materials']),
    ).toBe('constraints');
    // A selected row's stack wins whatever is drawn.
    expect(effectiveStack({ ...objectView, member: 'modifiers' }, 'materials', ['materials'])).toBe(
      'modifiers',
    );
  });
});
