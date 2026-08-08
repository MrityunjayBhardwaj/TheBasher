// Unit tests for inspectorSections (P6 W4).

import { beforeAll, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../core/dag';
import { getNodeType } from '../core/dag/registry';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import {
  formatSectionLabel,
  isDefaultCollapsed,
  isSectionId,
  MULTI_SELECT_SECTIONS,
  paramToSection,
  SECTION_IDS,
  type SectionId,
} from './inspectorSections';

// RE-ANCHORED AT #394 P6b. Routing moved off a central predicate chain onto each node's
// own `home` declaration, so it is asked of a NODE TYPE rather than of a synthetic section
// list. These read the shipped registry now, which is what they were always trying to
// describe — `['transform','camera']` was a stand-in for "a camera", and a stand-in cannot
// tell you whether the camera that ships is routed correctly.
beforeAll(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

const homeOn = (nodeType: string, key: string) =>
  paramToSection(
    key,
    (getNodeType(nodeType)?.inspectorSections ?? []) as readonly SectionId[],
    nodeType,
  );

describe('paramToSection — camera params route to the Camera section', () => {
  it('routes every DoF/lens param the CameraLensControls block authors', () => {
    for (const p of [
      'fov',
      'sensorSize',
      'near',
      'far',
      'dofEnabled',
      'focusDistance',
      'fStop',
      'focusOnTarget',
    ]) {
      expect(homeOn('CameraData', p), `CameraData.${p}`).toBe('camera');
    }
    // `zoom` is orthographic-only, and post-split both projections are the one CameraData —
    // which is why the whole loop reads that node. It used to read the fused
    // `PerspectiveCamera`, deleted in #599; CameraData is not a substitute for it but the
    // node that actually declares every one of these keys.
    expect(homeOn('CameraData', 'zoom')).toBe('camera');
  });
  it('#257 — focusOnTarget must NOT fall through to the unrouted bucket (duplicate toggle)', () => {
    // A camera claims it; a node with no camera lens does not (no spurious routing).
    expect(homeOn('CameraData', 'focusOnTarget')).toBe('camera');
    expect(homeOn('Transform', 'focusOnTarget')).not.toBe('camera');
  });
});

describe('paramToSection — light shading routes to the Light section (#386, H189 fix)', () => {
  it('routes every LightData shading param to the light section', () => {
    for (const p of [
      'lightKind',
      'intensity',
      'color',
      'distance',
      'decay',
      'angle',
      'penumbra',
      'width',
      'height',
      'target',
      'lookAt',
      'tex',
    ]) {
      expect(homeOn('LightData', p), `LightData.${p}`).toBe('light');
    }
  });
  it('a light that is NOT a LightData does not claim these params (no spurious routing)', () => {
    // The mechanism: with no light home, intensity/color route to null and the linked-data
    // inspector drops them → empty panel. The split LightData above is the positive; here
    // the negative, and it is a REAL node. The fused posable lights used to play this part
    // and are retired (#365 Phase 5); AmbientLight is the surviving unsplit light — ambient
    // is a World datablock, so it declares only 'driver' and no 'light', and its shading
    // params sit in the raw bucket exactly as the fused lights' did.
    expect(homeOn('AmbientLight', 'intensity')).toBeNull();
    expect(homeOn('AmbientLight', 'color')).toBeNull();
  });
  it('bare light color never collides with a mesh material colour', () => {
    // The collision `home` exists to resolve: one key, two cards, decided per node.
    expect(homeOn('MaterialOverride', 'color')).toBe('material');
    expect(homeOn('LightData', 'color')).toBe('light');
  });
});

describe('SECTION_IDS', () => {
  it('contains the documented v0.5 sections from §5.8 plus environment (UX #9) + camera (UX #12)', () => {
    expect(SECTION_IDS).toEqual([
      'transform',
      'mesh',
      'material',
      'render',
      'animate',
      'channel',
      // Operator substrate — CHOP/constraints (epic #201, V58).
      'constraint',
      // Operator substrate — CHOP/drivers (#316) — the PARAM half of the same species.
      'driver',
      // The path's SHAPE — a Curve's control points / closed / resolution (#321).
      'curve',
      // The light's SHADING — a LightData's kind + intensity/colour/falloff/aim (#386).
      'light',
      // Operator substrate — SOP/modifiers (epic #201, #209, V58).
      'modifier',
      // Operator substrate — video effects (epic #235, V58 lift to Image).
      'effect',
      'environment',
      'camera',
      'layout',
    ]);
  });
});

describe('isSectionId', () => {
  it('accepts known section ids', () => {
    for (const id of SECTION_IDS) {
      expect(isSectionId(id)).toBe(true);
    }
  });
  it('rejects unknown strings', () => {
    expect(isSectionId('metadata')).toBe(false);
    expect(isSectionId('')).toBe(false);
    expect(isSectionId('TRANSFORM')).toBe(false);
  });
  it('rejects non-strings', () => {
    expect(isSectionId(null)).toBe(false);
    expect(isSectionId(undefined)).toBe(false);
    expect(isSectionId(42)).toBe(false);
    expect(isSectionId({})).toBe(false);
  });
});

describe('formatSectionLabel', () => {
  it('title-cases each section id', () => {
    expect(formatSectionLabel('transform')).toBe('Transform');
    expect(formatSectionLabel('mesh')).toBe('Mesh');
    expect(formatSectionLabel('channel')).toBe('Channel');
    expect(formatSectionLabel('layout')).toBe('Layout');
  });
});

describe('MULTI_SELECT_SECTIONS (D-10 A)', () => {
  it('is Transform + Layout — common foundational sections', () => {
    expect(MULTI_SELECT_SECTIONS).toEqual(['transform', 'layout']);
  });
});

describe('isDefaultCollapsed (§5.8 default-collapsed rule)', () => {
  it('primary domain is expanded by default', () => {
    const sections: SectionId[] = ['mesh', 'transform', 'material'];
    expect(isDefaultCollapsed(sections, 'mesh')).toBe(false);
  });
  it('non-primary sections are collapsed by default', () => {
    const sections: SectionId[] = ['mesh', 'transform', 'material'];
    expect(isDefaultCollapsed(sections, 'transform')).toBe(true);
    expect(isDefaultCollapsed(sections, 'material')).toBe(true);
  });
  it('empty section list never collapses (raw-fallback path, D-08 B)', () => {
    expect(isDefaultCollapsed([], 'transform')).toBe(false);
  });
  it('single-section list does not collapse its sole entry', () => {
    expect(isDefaultCollapsed(['render'], 'render')).toBe(false);
  });
});
