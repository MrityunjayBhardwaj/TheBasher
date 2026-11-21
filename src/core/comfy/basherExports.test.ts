import { describe, expect, it } from 'vitest';
import { hasBasherExports, scanBasherExports } from './basherExports';
import type { ComfyApiJson } from './comfyGraph';

const WF: ComfyApiJson = {
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'x', images: ['8', 0] } },
  '20': { class_type: 'basher_export', inputs: { name: 'Beauty', images: ['8', 0] } },
  '5': { class_type: 'basher_export', inputs: { name: 'Depth', images: ['7', 0] } },
};

describe('basherExports', () => {
  it('hasBasherExports detects a declared sink', () => {
    expect(hasBasherExports(WF)).toBe(true);
    expect(hasBasherExports({ '9': { class_type: 'SaveImage', inputs: {} } })).toBe(false);
  });

  it('scanBasherExports enumerates only basher_export nodes, in numeric nodeId order', () => {
    const decls = scanBasherExports(WF);
    expect(decls).toEqual([
      { nodeId: '5', name: 'Depth', kind: 'image' },
      { nodeId: '20', name: 'Beauty', kind: 'image' },
    ]);
  });

  it('falls back to the nodeId when name is missing/empty', () => {
    const decls = scanBasherExports({
      '3': { class_type: 'basher_export', inputs: {} },
      '4': { class_type: 'basher_export', inputs: { name: '' } },
    });
    expect(decls).toEqual([
      { nodeId: '3', name: '3', kind: 'image' },
      { nodeId: '4', name: '4', kind: 'image' },
    ]);
  });

  it('#1715 — reads the declared kind; missing or unknown is a still', () => {
    const decls = scanBasherExports({
      '1': { class_type: 'basher_export', inputs: { name: 'clip', kind: 'video' } },
      '2': { class_type: 'basher_export', inputs: { name: 'poster', kind: 'image' } },
      '3': { class_type: 'basher_export', inputs: { name: 'old' } },
      '4': { class_type: 'basher_export', inputs: { name: 'odd', kind: 'movie' } },
    });
    expect(decls.map((d) => d.kind)).toEqual(['video', 'image', 'image', 'image']);
  });

  it('never reads a foreign node', () => {
    expect(
      scanBasherExports({ '9': { class_type: 'SaveImage', inputs: { name: 'nope' } } }),
    ).toEqual([]);
  });
});
