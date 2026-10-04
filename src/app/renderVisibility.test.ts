// #1503 — the viewport and the render are asked apart, as Blender asks them: measured in Blender
// 5.1.1 (Cycles, headless), an object with its eye off still renders (pixel mean 0.354) and one
// with its render toggle off does not (0.0); a collection's own render toggle removes its members
// from the render the same way, and only when every collection holding them is off (#1481).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { buildAddPrimitiveOps } from './addPrimitives';
import { hiddenNodes, membershipOps, newCollectionOps, ownShown, setShownOp } from './collections';
import {
  RENDER_VISIBILITY_KEY,
  isUnderRenderOnly,
  renderVisibilityStamps,
  withRenderVisibility,
} from './renderVisibility';
import { migrateHiddenToVisibilityParams } from '../core/project/migrations';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const apply = (state: DagState, ops: readonly (Op | null)[]) =>
  ops.reduce((s, op) => (op ? applyOp(s, op).next : s), state);

function cube(): { state: DagState; id: string } {
  const s = buildDefaultDagState();
  const r = buildAddPrimitiveOps(s, 'Cube', [0, 0, 0])!;
  return { state: apply(s, r.ops), id: r.newNodeId };
}

describe('#1503 — the viewport and the render are asked apart', () => {
  it('the eye (viewport off) keeps a node in the render; render off keeps it in the viewport', () => {
    const { state, id } = cube();
    const eye = apply(state, [setShownOp(state, id, 'viewport', false)]);
    expect(hiddenNodes(eye, 'viewport').has(id)).toBe(true);
    expect(hiddenNodes(eye, 'render').has(id)).toBe(false);
    const noRender = apply(state, [setShownOp(state, id, 'render', false)]);
    expect(hiddenNodes(noRender, 'viewport').has(id)).toBe(false);
    expect(hiddenNodes(noRender, 'render').has(id)).toBe(true);
  });

  it('a collection’s render flag takes its members out of the render alone', () => {
    const { state: s0, id } = cube();
    const made = newCollectionOps(s0)!;
    const s1 = apply(s0, [...made.ops, ...membershipOps(made.collectionId, [id])]);
    const s = apply(s1, [setShownOp(s1, made.collectionId, 'render', false)]);
    expect(hiddenNodes(s, 'render').has(id)).toBe(true);
    expect(hiddenNodes(s, 'viewport').has(id)).toBe(false);
  });

  it('setShownOp: off writes false, on clears the flag, and a write that changes nothing is no op', () => {
    const { state, id } = cube();
    expect(setShownOp(state, id, 'viewport', true)).toBeNull();
    const off = setShownOp(state, id, 'viewport', false)!;
    expect(off).toEqual({ type: 'setParam', nodeId: id, paramPath: 'viewport', value: false });
    const hidden = apply(state, [off]);
    expect(setShownOp(hidden, id, 'viewport', false)).toBeNull();
    const shown = apply(hidden, [setShownOp(hidden, id, 'viewport', true)]);
    expect(ownShown(shown.nodes[id], 'viewport')).toBe(true);
    // A node type with no flags has no op: an eye on it would hide nothing.
    const data = Object.values(state.nodes).find((n) => n.type === 'BoxData')!;
    expect(setShownOp(state, data.id, 'viewport', false)).toBeNull();
  });

  it('the stamps: viewport-hidden alone is render-only, render-hidden alone is viewport-only', () => {
    const stamps = renderVisibilityStamps(new Set(['a', 'both']), new Set(['b', 'both']));
    expect([...stamps]).toEqual([
      ['a', 'render-only'],
      ['b', 'viewport-only'],
    ]);
  });
});

describe('#1503 — the render shows what the render is meant to', () => {
  function scene() {
    const root = new THREE.Scene();
    const renderOnly = new THREE.Group();
    renderOnly.visible = false;
    renderOnly.userData[RENDER_VISIBILITY_KEY] = 'render-only';
    const viewportOnly = new THREE.Group();
    viewportOnly.userData[RENDER_VISIBILITY_KEY] = 'viewport-only';
    const plain = new THREE.Mesh();
    const hiddenByHand = new THREE.Mesh();
    hiddenByHand.visible = false;
    const inner = new THREE.Mesh();
    renderOnly.add(inner);
    root.add(renderOnly, viewportOnly, plain, hiddenByHand);
    return { root, renderOnly, viewportOnly, plain, hiddenByHand, inner };
  }

  it('for the span of the render: render-only shown, viewport-only hidden, the rest untouched', () => {
    const s = scene();
    const during = withRenderVisibility(s.root, () => [
      s.renderOnly.visible,
      s.viewportOnly.visible,
      s.plain.visible,
      s.hiddenByHand.visible,
    ]);
    expect(during).toEqual([true, false, true, false]);
    expect([s.renderOnly.visible, s.viewportOnly.visible, s.plain.visible]).toEqual([
      false,
      true,
      true,
    ]);
  });

  it('puts the scene back even when the render throws', () => {
    const s = scene();
    expect(() =>
      withRenderVisibility(s.root, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect([s.renderOnly.visible, s.viewportOnly.visible]).toEqual([false, true]);
  });

  it('a click never lands on a render-only body', () => {
    const s = scene();
    expect(isUnderRenderOnly(s.inner)).toBe(true);
    expect(isUnderRenderOnly(s.plain)).toBe(false);
    expect(isUnderRenderOnly(s.viewportOnly)).toBe(false);
  });
});

describe('#1503 — a project saved with meta.hidden migrates (format v20 → v21)', () => {
  const v20 = (nodes: Record<string, unknown>) => ({ formatVersion: 20, state: { nodes } });

  it('a hidden Object, Group or Collection is off in both; its other meta stays; the rest is as it was', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = migrateHiddenToVisibilityParams(
      v20({
        o: {
          type: 'Object',
          params: { position: [1, 2, 3] },
          meta: { name: 'Hero', hidden: true },
        },
        g: { type: 'Group', params: {}, meta: { hidden: true } },
        c: { type: 'Collection', params: {}, meta: { name: 'A', hidden: true } },
        shown: { type: 'Object', params: {}, meta: { name: 'Shown' } },
        wrap: { type: 'Transform', params: {}, meta: { hidden: true } },
      }),
    ) as {
      formatVersion: number;
      state: { nodes: Record<string, { params: unknown; meta?: unknown }> };
    };
    const n = out.state.nodes;
    expect(out.formatVersion).toBe(21);
    expect(n.o).toEqual({
      type: 'Object',
      params: { position: [1, 2, 3], viewport: false, render: false },
      meta: { name: 'Hero' },
    });
    expect(n.g).toEqual({ type: 'Group', params: { viewport: false, render: false } });
    expect(n.c.meta).toEqual({ name: 'A' });
    expect(n.shown).toEqual({ type: 'Object', params: {}, meta: { name: 'Shown' } });
    // A wrapper's flag hid no body of its own: dropped, and said so.
    expect(n.wrap).toEqual({ type: 'Transform', params: {} });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('wrap (Transform)');
    warn.mockRestore();
  });

  it('a project with nothing hidden only moves its stamp, and says nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const nodes = { o: { type: 'Object', params: {} } };
    const out = migrateHiddenToVisibilityParams(v20(nodes)) as {
      formatVersion: number;
      state: { nodes: unknown };
    };
    expect(out.formatVersion).toBe(21);
    expect(out.state.nodes).toEqual(nodes);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
