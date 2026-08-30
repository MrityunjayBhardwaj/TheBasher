// #812 — a tiled face order that can say a face came from NOWHERE.
//
// ── WHY THIS FILE EXISTS, AND WHAT IT CANNOT DO ───────────────────────────────────────
//
// The change is a type widening: `TiledFaceOrder.order` went from `readonly number[]` to
// `readonly SourceFace[]`, where `null` means the face was MINTED rather than mapped from a
// source. Seven consumer arms follow from it. **No descriptor kind can produce a hole today** —
// `array`, `mirror` and `subset` map every output face to a source face by construction — so
// every one of those arms is unreachable in production until a minting kind exists.
//
// That is the exact shape of a claim with no reader, which can be wrong and green at the same
// time. So this file does two separate jobs and is explicit about which rows do which:
//
//   HALF A — the widening is BEHAVIOUR-PRESERVING. For a census of real descriptors the
//            narrowing must be the IDENTITY, not merely equal: same object, no allocation.
//   HALF B — the hole is EXERCISED. A synthetic holed order is driven through every arm that
//            can be reached from outside its own module, and the three that cannot are held by
//            a source tripwire that says so rather than pretending to test them.
//
// 🔴 THREE ARMS ARE HELD BY A TRIPWIRE, NOT BY AN EXECUTION, AND THAT IS STATED RATHER THAN
// HIDDEN. `faceArityOf`, `faceCornersOf` and `tiledCornerOrder` call `tiledFaceOrder` from
// INSIDE `faceCount.ts`, so a module mock cannot intercept the call and no descriptor can make
// it hole. The tripwire asserts each routes through `mappedFacesOf`; it would survive an arm
// that routes correctly and then does the wrong thing with the answer. The day a minting kind
// exists these three become executable rows and the tripwire should be replaced, not kept.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mappedFacesOf,
  tiledFaceOrder,
  faceArityOf,
  faceCornersOf,
  faceCountOf,
  tiledCornerOrder,
} from './faceCount';
import type { SourceFace, TiledFaceOrder } from './faceCount';
import { carriageForDomain } from '../nodes/meshAttributes';
import { tiledPointOrder } from './pointIdentity';
import { weldedPolygonsOf } from './edgeIdentity';
import {
  arrayGeometryRef,
  boxGeometryRef,
  mirrorGeometryRef,
  subsetGeometryRef,
} from './modifierGeometry';
import { clear } from './geometryRegistry';
import { MATERIAL_INDEX, type AttributeData } from '../nodes/attributes';
import { mintAttributes } from '../nodes/attributeKey';
import { insert } from './attributeStore';
import type { GeometryDescriptor } from '../nodes/types';

const SIZE: [number, number, number] = [1, 1, 1];

function source() {
  const minted = mintAttributes({
    [MATERIAL_INDEX]: {
      domain: 'face',
      type: 'int',
      count: 6,
      data: new Int32Array([0, 0, 0, 1, 1, 1]),
    } as AttributeData,
  })!;
  insert(minted.key, minted.set, 'evaluate');
  return boxGeometryRef(SIZE, minted.key);
}

/** Every kind that has an order today, plus a nesting, so the census is not one shape. */
function census(): [string, GeometryDescriptor][] {
  const s = source();
  const array = arrayGeometryRef(s, 3, [2, 0, 0]);
  return [
    ['array x3', array.descriptor],
    ['mirror x', mirrorGeometryRef(s, 'x', 0).descriptor],
    ['subset 0-2', subsetGeometryRef(s, '0-2', true).descriptor],
    ['mirror(array x3)', mirrorGeometryRef(array, 'z', 0).descriptor],
  ];
}

beforeEach(() => clear());

describe('HALF A — the widening is behaviour-preserving for every kind that exists', () => {
  it('1 — 🔴 no existing kind produces a hole, and the narrowing is the IDENTITY not a copy', () => {
    const rows = census();
    expect(rows.length, 'the census must not be empty — a vacuous loop reports the same pass').toBe(
      4,
    );
    for (const [name, descriptor] of rows) {
      const tiled = tiledFaceOrder(descriptor);
      expect(tiled, `${name} lost its face order`).not.toBeNull();
      expect(
        tiled!.order.some((f) => f === null),
        `${name} produced a hole`,
      ).toBe(false);
      // `toBe`, not `toEqual`. An equal-but-fresh array misses every memo keyed on the order
      // object and allocates on the per-evaluate road — the defect the first draft of
      // `mappedFacesOf` shipped, caught by `classCarriage.gate.test.ts` row 4.
      expect(mappedFacesOf(tiled!.order), `${name} was copied rather than narrowed`).toBe(
        tiled!.order,
      );
    }
  });

  it('2 — 🔴 all four consumers still answer, and the answers are NOT EMPTY', () => {
    // 🔴 THE LENGTH CHECKS ARE NOT DECORATION. The first draft of this row asserted only
    // `not.toBeNull()`, and it passed for a subset descriptor built with its arguments in the
    // wrong order — `subsetGeometryRef(source, scope, keep, domain)`, called as if `domain` came
    // third. That descriptor selected nothing, every consumer answered `[]`, and an empty answer
    // is not null. A consumer that has stopped answering and one that answers about no elements
    // read identically through a null check alone.
    const faces = faceCountOf(census()[0][1]);
    expect(faces, 'the census anchor must have faces for the lengths below to mean anything').toBe(
      18,
    );
    for (const [name, descriptor] of census()) {
      const count = faceCountOf(descriptor);
      expect(count, `${name} has no faces — the row would pass vacuously`).toBeGreaterThan(0);
      expect(faceArityOf(descriptor), `${name} arity`).toHaveLength(count!);
      expect(faceCornersOf(descriptor), `${name} corners`).toHaveLength(count!);
      expect(tiledCornerOrder(descriptor)!.order.length, `${name} corner order`).toBeGreaterThan(0);
      expect(weldedPolygonsOf(descriptor), `${name} welded rims`).toHaveLength(count!);
    }
  });

  it('3 — the anchor literals are unchanged: an array x3 of a box is 18 faces, all quads', () => {
    const [, arrayDescriptor] = census()[0];
    const arity = faceArityOf(arrayDescriptor)!;
    expect(arity.length).toBe(18);
    // ⚠️ THE ENTRIES ARE TRIANGLES PER FACE, NOT CORNERS PER FACE, and the literal is written
    // from the function's own documented measurement rather than from its name: *"an Array x3 of
    // a box gives 18 polygons / 36 triangles / 108 index entries against a built 108"*. A box
    // face is a quad, so each entry is 2. Asserting 4 here would be reading the word "arity".
    expect(new Set(arity)).toEqual(new Set([2]));
    expect(arity.reduce((a, b) => a + b, 0) * 3).toBe(108);
    expect(tiledFaceOrder(arrayDescriptor)!.order).toEqual([
      0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5,
    ]);
  });
});

