// GATE — one owner for a transform gizmo's lifetime (#657).
//
// drei's `TransformControls` detaches on unmount and never disposes, so every mount site is
// a leak of 17 GL geometries per select/deselect cycle, linear and unbounded. `TransformGizmo`
// is the wrapper that adds the disposal, and the only value of a wrapper is that it is the
// ONLY door — a fifth site importing drei directly reintroduces the whole defect while every
// existing test stays green, because nothing renders wrong and the number merely climbs.
//
// ⚠️ THIS GATE WAS RUN BEFORE THE FIX AND IT REDDED, naming both offenders — `Gizmo.tsx` and
// `CurvePointHandles.tsx`. A structural gate written after the work has only ever been shown
// to agree with it; one that never redded is not a detector.
//
// The census strips comments first: several comments here legitimately discuss the
// underlying three.js `TransformControls`, and a raw-source count reads those as imports.
//
// REF: src/app/TransformGizmo.tsx (the owner, and the measurement); issue #657.

import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { stripComments } from '../test-utils/sourceScan';

/** The one module allowed to reach drei's `TransformControls` directly. */
const OWNER = 'src/app/TransformGizmo.tsx';

describe('#657 — the transform gizmo has exactly one lifetime owner', () => {
  it('lets only the wrapper import TransformControls from drei', () => {
    const importers = sourceFiles()
      .filter(([, src]) => {
        const code = stripComments(src);
        return /import\s*\{[^}]*\bTransformControls\b[^}]*\}\s*from\s*['"]@react-three\/drei['"]/.test(
          code,
        );
      })
      .map(([path]) => path)
      .sort();

    expect(importers).toEqual([OWNER]);
  });

  it('routes every JSX mount site through the wrapper', () => {
    // The denominator matters: `toEqual([])` on the offenders would also pass if the walk
    // found no gizmo sites at all, which is what a renamed component or a narrowed file
    // enumeration looks like. So the count of real sites is asserted too.
    const offenders: string[] = [];
    let mountSites = 0;
    for (const [path, src] of sourceFiles()) {
      const code = stripComments(src);
      for (const m of code.matchAll(/<TransformControls[\s/>]/g)) {
        void m;
        if (path !== OWNER) offenders.push(path);
      }
      for (const m of code.matchAll(/<TransformGizmo[\s/>]/g)) {
        void m;
        mountSites++;
      }
    }

    expect(offenders.sort()).toEqual([]);
    expect(mountSites).toBe(4);
  });

  it('keeps the disposal the wrapper exists for', () => {
    const owner = sourceFiles().find(([path]) => path === OWNER);
    expect(owner, `${OWNER} is missing`).toBeDefined();
    const code = stripComments(owner![1]);

    // `.dispose()` on the instance the callback ref handed us. A `useRef` here would read
    // `current` as null during the unmount commit and free nothing — a fix that measures
    // exactly like no fix — so the ref shape is pinned, not just the dispose call.
    expect(code).toMatch(/\.dispose\(\)/);
    expect(code).toMatch(/ref=\{setControls\}/);
    expect(code, 'a useRef here would silently free nothing on unmount').not.toMatch(/useRef/);
  });
});
