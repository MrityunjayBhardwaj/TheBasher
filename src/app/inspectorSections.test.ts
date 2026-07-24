// Unit tests for inspectorSections (P6 W4).

import { describe, expect, it } from 'vitest';
import {
  formatSectionLabel,
  isDefaultCollapsed,
  isSectionId,
  MULTI_SELECT_SECTIONS,
  paramToSection,
  SECTION_IDS,
  type SectionId,
} from './inspectorSections';

describe('paramToSection — camera params route to the Camera section', () => {
  const cam: readonly SectionId[] = ['transform', 'camera'];
  it('routes every DoF/lens param the CameraLensControls block authors', () => {
    for (const p of [
      'fov',
      'sensorSize',
      'near',
      'far',
      'zoom',
      'dofEnabled',
      'focusDistance',
      'fStop',
      'focusOnTarget',
    ]) {
      expect(paramToSection(p, cam)).toBe('camera');
    }
  });
  it('#257 — focusOnTarget must NOT fall through to the unrouted bucket (duplicate toggle)', () => {
    // A camera-less node does not claim it (no spurious routing), but a camera does.
    expect(paramToSection('focusOnTarget', ['transform'])).not.toBe('camera');
    expect(paramToSection('focusOnTarget', cam)).toBe('camera');
  });
});

describe('paramToSection — light shading routes to the Light section (#386, H189 fix)', () => {
  const light: readonly SectionId[] = ['light'];
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
      expect(paramToSection(p, light)).toBe('light');
    }
  });
  it('a node that does NOT declare light never claims these params (no spurious routing)', () => {
    // The H189 mechanism: without the light arm, intensity/color route to null and the
    // linked-data inspector drops them → empty panel. Proven by the split-light routing
    // above; here the negative — a transform-only node leaves them unrouted.
    expect(paramToSection('intensity', ['transform'])).toBeNull();
    expect(paramToSection('penumbra', ['transform'])).toBeNull();
  });
  it('bare light color/intensity never collide with a mesh material colour', () => {
    // A material node routes bare `color` through 'material'; a light node routes it
    // through 'light'. They never both declare, so no collision — assert both directions.
    expect(paramToSection('color', ['material'])).toBe('material');
    expect(paramToSection('color', ['light'])).toBe('light');
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