describe('HALF B — the hole is exercised where it can be reached', () => {
  it('4 — 🔴 mappedFacesOf refuses a holed order, and refuses the WHOLE order', () => {
    const holed: readonly SourceFace[] = [0, 1, null, 2];
    expect(mappedFacesOf(holed)).toBeNull();
    // Both-or-neither: a partial answer is a length that no longer matches the face count, and
    // every size check downstream would compare against it and fail for the wrong reason.
    expect(mappedFacesOf([0, 1, 2])).toEqual([0, 1, 2]);
    // A hole anywhere, not just at the end.
    expect(mappedFacesOf([null, 0])).toBeNull();
    expect(mappedFacesOf([0, null])).toBeNull();
    // An empty order is mapped, not holed — `array(subset(box,"99"), 2)` has no faces at all.
    expect(mappedFacesOf([])).toEqual([]);
  });

  it('5 — 🔴 carriageForDomain REFUSES a holed face order rather than gathering through it', () => {
    const s = source();
    const array = arrayGeometryRef(s, 3, [2, 0, 0]);
    const faces = tiledFaceOrder(array.descriptor)!;
    const corners = tiledCornerOrder(array.descriptor)!;
    const points = tiledPointOrder(array.descriptor)!;
    const data: AttributeData = {
      domain: 'face',
      type: 'int',
      count: 6,
      data: new Int32Array([0, 0, 0, 1, 1, 1]),
    };

    // The control: the same call with the real order lays out.
    expect(carriageForDomain(data, 'array', faces, corners, points).kind).toBe('laid-out');

    // The arm: one face minted is enough.
    const holed: TiledFaceOrder = {
      sourceFaces: faces.sourceFaces,
      order: [...faces.order.slice(0, -1), null],
    };
    const verdict = carriageForDomain(data, 'array', holed, corners, points);
    expect(verdict.kind).toBe('refused');
    if (verdict.kind !== 'refused') throw new Error('unreachable — asserted above');
    // Refused, not DROPPED: a drop is about a class and is true for every descriptor; this is
    // about this operator and this datum, which is the distinction `ClassCarriage` draws.
    expect(verdict.until).toBe('#786');
    expect(verdict.why).toMatch(/mint/i);
  });

  it('6 — 🔴 weldedPolygonsOf refuses a holed order — a minted face has no source rim to copy', async () => {
    vi.resetModules();
    const real = await vi.importActual<typeof import('./faceCount')>('./faceCount');
    vi.doMock('./faceCount', () => ({
      ...real,
      tiledFaceOrder: (descriptor: GeometryDescriptor) => {
        const tiled = real.tiledFaceOrder(descriptor);
        if (tiled === null) return null;
        return { sourceFaces: tiled.sourceFaces, order: [...tiled.order.slice(0, -1), null] };
      },
    }));
    const { weldedPolygonsOf: welded } = await import('./edgeIdentity');
    const { arrayGeometryRef: arr, boxGeometryRef: box } = await import('./modifierGeometry');
    const { insert: ins } = await import('./attributeStore');
    const minted = mintAttributes({
      [MATERIAL_INDEX]: {
        domain: 'face',
        type: 'int',
        count: 6,
        data: new Int32Array([0, 0, 0, 1, 1, 1]),
      } as AttributeData,
    })!;
    ins(minted.key, minted.set, 'evaluate');
    const descriptor = arr(box(SIZE, minted.key), 3, [2, 0, 0]).descriptor;
    expect(welded(descriptor)).toBeNull();
    vi.doUnmock('./faceCount');
    vi.resetModules();
  });

  it('7 — 🔴 TRIPWIRE: the three intra-module consumers each route through mappedFacesOf', () => {
    // NOT a behavioural test, and the header says why it cannot be one. It fails the day someone
    // adds an arm that indexes a source array with an order entry without asking whether the
    // entry names anything — which is the whole failure class this issue exists to close.
    const src = readFileSync(join(__dirname, 'faceCount.ts'), 'utf8');
    for (const fn of ['faceArityOf', 'faceCornersOf', 'tiledCornerOrder']) {
      const start = src.indexOf(`export function ${fn}(`);
      expect(
        start,
        `${fn} is no longer an exported function — this tripwire has gone vacuous`,
      ).toBeGreaterThan(-1);
      const next = src.indexOf('\nexport function ', start + 1);
      const body = src.slice(start, next === -1 ? src.length : next);
      expect(body, `${fn} reads an order without going through mappedFacesOf`).toContain(
        'mappedFacesOf(',
      );
    }
  });
});
