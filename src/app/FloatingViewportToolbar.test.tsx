// FloatingViewportToolbar — unit tests for the pure helpers + catalog
// shape. The React shell is exercised by Playwright e2e (C4 of W7) —
// this project has no React Testing Library (W2 acceptance gate #15
// forbids new external deps), so the visual rendering, click handlers,
// and active-state highlighting all live in the e2e suite.
//
// What this file covers:
//   - homeFrame routing: primary selection → frameSelected; no selection
//     → frameAll. Verifies the C1 fallback chain so the Home button
//     never silently no-ops.
//   - TOOLS catalog shape: 4 entries in fixed order with the testids
//     the e2e suite expects. Prevents accidental drift in the testid
//     contract that C4 e2e and any future agent automation depend on.
//   - SHADING catalog shape: 3 entries matching ShadingMode values.
//
// What's deliberately NOT covered here:
//   - Active-state highlighting (R8 reads zustand, Playwright owns the
//     DOM assertion).
//   - Director-mode hide (Playwright counts visibility across mode flips).
//   - V19 dispatch sync between R4 + R8 (e2e: click R8 Mv, R4 Move
//     highlights — covered in C4).
//
// REF: docs/UI-SPEC.md §5.7, memory/project_p6_w7_plan.md C1.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSelectionStore } from './stores/selectionStore';

// Mock the framing module BEFORE importing the component — vi hoists
// these calls so they apply at module-load time. homeFrame's only side
// effect is calling one of the two exports; verifying which one fires
// is the test contract.
vi.mock('./character/framing', () => ({
  frameSelected: vi.fn(),
  frameAll: vi.fn(),
}));

import { frameAll, frameSelected } from './character/framing';
import { homeFrame, SHADING, TOOLS } from './FloatingViewportToolbar';

beforeEach(() => {
  vi.clearAllMocks();
  // Reset selection so each test starts from a known state. setState
  // bypasses the store's select() so we can isolate primaryNodeId.
  useSelectionStore.setState({
    selectedNodeIds: new Set(),
    primaryNodeId: null,
    selectedNodeId: null,
  });
});

describe('homeFrame routing', () => {
  // #856 — the routing now asks frameSelected WHAT IT DID rather than asking the
  // selection store whether it will probably work. `primaryNodeId !== null` was a
  // proxy for that, and it is wrong for the one case a director reports: a node
  // is selected, it has no anchor, frameSelected silently does nothing, and the
  // fallback that exists to make this button always act never fires.
  //
  // So these rows drive the mock's RETURN, because that is what the routing
  // reads. A selection is set where it makes the scenario legible, and the third
  // row is the one that could not have passed before.
  it('does not fall back when frameSelected reports that it framed', () => {
    useSelectionStore.getState().select('cube-1');
    vi.mocked(frameSelected).mockReturnValue(true);
    homeFrame();
    expect(frameSelected).toHaveBeenCalledTimes(1);
    expect(frameAll).not.toHaveBeenCalled();
  });

  it('falls back to frameAll when nothing is selected', () => {
    expect(useSelectionStore.getState().primaryNodeId).toBeNull();
    vi.mocked(frameSelected).mockReturnValue(false);
    homeFrame();
    expect(frameSelected).toHaveBeenCalledTimes(1);
    expect(frameAll).toHaveBeenCalledTimes(1);
  });

  it('#856 — falls back when a node IS selected but cannot be framed', () => {
    // The row that could not have passed before: the old guard saw a non-null
    // primaryNodeId, called through, and stopped. The button did nothing at all
    // on a selection whose node has no anchor.
    useSelectionStore.getState().select('imported-group-1');
    expect(useSelectionStore.getState().primaryNodeId).not.toBeNull();
    vi.mocked(frameSelected).mockReturnValue(false);
    homeFrame();
    expect(frameSelected).toHaveBeenCalledTimes(1);
    expect(
      frameAll,
      'a selected-but-unframeable node must still reach Frame All',
    ).toHaveBeenCalledTimes(1);
  });

  it('switches from frameAll to frameSelected once the selection can be framed', () => {
    vi.mocked(frameSelected).mockReturnValue(false);
    homeFrame();
    expect(frameAll).toHaveBeenCalledTimes(1);
    useSelectionStore.getState().select('light-2');
    vi.mocked(frameSelected).mockReturnValue(true);
    homeFrame();
    expect(frameSelected).toHaveBeenCalledTimes(2);
    // frameAll should NOT have been called a second time.
    expect(frameAll).toHaveBeenCalledTimes(1);
  });
});

describe('TOOLS catalog', () => {
  it('exposes exactly 4 tools in the fixed order Select / Move / Rot / Scale', () => {
    expect(TOOLS.map((t) => t.id)).toEqual(['select', 'translate', 'rotate', 'scale']);
  });

  it('preserves the testid contract the e2e suite + agent automation rely on', () => {
    expect(TOOLS.map((t) => t.testId)).toEqual([
      'floating-toolbar-sel',
      'floating-toolbar-move',
      'floating-toolbar-rot',
      'floating-toolbar-scl',
    ]);
  });

  it('declares the canonical Q/W/E/R tool shortcuts', () => {
    expect(TOOLS.map((t) => t.shortcut)).toEqual(['Q', 'W', 'E', 'R']);
  });
});

describe('SHADING catalog', () => {
  it('exposes the three ShadingMode values in studio → wireframe → rendered order', () => {
    expect(SHADING.map((s) => s.value)).toEqual(['studio', 'wireframe', 'rendered']);
  });

  it('preserves the shading-chip testid contract', () => {
    expect(SHADING.map((s) => s.testId)).toEqual([
      'floating-toolbar-shading-studio',
      'floating-toolbar-shading-wireframe',
      'floating-toolbar-shading-rendered',
    ]);
  });
});
