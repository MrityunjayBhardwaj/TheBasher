// #714 — A SCOPE-BEARING DESCRIPTOR RECORDS WHICH ATOM CLASS IT NAMES.
//
// ── WHAT WAS WRONG, AND WHY IT WAS INVISIBLE ──────────────────────────────────────────
//
// `componentSelection.ts` held `const SCOPE_DOMAIN: KnownDomain = 'face'` — one module-private
// value every resolution silently agreed with. A `subset` descriptor then stored `{source,
// scope, keep}` and keyed as `subset|<source>|<query>|<keep>`. The class was known at resolve
// time and discarded exactly where the data becomes durable.
//
// Nothing about that is wrong TODAY, because `face` is the only class a scope resolves at, and
// that is precisely what makes it hard to see: every test passes, every mesh draws, and the
// omission is a statement about a future the code has already committed to. `0-5` is a string
// of indices that says nothing about what it indexes, so the day a second class is resolvable
// the SAME key names two different geometries — the same faces or the same points — and they
// share one cached build. Both draw. That is the shape this file is a detector for.
//
// ── WHY THE ROWS CAST TO A DOMAIN THAT DOES NOT EXIST YET ─────────────────────────────
//
// A collision needs TWO domains, and it must be constructible from a domain no operator
// declares — a row that cannot construct the failure is not a detector, it is a description.
// The cast is not a workaround for the type: it is how a second domain ACTUALLY arrives, since
// vitest strips types without checking them, and it lets the collision be built and measured
// one edit before a widening rather than one edit after.
//
// ⚠️ THE CAST IS STILL A CAST AFTER #827, AND THAT IS THE POINT. This file used to say
// `ScopeDomain` was `'face'` alone; #827 widened it to `['face', 'edge']` and these rows stayed
// green — correctly, because they name `'point'`, which is still undeclared. The detector is
// about two domains sharing one key, not about which two, so it keeps its meaning through every
// widening and only loses it if `SCOPE_DOMAINS` ever admits every member of `KnownDomain`.
//
// REF: src/nodes/attributes.ts (`SCOPE_DOMAINS` / `ScopeDomain`); src/core/dag/types.ts
//      (`ScopeKind`, where an operator declares it); src/app/modifierGeometry.ts
//      (`scopeField` / `scopeSuffix` — the pair and the key fragment);
//      src/app/geometryRegistry.ts (`elementSubset`); issues #714, #628.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  arrayGeometryRef,
  boxGeometryRef,
  mirrorGeometryRef,
  subsetGeometryRef,
} from './modifierGeometry';
import { clear, getForRead } from './geometryRegistry';
import { __resetRegistryForTests, getNodeType, listNodeTypes } from '../core/dag/registry';
import { registerAllNodes } from '../nodes/registerAll';
import { SCOPE_DOMAINS, type ScopeDomain } from '../nodes/attributes';

const BOX_SIZE: [number, number, number] = [1, 1, 1];
const box = () => boxGeometryRef(BOX_SIZE, null);

/** The class no scope resolves at yet — how a second domain arrives before it is declared. */
const NOT_YET = 'point' as unknown as ScopeDomain;

beforeEach(() => {
  clear();
});

