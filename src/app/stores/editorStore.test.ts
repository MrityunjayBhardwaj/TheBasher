// editorStore — verify space toggle + setSpace.

import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorStore } from './editorStore';

beforeEach(() => {
  useEditorStore.setState({ space: 'view3d' });
});

describe('editorStore', () => {
  it('default space is view3d', () => {
    expect(useEditorStore.getState().space).toBe('view3d');
  });

  it('setSpace updates the active space', () => {
    useEditorStore.getState().setSpace('uv');
    expect(useEditorStore.getState().space).toBe('uv');
  });

  it('toggleSpace flips view3d ↔ uv', () => {
    useEditorStore.getState().toggleSpace();
    expect(useEditorStore.getState().space).toBe('uv');
    useEditorStore.getState().toggleSpace();
    expect(useEditorStore.getState().space).toBe('view3d');
  });
});
