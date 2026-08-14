// #580 — `resolveEvaluatedMesh` is OVERLAY-BLIND, and that is a property of its
// signature rather than a gap in its implementation.
//
// WHY THIS GATE EXISTS. `__basher_modified_vertex_count` (`boot.ts`) is a
// boundary-pair instrument: side A reads the vertex count off the live three
// scene, side B re-derives it through `resolveEvaluatedMesh`. Its comment claimed
// that equality "proves the live render consumed the resolver's geometry handle".
// Under an overlay that claim is false — measured on main, a driven array count
// rendered 3825 vertices while the instrument reported 1275 — and the e2e resting
// on it stayed green only because its fixtures carry no overlay. An instrument
// that disagrees with the screen while every test using it passes is the most
// expensive shape of wrong there is, and this one produced a wrong diagnosis twice.
//
// THE STRUCTURAL REASON, which is why the instrument could not be patched locally.
// `resolveEvaluatedMesh` takes `DagState` — "the graph with params exactly as the
// director authored them" (`core/dag/state.ts`), carrying the `paramsAt: 'authored'`
// phantom. Overlays live in `CookState` (`paramsAt: 'cooked'`), which is NOT
// assignable to `DagState`. So side B cannot see an overlay no matter what it is
// handed: the type wall guarantees it reads authored params. The render root folds;
// the read road does not. The two sides answer different questions by construction.
//
// WHAT THIS GATE IS FOR. It pins the blindness as the CURRENT, DELIBERATE state so
// that the day the read road gains the fold, this file goes red and says so. That
// converts "remember to re-measure #580" into a signal the suite delivers. A red
// here is therefore NOT necessarily a regression — read the issue, re-measure the
// instrument's claim, and widen it if the divergence is genuinely gone.
//
// Routing side B through the overlay repair was considered and rejected: it changes
// what `resolveEvaluatedMesh` returns for two BEHAVIOURAL consumers that pinned
// their own instant on purpose (`dispatchApplyTransform` at ZERO_CTX,
// `geometrySampleSource` at its own ctx), and it would build a second repair road
// while `rebuildGeometryRef` still has a live caller at `overlayWithIdentity.ts:272`
// — the two-spellings problem the cook epic exists to remove.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { buildDefaultDagState } from '../core/project/default';
import { foldOverlays } from './cookState';
import { timeDependentNodes } from './timeDependence';
import { resolveEvaluatedMesh } from './resolveEvaluatedMesh';
import { useTransientEditStore } from './stores/transientEditStore';
import { boxDescriptor } from './modifierGeometry';
import { mintMeshAttributes } from '../nodes/meshAttributes';
import type { EvalCtx } from '../core/dag/types';

const OBJECT_ID = 'n_box';
const DATA_ID = 'n_box_data';

const at = (seconds: number): EvalCtx => ({
  time: { frame: Math.round(seconds * 60), seconds, normalized: 0 },
});

function sizeOfCooked(state: { nodes: Record<string, { params: unknown }> }, id: string) {
  return (state.nodes[id].params as { size: number[] }).size;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
  useTransientEditStore.getState().clearAll();
});

