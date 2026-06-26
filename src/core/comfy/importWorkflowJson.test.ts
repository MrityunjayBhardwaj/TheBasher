import { describe, expect, it } from 'vitest';
import { parseComfyWorkflowJson } from './importWorkflowJson';
import { importComfyGraph } from './comfyGraph';

const API_FORMAT = {
  '3': {
    class_type: 'KSampler',
    inputs: { seed: 815, steps: 25, cfg: 7.5, model: ['4', 0] },
  },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] } },
};

describe('parseComfyWorkflowJson', () => {
  it('accepts an API-format workflow and produces a ready graph param', () => {
    const r = parseComfyWorkflowJson(JSON.stringify(API_FORMAT), 'my-graph');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.meta.name).toBe('my-graph');
    expect(r.graph.meta.fps).toBe(30);
    expect(r.graph.apiJson['3'].class_type).toBe('KSampler');
    // The produced graph drives importComfyGraph (the consumer) — schedulable +
    // structural params resolve, proving the shape is exactly what the panel reads.
    const manifest = importComfyGraph(r.graph.apiJson, r.graph.meta);
    expect(manifest.params.find((p) => p.nodeId === '6' && p.inputName === 'text')?.valueKind).toBe(
      'string',
    );
  });

  it('rejects invalid JSON with an actionable reason', () => {
    const r = parseComfyWorkflowJson('{ not json', 'x');
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('not valid JSON') });
  });

  it('rejects a UI-format ("Save") export and points to API format', () => {
    const ui = JSON.stringify({ nodes: [{ id: 1, type: 'KSampler' }], links: [], last_node_id: 1 });
    const r = parseComfyWorkflowJson(ui, 'ui');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('API Format');
  });

  it('rejects an object whose entries are not nodes', () => {
    const r = parseComfyWorkflowJson(JSON.stringify({ a: 1, b: 'x' }), 'bad');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('class_type');
  });

  it('rejects a JSON array', () => {
    const r = parseComfyWorkflowJson(JSON.stringify([1, 2, 3]), 'arr');
    expect(r.ok).toBe(false);
  });

  it('rejects an empty object (no nodes)', () => {
    const r = parseComfyWorkflowJson('{}', 'empty');
    expect(r.ok).toBe(false);
  });

  it('falls back to a default name when the filename is blank', () => {
    const r = parseComfyWorkflowJson(JSON.stringify(API_FORMAT), '   ');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.meta.name).toBe('workflow');
  });
});
