// comfyRenderProgressStore — the live "Render coherent clip" progress state machine.
// The visible surface (bar + streaming preview) is observed live against a real
// server (slice 5c, the render is slow enough to see); here we lock the state machine
// + the object-URL lifecycle (no leaks across a long render). design §8/§16 Q-F.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useComfyRenderProgressStore } from './comfyRenderProgressStore';

let created: string[] = [];
let revoked: string[] = [];

beforeEach(() => {
  created = [];
  revoked = [];
  let n = 0;
  vi.stubGlobal('URL', {
    createObjectURL: () => {
      const url = `blob:mock/${n++}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url: string) => revoked.push(url),
  });
  useComfyRenderProgressStore.setState({
    active: false,
    label: '',
    value: 0,
    max: 0,
    node: null,
    previewUrl: null,
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('comfyRenderProgressStore', () => {
  it('begin marks active and clears prior state', () => {
    const s = useComfyRenderProgressStore.getState();
    s.begin('SD1.5 text2img');
    const st = useComfyRenderProgressStore.getState();
    expect(st.active).toBe(true);
    expect(st.label).toBe('SD1.5 text2img');
    expect(st.value).toBe(0);
    expect(st.previewUrl).toBeNull();
  });

  it('setProgress records the sampler step + executing node', () => {
    useComfyRenderProgressStore.getState().begin('wf');
    useComfyRenderProgressStore.getState().setProgress(7, 20, '3');
    const st = useComfyRenderProgressStore.getState();
    expect(st.value).toBe(7);
    expect(st.max).toBe(20);
    expect(st.node).toBe('3');
  });

  it('setPreview holds a fresh object URL and REVOKES the previous one (no leak)', () => {
    const s = useComfyRenderProgressStore.getState();
    s.begin('wf');
    s.setPreview(Uint8Array.of(1, 2, 3), 'image/png');
    const first = useComfyRenderProgressStore.getState().previewUrl;
    expect(first).toBe('blob:mock/0');
    s.setPreview(Uint8Array.of(4, 5, 6), 'image/jpeg');
    const second = useComfyRenderProgressStore.getState().previewUrl;
    expect(second).toBe('blob:mock/1');
    expect(revoked).toContain(first); // the old frame's URL was released
    expect(created).toEqual(['blob:mock/0', 'blob:mock/1']);
  });

  it('end revokes the live preview URL and marks inactive', () => {
    const s = useComfyRenderProgressStore.getState();
    s.begin('wf');
    s.setPreview(Uint8Array.of(1), 'image/png');
    const url = useComfyRenderProgressStore.getState().previewUrl!;
    s.end();
    const st = useComfyRenderProgressStore.getState();
    expect(st.active).toBe(false);
    expect(st.previewUrl).toBeNull();
    expect(revoked).toContain(url);
  });
});
