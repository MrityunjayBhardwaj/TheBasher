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
      { nodeId: '5', name: 'Depth' },
      { nodeId: '20', name: 'Beauty' },
    ]);
  });

  it('falls back to the nodeId when name is missing/empty', () => {
    const decls = scanBasherExports({
      '3': { class_type: 'basher_export', inputs: {} },
      '4': { class_type: 'basher_export', inputs: { name: '' } },
    });
    expect(decls).toEqual([
      { nodeId: '3', name: '3' },
      { nodeId: '4', name: '4' },
    ]);
  });

  it('never reads a foreign node', () => {
    expect(
      scanBasherExports({ '9': { class_type: 'SaveImage', inputs: { name: 'nope' } } }),
    ).toEqual([]);
  });
});