describe('#714 — the atom class reaches the KEY, so two domains cannot share one build', () => {
  it('🔴 THE COLLISION, CONSTRUCTED — one query at two classes mints two keys', () => {
    // The row that fails on the pre-#714 tree. There the key is
    // `subset|box|1,1,1|0-3|true` for BOTH, so whichever built first is handed to both, and
    // the second one draws the first one's triangles with no error anywhere.
    const a = subsetGeometryRef(box(), '0-3', true, 'face');
    const b = subsetGeometryRef(box(), '0-3', true, NOT_YET);

    expect(a.key).not.toBe(b.key);
    // Asserted as the literal string rather than "contains the domain": a key is an identity,
    // and a row that only checks the fragment is present passes on a key that appends it in
    // two different places for the two generators.
    expect(a.key).toBe('subset|box|1,1,1|0-3|face|true');
  });

  it('🔴 …and the same for both SCOPED GENERATORS, which append it through one helper', () => {
    // `array` and `mirror` each built this fragment inline before #714. One helper now, so
    // the two cannot spell it differently — which is a claim about them AGREEING, and is
    // therefore asserted on both rather than on whichever one is convenient.
    expect(arrayGeometryRef(box(), 3, [2, 0, 0], '0-5', 'face').key).not.toBe(
      arrayGeometryRef(box(), 3, [2, 0, 0], '0-5', NOT_YET).key,
    );
    expect(mirrorGeometryRef(box(), 'x', 0, '0-5', 'face').key).not.toBe(
      mirrorGeometryRef(box(), 'x', 0, '0-5', NOT_YET).key,
    );
  });

  it('🔴 an UNSCOPED generator key is byte-identical to what it was before this existed', () => {
    // The property `scope` itself was introduced under, and the one #714 could most easily
    // have broken: emitting the domain unconditionally would re-key every unscoped array and
    // mirror in every project — a total cache miss, silent, and visible only as a stall.
    // Both fragments live inside the same branch for exactly this reason.
    expect(arrayGeometryRef(box(), 3, [2, 0, 0]).key).toBe('array|box|1,1,1|3|2,0,0');
    expect(mirrorGeometryRef(box(), 'x', 0).key).toBe('mirror|box|1,1,1|x|0');
  });

  it('the class is stored on the descriptor, and ONLY beside a scope', () => {
    // The pair has one constructor, so half of it is unrepresentable in practice even though
    // the type would permit it. A domain with no query is a fact about nothing; a query with
    // no class is a selection nobody can resolve.
    const scoped = arrayGeometryRef(box(), 3, [2, 0, 0], '0-5', 'face');
    expect(scoped.descriptor).toMatchObject({ scope: '0-5', domain: 'face' });

    const unscoped = arrayGeometryRef(box(), 3, [2, 0, 0]);
    expect(Object.keys(unscoped.descriptor)).not.toContain('domain');
    expect(Object.keys(unscoped.descriptor)).not.toContain('scope');
  });
});

describe('#714 — a class nothing implements REFUSES rather than falling through to faces', () => {
  it('🔴 `elementSubset` names the domain it has no arm for, and builds nothing', () => {
    // The `never` default, exercised. Before #714 there was no dispatch at all: the query was
    // read as faces whatever it meant, so a point subset of a box would have built 4 perfectly
    // valid triangles that answer a question nobody asked.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const ref = subsetGeometryRef(box(), '0-3', true, NOT_YET);
      expect(getForRead(ref)).toBeNull();
      expect(err).toHaveBeenCalledWith(expect.stringContaining('no subset arm for domain'));
      expect(err).toHaveBeenCalledWith(expect.stringContaining('point'));
    } finally {
      err.mockRestore();
    }
  });
});

describe('#714 — every scoped operator DECLARES its class', () => {
  it('a `source` or `target` chain names a domain a scope is actually resolvable at', () => {
    __resetRegistryForTests();
    registerAllNodes();

    const scoped = listNodeTypes().filter((type) => {
      const kind = getNodeType(type)!.chain?.scope.kind;
      return kind === 'source' || kind === 'target';
    });
    // A floor, not an exact count: this set GROWS with every new scoped operator, and pinning
    // it exactly would make adding one a two-file change for no gain. The size assertion is
    // still load-bearing — a census over an EMPTY set is green, and this one empties the
    // moment `chain` or `scope` is renamed.
    expect(scoped.length).toBeGreaterThanOrEqual(5);

    const undeclared = scoped.filter((type) => {
      const scope = getNodeType(type)!.chain!.scope as { domain?: unknown };
      return typeof scope.domain !== 'string' || !SCOPE_DOMAINS.includes(scope.domain as never);
    });
    // Named, not counted — a reader who fixes the first one should not have to re-run to
    // discover the second.
    expect({ scoped, undeclared }).toEqual({ scoped, undeclared: [] });
  });
});
