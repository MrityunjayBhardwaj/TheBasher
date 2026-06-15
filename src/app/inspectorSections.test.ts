// Unit tests for inspectorSections (P6 W4).

import { describe, expect, it } from 'vitest';
import {
  formatSectionLabel,
  isDefaultCollapsed,
  isSectionId,
  MULTI_SELECT_SECTIONS,
  SECTION_IDS,
  type SectionId,
} from './inspectorSections';

describe('SECTION_IDS', () => {
  it('contains the documented v0.5 sections from §5.8 plus environment (UX #9) + camera (UX #12)', () => {
    expect(SECTION_IDS).toEqual([
      'transform',
      'mesh',
      'material',
      'render',
      'animate',
      'channel',
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
