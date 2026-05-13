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
  it('calls frameSelected when a primary node is selected', () => {
    useSelectionStore.getState().select('cube-1');
    homeFrame();
    expect(frameSelected).toHaveBeenCalledTimes(1);
    expect(frameAll).not.toHaveBeenCalled();
  });

  it('falls back to frameAll when no primary node is selected', () => {
    expect(useSelectionStore.getState().primaryNodeId).toBeNull();
    homeFrame();
    expect(frameAll).toHaveBeenCalledTimes(1);
    expect(frameSelected).not.toHaveBeenCalled();
  });

  it('switches from frameAll to frameSelected after a selection lands', () => {
    homeFrame();
    expect(frameAll).toHaveBeenCalledTimes(1);
    useSelectionStore.getState().select('light-2');
    homeFrame();
    expect(frameSelected).toHaveBeenCalledTimes(1);
    // frameAll should NOT have been called a second time.
    expect(frameAll).toHaveBeenCalledTimes(1);
  });
});

describe('TOOLS catalog', () => {
  it('exposes exactly 4 tools in the fixed order Select / Move / Rot / Scale', () => {
    expect(TOOLS.map((t) => t.id)).toEqual([
      'select',
      'translate',
      'rotate',
      'scale',
    ]);
  });

  it('preserves the testid contract the e2e suite + agent automation rely on', () => {
    expect(TOOLS.map((t) => t.testId)).toEqual([
      'floating-toolbar-sel',
      'floating-toolbar-move',
      'floating-toolbar-rot',
      'floating-toolbar-scl',
    ]);
  });

  it('declares keyboard shortcuts matching the R4 ToolRail (Q/W/E/R)', () => {
    expect(TOOLS.map((t) => t.shortcut)).toEqual(['Q', 'W', 'E', 'R']);
  });
});

describe('SHADING catalog', () => {
  it('exposes the three ShadingMode values in studio → wireframe → rendered order', () => {
    expect(SHADING.map((s) => s.value)).toEqual([
      'studio',
      'wireframe',
      'rendered',
    ]);
  });

  it('preserves the shading-chip testid contract', () => {
    expect(SHADING.map((s) => s.testId)).toEqual([
      'floating-toolbar-shading-studio',
      'floating-toolbar-shading-wireframe',
      'floating-toolbar-shading-rendered',
    ]);
  });
});
