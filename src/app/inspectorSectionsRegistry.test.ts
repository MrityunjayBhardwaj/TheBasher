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
    // #312 — a Group has a POSE, so it also carries a constraint stack. The pin's
    // intent is PRIMACY (transform leads, layout trails), which still holds.
    // #316 — and its params are drivable, so it carries a Drivers stack too.
    expect(snap.Group.inspectorSections).toEqual(['transform', 'constraint', 'driver', 'layout']);
    expect(snap.Group.inspectorSections?.[0]).toBe('transform');
  });

  it('Scene declares environment + layout (UX #9 — environment is the primary domain)', () => {
    const snap = snapshotRegistry();
    expect(snap.Scene.inspectorSections).toEqual(['environment', 'layout']);
    expect(snap.Scene.inspectorSections?.[0]).toBe('environment');
  });

  it('Transform is transform-primary (the catalog leader)', () => {
    const snap = snapshotRegistry();
    // #312 — a Transform has a POSE, so it also carries a constraint stack. It remains
    // the minimal transform-led node (no mesh/material/layout of its own).
    // #316 — plus the Drivers stack (the param half of the same relational species).
    expect(snap.Transform.inspectorSections).toEqual(['transform', 'constraint', 'driver']);
    expect(snap.Transform.inspectorSections?.[0]).toBe('transform');
  });

  // #316 — the DRIVER stack is the PARAM half of the SAME relational species the
  // constraint stack covers for POSE ([[V98]]). The rule that keeps the two halves from
  // drifting: anything CONSTRAINABLE is also DRIVABLE — if you can pose it, you can drive
  // its params, and you must be able to SEE the driver stack that writes them. A new node
  // type that declares 'constraint' and forgets 'driver' would silently ship with an
  // invisible, unbypassable driver stack — exactly the hole #315/#316 exist to close.
  it('constrainable ⟹ drivable: every "constraint" node also declares "driver"', () => {
    const snap = snapshotRegistry();
    for (const [type, def] of Object.entries(snap)) {
      const sections = def.inspectorSections;
      if (!sections?.includes('constraint')) continue;
      expect(sections, `${type} is constrainable → must also offer drivers`).toContain('driver');
    }
  });

  // The ParamDriver declares 'driver' WITHOUT a pose — selecting a driver row must keep
  // its own stack on screen (the panel resolves a selected driver back to its target),
  // exactly as a TrackTo does for the constraint stack.
  it('ParamDriver declares "driver" so selecting a row keeps the panel', () => {
    const snap = snapshotRegistry();
    expect(snap.ParamDriver.inspectorSections).toEqual(['driver']);
  });

  // #312 — the constraint stack is a POSE concern: every posable node (mesh, light,
  // camera, Group, Transform, Null) declares it, so you select the OBJECT and see its
  // Constraints panel — the modifier-stack idiom. A node with no pose must NOT.
  it('every transform-declaring node also declares "constraint"; poseless nodes do not', () => {
    const snap = snapshotRegistry();
    for (const [type, def] of Object.entries(snap)) {
      const sections = def.inspectorSections;
      if (!sections) continue;
      if (sections.includes('transform')) {
        expect(sections, `${type} is posable → must offer constraints`).toContain('constraint');
      } else if (type !== 'TrackTo' && type !== 'ParamDriver') {
        // TrackTo is itself a constraint — it declares the section so selecting a row
        // still shows the stack it belongs to.
        expect(sections, `${type} has no pose → must not offer constraints`).not.toContain(
          'constraint',
        );
      }
    }
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
