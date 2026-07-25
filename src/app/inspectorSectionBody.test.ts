// #458 — the shared section-body table.
//
// Three groups of assertions:
//
//  1. The table is complete and every control it names is reachable.
//  2. Row suppression moved from ONE global key filter to PER-SECTION
//     `omitRowKeys`. That is only safe because each suppressed key routes to
//     exactly the section that suppresses it — a claim about `paramToSection`,
//     pinned here rather than asserted in a comment.
//  3. Possession is asked of the node's SCHEMA, not of its live params. Each
//     case below is a control that WOULD have vanished had the predicate read
//     the params object: an `.optional()` param that never materializes, a
//     param added without a version bump (so old saves lack it), and a section
//     whose node owns no param of that name at all.

import { beforeAll, describe, expect, it } from 'vitest';
import { emptyDagState } from '../core/dag/state';
import type { DagState } from '../core/dag/state';
import { SECTION_IDS, paramToSection, type SectionId } from './inspectorSections';
import {
  SECTION_CONTROLS,
  makeSectionCtx,
  sectionRendersCustomControl,
  type ControlKey,
} from './inspectorSectionBody';
import { __reseedAllNodesForTests } from '../nodes/registerAll';

// The registry is populated by a side-effecting boot step in the real app.
beforeAll(() => {
  __reseedAllNodesForTests();
});

/** A one-node state whose params are EMPTY — the state every assertion below
 *  cares about, because it is the one where "is the key on the instance?" and
 *  "does the type declare it?" disagree. */
function stateWithNode(id: string, type: string, params: Record<string, unknown> = {}): DagState {
  return {
    ...emptyDagState(),
    nodes: { [id]: { id, type, version: 1, params, inputs: {} } },
  };
}

function ctxFor(type: string, params: Record<string, unknown> = {}, canApply = false) {
  return makeSectionCtx(stateWithNode('n', type, params), 'n', 'n', canApply);
}

describe('#458 SECTION_CONTROLS — shape', () => {
  it('covers every section id (exhaustive, not partial)', () => {
    expect(Object.keys(SECTION_CONTROLS).sort()).toEqual([...SECTION_IDS].sort());
  });

  it('names each control exactly once, so no table row is unreachable', () => {
    const keys = Object.values(SECTION_CONTROLS).flatMap((cs) => cs.map((c) => c.key));
    expect(keys.length).toBe(new Set(keys).size);
    // Guard the guard: a table that lost its entries would satisfy the two
    // assertions above vacuously.
    expect(keys.length).toBeGreaterThanOrEqual(13);
  });

  it('places the two transform controls BELOW the rows and everything else above', () => {
    const after = Object.values(SECTION_CONTROLS)
      .flat()
      .filter((c) => c.placement === 'after')
      .map((c) => c.key);
    expect(after.sort()).toEqual(['applyTransform', 'setOrigin']);
  });
});

describe('#458 per-section row suppression is equivalent to the global filter it replaces', () => {
  // Every section that declares the key, so the routing question is asked the
  // way the inspector asks it.
  const sectionsDeclaring = (id: SectionId): readonly SectionId[] => [id];

  it('routes each suppressed key ONLY to the section that suppresses it', () => {
    for (const sectionId of SECTION_IDS) {
      for (const control of SECTION_CONTROLS[sectionId]) {
        for (const key of control.omitRowKeys ?? []) {
          // The key routes INTO this section...
          expect(paramToSection(key, sectionsDeclaring(sectionId))).toBe(sectionId);
          // ...and into no OTHER section, which is what makes dropping the old
          // global filter a no-op rather than a behaviour change.
          for (const other of SECTION_IDS) {
            if (other === sectionId) continue;
            expect(paramToSection(key, sectionsDeclaring(other))).not.toBe(other);
          }
        }
      }
    }
  });

  it('suppresses the same keys the global filter did', () => {
    const omitted = Object.values(SECTION_CONTROLS)
      .flat()
      .flatMap((c) => c.omitRowKeys ?? []);
    expect(omitted.sort()).toEqual(['extendAfter', 'extendBefore', 'modifiers', 'points']);
  });
});

describe('#458 possession is asked of the schema, not of the live params', () => {
  it('offers the slot selector to a MaterialOverride that has no slotIndex yet', () => {
    // `slotIndex` is `.optional()` with no default, so it is absent until a
    // slot is chosen — with the selector this assertion is about. Reading the
    // params object would make the control unreachable by construction.
    expect(ctxFor('MaterialOverride').ownsParam('slotIndex')).toBe(true);
    expect(sectionRendersCustomControl('material', ctxFor('MaterialOverride'))).toBe(true);
  });

  it('offers Set Origin to a Group saved before `pivot` existed', () => {
    // `pivot` was added to Group WITHOUT a version bump, and loading a project
    // does not re-parse per-type param schemas, so an old Group has no such key.
    expect(ctxFor('Group').ownsParam('pivot')).toBe(true);
    expect(sectionRendersCustomControl('transform', ctxFor('Group'))).toBe(true);
  });

  it('renders the environment control for a Scene whose params are empty', () => {
    // The Scene owns envSource/envIntensity/envRotationY/envBackground — there
    // is no `environment` param to possess. Declaring the section is the
    // assertion of ownership.
    expect(sectionRendersCustomControl('environment', ctxFor('Scene'))).toBe(true);
  });

  it('offers the extend + F-Modifier controls to the three channels that own them', () => {
    for (const type of [
      'KeyframeChannelNumber',
      'KeyframeChannelVec2',
      'KeyframeChannelVec3',
    ] as const) {
      expect(sectionRendersCustomControl('animate', ctxFor(type))).toBe(true);
    }
    // ...and to no other channel kind: Color/Quat/Text/Image declare `animate`
    // but own no extend rules, so the section is plain rows for them.
    for (const type of [
      'KeyframeChannelColor',
      'KeyframeChannelQuat',
      'KeyframeChannelText',
      'KeyframeChannelImage',
    ] as const) {
      expect(sectionRendersCustomControl('animate', ctxFor(type))).toBe(false);
    }
  });

  it('picks the glTF editor over the readout only when materials were captured', () => {
    const withMaterials = ctxFor('GltfChild', {
      assetRef: 'a',
      childName: 'c',
      materials: [{ name: 'm' }],
    });
    const without = ctxFor('GltfChild', { assetRef: 'a', childName: 'c', materials: [] });
    const active = (c: ReturnType<typeof ctxFor>): ControlKey[] =>
      SECTION_CONTROLS.material.filter((x) => x.applies(c)).map((x) => x.key);
    expect(active(withMaterials)).toEqual(['gltfMaterialEditor']);
    expect(active(without)).toEqual(['gltfMaterialReadout']);
    // The whole-asset node keeps the read-only readout.
    expect(active(ctxFor('GltfAsset', { assetRef: 'a' }))).toEqual(['gltfMaterialReadout']);
  });

  it('names no node type anywhere in the table', () => {
    // The table decides by possession. A node-type gate here is the failure the
    // dispatcher exists to prevent — a fused type named in a predicate stops
    // matching the day that kind splits, and the section renders empty.
    const source = Object.values(SECTION_CONTROLS)
      .flat()
      .map((c) => c.applies.toString())
      .join('\n');
    expect(source).not.toMatch(/Camera|Mesh|Scene|Gltf|Group|MaterialOverride|Keyframe/);
  });
});
