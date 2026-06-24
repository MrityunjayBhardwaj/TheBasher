// editorStore — verify space toggle + setSpace + activeTool transitions.

import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorStore } from './editorStore';
import { useGizmoStore } from './gizmoStore';

beforeEach(() => {
  useEditorStore.setState({ space: 'view3d', activeTool: 'select' });
  useGizmoStore.setState({ mode: 'translate', dragging: false });
});

describe('editorStore — space', () => {
  it('default space is view3d', () => {
    expect(useEditorStore.getState().space).toBe('view3d');
  });

  it('setSpace updates the active space', () => {
    useEditorStore.getState().setSpace('uv');
    expect(useEditorStore.getState().space).toBe('uv');
  });

  it('setSpace updates to video', () => {
    useEditorStore.getState().setSpace('video');
    expect(useEditorStore.getState().space).toBe('video');
  });

  it('toggleSpace cycles view3d → uv → video → view3d', () => {
    useEditorStore.getState().toggleSpace();
    expect(useEditorStore.getState().space).toBe('uv');
    useEditorStore.getState().toggleSpace();
    expect(useEditorStore.getState().space).toBe('video');
    useEditorStore.getState().toggleSpace();
    expect(useEditorStore.getState().space).toBe('view3d');
  });
});

describe('editorStore — activeTool', () => {
  it('default activeTool is select', () => {
    expect(useEditorStore.getState().activeTool).toBe('select');
  });

  it('setActiveTool(translate) updates activeTool AND propagates to gizmoStore', () => {
    useEditorStore.getState().setActiveTool('translate');
    expect(useEditorStore.getState().activeTool).toBe('translate');
    expect(useGizmoStore.getState().mode).toBe('translate');
  });

  it('setActiveTool(rotate) propagates to gizmoStore.mode', () => {
    useEditorStore.getState().setActiveTool('rotate');
    expect(useGizmoStore.getState().mode).toBe('rotate');
  });

  it('setActiveTool(scale) propagates to gizmoStore.mode', () => {
    useEditorStore.getState().setActiveTool('scale');
    expect(useGizmoStore.getState().mode).toBe('scale');
  });

  it('setActiveTool(select) updates activeTool but does NOT touch gizmoStore.mode', () => {
    // Set a known gizmo mode first, then switch to select — gizmoStore
    // should be left at its prior value so the user can resume the
    // previous transform tool by toggling back.
    useGizmoStore.getState().setMode('rotate');
    useEditorStore.getState().setActiveTool('select');
    expect(useEditorStore.getState().activeTool).toBe('select');
    expect(useGizmoStore.getState().mode).toBe('rotate');
  });
});
