// #1261 — the census lookup asks `exposedTargetResolver(…, { canApply: false })`, skipping the
// Apply-Transform evaluation, on the claim that which node owns a param path does not depend on
// whether that button shows. This row is the claim, measured over every leaf of a scene built
// with the product's own builders: it reds the day a control keyed on `canApply` starts
// omitting or moving rows.

import { beforeEach, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import { __resetRegistryForTests } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { buildAddPrimitiveOps, SCENE_OBJECT_KINDS } from './addPrimitives';
import { buildAddConstraintOps } from './constraintStack';
import { canApplyTransform } from './animate/dispatchApplyTransform';
import { exposedTargetResolver } from './exposeParams';
import { buildNewMaterialOps } from './materialLink';
import { buildAddModifierOps } from './operatorStack';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const apply = (s: DagState, ops: readonly Op[]) => {
  let n = s;
  for (const op of ops) n = applyOp(n, op).next;
  return n;
};

function leaves(v: unknown, at: string[], out: string[]): string[] {
  if (
    v !== null &&
    typeof v === 'object' &&
    !(Array.isArray(v) && v.every((x) => typeof x === 'number'))
  )
    for (const [k, x] of Object.entries(v)) leaves(x, [...at, k], out);
  else if (at.length > 0) out.push(at.join('.'));
  return out;
}

it('which node owns a param path is the same whether or not Apply Transform is offered', () => {
  let s = buildDefaultDagState();
  const placed: { obj: string; data: string }[] = [];
  for (const kind of SCENE_OBJECT_KINDS) {
    const r = buildAddPrimitiveOps(s, kind, [1, 0, 0]);
    if (!r) continue;
    s = apply(s, r.ops);
    placed.push({ obj: r.newNodeId, data: r.dataNodeId ?? r.newNodeId });
  }
  const [a, b, c] = placed;
  s = apply(s, buildNewMaterialOps(s, a.data)!.ops);
  s = apply(s, buildAddModifierOps(s, b.data, 'UVProjectModifier')!.ops);
  s = apply(s, buildAddConstraintOps(s, c.obj, 'TrackTo')!.ops);

  const differ: string[] = [];
  let asked = 0;
  let offered = 0;
  for (const [id, node] of Object.entries(s.nodes)) {
    if (canApplyTransform(s, id)) offered++;
    const withButton = exposedTargetResolver(s, id, { canApply: true });
    const without = exposedTargetResolver(s, id, { canApply: false });
    for (const path of leaves(node.params, [], [])) {
      asked++;
      const x = JSON.stringify(withButton(path));
      const y = JSON.stringify(without(path));
      if (x !== y) differ.push(`${id} ${path}: ${x} vs ${y}`);
    }
  }
  expect(differ).toEqual([]);
  // The comparison means something only if some node really offers the button, and many
  // paths were asked: an empty scene would pass this row.
  expect({ offered: offered > 0, asked: asked > 100 }).toEqual({ offered: true, asked: true });
});
