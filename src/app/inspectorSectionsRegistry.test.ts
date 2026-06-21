// Registry-level sanity tests for inspectorSections declarations (P6 W4 C2).
//
// Asserts that:
//   - Every node type with a declared inspectorSections lists only valid
//     SectionId values (D-07 narrow).
//   - The §5.8 catalog of primary-domain assignments is preserved in the
//     declarations (mesh-primary nodes lead with 'mesh', render-primary
//     nodes lead with 'render', channels lead with 'channel', etc.).
//   - Legacy nodes (Character, LocomotionState, PosedSkeleton, Skeleton,
//     Navmesh, WalkPath, BoneNameMap, TimeSource) intentionally omit
//     inspectorSections (D-08 B raw-fallback path stays exercised).
//
// REF: docs/UI-SPEC.md §5.8 (catalog), §7.2 (sectionsByNodeType).

import { beforeAll, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, snapshotRegistry } from '../core/dag/registry';
import { isSectionId } from './inspectorSections';
import { registerAllNodes } from '../nodes/registerAll';

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('C2 — inspectorSections declarations', () => {
  it('every declared inspectorSections entry passes isSectionId', () => {
    const snap = snapshotRegistry();
    for (const [type, def] of Object.entries(snap)) {
      if (!def.inspectorSections) continue;
      for (const id of def.inspectorSections) {
        expect(isSectionId(id), `${type}.inspectorSections has invalid id "${id}"`).toBe(true);
      }
    }
  });

  it('mesh-primary nodes lead with section "mesh"', () => {
    const snap = snapshotRegistry();
    const meshPrimary = ['BoxMesh', 'SphereMesh', 'GltfAsset', 'Scatter'];
    for (const type of meshPrimary) {
      const def = snap[type];
      expect(def, `node type ${type} missing from registry`).toBeDefined();
      expect(def.inspectorSections?.[0], `${type} should lead with "mesh"`).toBe('mesh');
    }
  });

  it('render-primary nodes lead with section "render"', () => {
    const snap = snapshotRegistry();
    const renderPrimary = [
      'RenderJob',
      'ComfyUIWorkflow',
      'BeautyPass',
      'DepthPass',
      'NormalPass',
      'IDPass',
      'RenderOutput',
      'VideoStitch',
      'Prompt',
    ];
    for (const type of renderPrimary) {
      const def = snap[type];
      expect(def, `node type ${type} missing from registry`).toBeDefined();
      expect(def.inspectorSections?.[0], `${type} should lead with "render"`).toBe('render');
    }
  });

  it('channel-typed keyframe nodes lead with "channel"', () => {
    const snap = snapshotRegistry();
    const channels = [
      'KeyframeChannelNumber',
      'KeyframeChannelVec3',
      'KeyframeChannelQuat',
      'KeyframeChannelColor',
    ];
    for (const type of channels) {
      const def = snap[type];
      expect(def.inspectorSections?.[0], `${type} should lead with "channel"`).toBe('channel');
      expect(def.inspectorSections, `${type} should declare animate as secondary`).toContain(
        'animate',
      );
    }
  });

  it('MaterialOverride is material-primary', () => {
    const snap = snapshotRegistry();
    expect(snap.MaterialOverride.inspectorSections).toEqual(['material']);
  });

  it('AnimationClip is animate-primary', () => {
    const snap = snapshotRegistry();
    expect(snap.AnimationClip.inspectorSections?.[0]).toBe('animate');
  });

  it('layout-only nodes declare only "layout"', () => {
    const snap = snapshotRegistry();
    for (const type of ['Shot', 'Cut']) {
      expect(snap[type].inspectorSections).toEqual(['layout']);
    }
  });

  it('Group is transform-primary then layout (#222 — a Group is movable as a unit)', () => {
    const snap = snapshotRegistry();
    expect(snap.Group.inspectorSections).toEqual(['transform', 'layout']);
  });

  it('Scene declares environment + layout (UX #9 — environment is the primary domain)', () => {
    const snap = snapshotRegistry();
    expect(snap.Scene.inspectorSections).toEqual(['environment', 'layout']);
    expect(snap.Scene.inspectorSections?.[0]).toBe('environment');
  });

  it('Transform declares only "transform" (the catalog leader)', () => {
    const snap = snapshotRegistry();
    expect(snap.Transform.inspectorSections).toEqual(['transform']);
  });

  it('legacy character/animation glue nodes intentionally omit inspectorSections (D-08 B raw-fallback)', () => {
    const snap = snapshotRegistry();
    const rawFallback = [
      'Character',
      'LocomotionState',
      'PosedSkeleton',
      'Skeleton',
      'Navmesh',
      'WalkPath',
      'BoneNameMap',
      'TimeSource',
    ];
    for (const type of rawFallback) {
      const def = snap[type];
      expect(def, `node type ${type} missing from registry`).toBeDefined();
      expect(
        def.inspectorSections,
        `${type} should omit inspectorSections so raw-fallback renders`,
      ).toBeUndefined();
    }
  });
});