describe('#580 — the resolver does not see overlays, by type', () => {
  it('agrees with the fold when there is NO overlay (the condition the claim holds under)', () => {
    const authored = buildDefaultDagState();
    const cooked = foldOverlays(authored, at(0), timeDependentNodes(authored));

    expect(sizeOfCooked(cooked, DATA_ID)).toEqual([1, 1, 1]);
    const mesh = resolveEvaluatedMesh(authored, OBJECT_ID, at(0));
    expect(mesh!.geometry.descriptor).toEqual({ kind: 'box', size: [1, 1, 1] });
  });

  it('DIVERGES from the fold under a held edit on a geometry-building param', () => {
    const authored = buildDefaultDagState();
    // A held edit on `size` is a geometry-building overlay: it changes the geometry
    // DESCRIPTOR, which is exactly what the vertex-count instrument compares.
    useTransientEditStore.getState().set(DATA_ID, 'size', [3, 1, 1]);

    const cooked = foldOverlays(authored, at(0), timeDependentNodes(authored));

    // The render's view: the fold moved.
    expect(sizeOfCooked(cooked, DATA_ID)).toEqual([3, 1, 1]);

    // Side B's view: unmoved. This is the divergence #580 describes, in one file.
    const mesh = resolveEvaluatedMesh(authored, OBJECT_ID, at(0));
    expect(mesh!.geometry.descriptor).toEqual({ kind: 'box', size: [1, 1, 1] });
  });

  it('the divergence is not about WHICH INSTANT is asked — it is blindness, not skew', () => {
    const authored = buildDefaultDagState();
    useTransientEditStore.getState().set(DATA_ID, 'size', [3, 1, 1]);

    // The control the #580 re-measurement used: a harness comparing a t=2 render
    // against a t=0 resolver would manufacture a divergence it caused itself. Asking
    // side B at several instants returns the SAME authored descriptor every time, so
    // the instant asked is not the variable.
    for (const seconds of [0, 1, 2]) {
      const mesh = resolveEvaluatedMesh(authored, OBJECT_ID, at(seconds));
      expect(mesh!.geometry.descriptor).toEqual({ kind: 'box', size: [1, 1, 1] });
    }
  });

  it('the resolver is not INCAPABLE — it is simply never handed folded params', () => {
    const authored = buildDefaultDagState();
    useTransientEditStore.getState().set(DATA_ID, 'size', [3, 1, 1]);
    const cooked = foldOverlays(authored, at(0), timeDependentNodes(authored));

    // Deliberately defeating the `paramsAt` wall, which nothing in production does
    // and nothing should. The point is diagnostic: handed folded params, the resolver
    // returns the FOLDED descriptor. So the blindness lives at the CALL SITE — the
    // instrument passes `useDagStore.getState().state` — and not in this function.
    // Anyone fixing #580 should change what the caller hands over, not teach the
    // resolver about overlays, which is also what keeps the two behavioural consumers
    // that pinned their own instant from being dragged along.
    const asAuthored = cooked as unknown as Parameters<typeof resolveEvaluatedMesh>[0];
    const mesh = resolveEvaluatedMesh(asAuthored, OBJECT_ID, at(0));

    expect(mesh!.geometry.descriptor).toEqual({ kind: 'box', size: [3, 1, 1] });
    // ...and this is what makes the assertions above discriminating rather than
    // vacuous: the same call returns [1,1,1] from authored state and [3,1,1] from
    // folded state, so those expectations track a real difference.
  });

  it('the geometry HANDLE the instrument builds from carries the authored value', () => {
    const authored = buildDefaultDagState();
    useTransientEditStore.getState().set(DATA_ID, 'size', [3, 1, 1]);

    // The instrument does `getForRead(mesh.geometry)` and counts positions. The key
    // is content-derived, so an authored descriptor means an authored BUFFER — the
    // count side B reports is the authored one, which is the reported symptom.
    const mesh = resolveEvaluatedMesh(authored, OBJECT_ID, at(0));

    // The SIZE half stays a literal, because it is the whole subject: authored
    // `1,1,1` against the overlay's `3,1,1`. The ATTRIBUTE half is derived through
    // the same mint the key uses, following `ns1NoMigration.gate.test.ts` — pinning
    // that hash would pin a number nobody can verify and would red on any unrelated
    // attribute change. Deriving the discriminating half would make the assertion
    // vacuous; deriving this one does not, because it is not what is being claimed.
    const attributes = mintMeshAttributes(boxDescriptor([1, 1, 1]), 'evaluate');
    expect(mesh!.geometry.key).toBe(`box|1,1,1|a:${attributes}`);
    // Written as a PREFIX, not as `not.toBe('box|3,1,1')`: once the key carries an
    // attribute component no whole-key equality against a bare descriptor can ever
    // hold, so the inequality would pass without examining anything.
    expect(mesh!.geometry.key.startsWith('box|3,1,1')).toBe(false);
  });
});
