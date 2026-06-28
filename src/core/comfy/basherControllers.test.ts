// basherControllers — the pure two-node-contract core. No server, no GPU: the scan +
// the value-injected JSON ARE the testable IP (docs/COMFYUI-BASHER-NODES.md, design
// §15). A workflow with two `basher_controller` nodes (one wired to KSampler.cfg, one
// to a prompt) stands in for an author-built graph.

import { describe, expect, it } from 'vitest';
import {
  BASHER_CONTROLLER_TYPE,
  comfyControllerPath,
  hasBasherControllers,
  isScalarControllerKind,
  parseComfyControllerPath,
  scanBasherControllers,
  writeBasherControllerValues,
} from './basherControllers';
import type { ComfyApiJson } from './comfyGraph';

// An author-built workflow: a `basher_controller` (kind=float, "Denoise CFG") wired
// into KSampler.cfg, and a second (kind=string, "Prompt") wired into CLIPTextEncode.
// Note: Basher reads ONLY the basher_controller nodes — the KSampler/CLIP nodes are
// never inspected, exactly the boundary the contract draws.
const AUTHORED: ComfyApiJson = {
  '3': {
    class_type: 'KSampler',
    inputs: { seed: 1, steps: 20, cfg: ['10', 0], model: ['4', 0], latent_image: ['5', 0] },
  },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: ['11', 0], clip: ['4', 1] } },
  '10': {
    class_type: 'basher_controller',
    inputs: { name: 'Denoise CFG', kind: 'float', values_json: '[7]', frame_count: 1 },
  },
  '11': {
    class_type: 'basher_controller',
    inputs: { name: 'Prompt', kind: 'string', values_json: '["a cube"]', frame_count: 1 },
  },
};

describe('scanBasherControllers — enumerate declared controllers', () => {
  it('finds every basher_controller and reads its name/kind/default, in stable order', () => {
    const decls = scanBasherControllers(AUTHORED);
    expect(decls).toEqual([
      { nodeId: '10', name: 'Denoise CFG', kind: 'float', defaultValue: 7 },
      { nodeId: '11', name: 'Prompt', kind: 'string', defaultValue: 'a cube' },
    ]);
  });

  it('reads ONLY basher_controller nodes (never a foreign node)', () => {
    const decls = scanBasherControllers(AUTHORED);
    expect(decls.every((d) => AUTHORED[d.nodeId].class_type === BASHER_CONTROLLER_TYPE)).toBe(true);
    // the KSampler/CLIP/Checkpoint are not in the manifest at all
    expect(decls.some((d) => d.nodeId === '3' || d.nodeId === '6')).toBe(false);
  });

  it('falls back to the node id / float when name or kind is missing or invalid', () => {
    const graph: ComfyApiJson = {
      '9': { class_type: 'basher_controller', inputs: { values_json: '[]', frame_count: 1 } },
      '8': {
        class_type: 'basher_controller',
        inputs: { name: 'x', kind: 'bogus', values_json: '[]', frame_count: 1 },
      },
    };
    const decls = scanBasherControllers(graph);
    expect(decls.find((d) => d.nodeId === '9')).toEqual({
      nodeId: '9',
      name: '9',
      kind: 'float',
      defaultValue: 0,
    });
    expect(decls.find((d) => d.nodeId === '8')?.kind).toBe('float'); // 'bogus' → float
  });

  it('parses the per-kind default from the authored values_json first element', () => {
    const graph: ComfyApiJson = {
      b: {
        class_type: 'basher_controller',
        inputs: { kind: 'bool', values_json: '[true]', frame_count: 1 },
      },
      i: {
        class_type: 'basher_controller',
        inputs: { kind: 'int', values_json: '[20.6]', frame_count: 1 },
      },
    };
    const decls = scanBasherControllers(graph);
    expect(decls.find((d) => d.nodeId === 'b')?.defaultValue).toBe(true);
    expect(decls.find((d) => d.nodeId === 'i')?.defaultValue).toBe(21); // rounded
  });
});

describe('isScalarControllerKind', () => {
  it('separates inline-scalar kinds from out-of-band media kinds', () => {
    expect(['float', 'int', 'string', 'bool'].every(isScalarControllerKind)).toBe(true);
    expect(isScalarControllerKind('image')).toBe(false);
    expect(isScalarControllerKind('video')).toBe(false);
  });
});

describe('hasBasherControllers — the render/control dispatch predicate', () => {
  it('is true when ANY basher_controller is present (→ controller contract)', () => {
    expect(hasBasherControllers(AUTHORED)).toBe(true);
  });

  it('is false for a vanilla workflow (→ legacy inference fallback)', () => {
    const vanilla: ComfyApiJson = {
      '3': { class_type: 'KSampler', inputs: { cfg: 7, model: ['4', 0] } },
      '10': { class_type: 'LoadImage', inputs: { image: 'x.png' } },
    };
    expect(hasBasherControllers(vanilla)).toBe(false);
  });
});

describe('comfyControllerPath / parseComfyControllerPath', () => {
  it('round-trips the controller V57 paramPath (distinct from comfy: param paths)', () => {
    expect(comfyControllerPath('10')).toBe('controller:10');
    expect(parseComfyControllerPath('controller:10')).toBe('10');
  });
  it('rejects non-controller paths', () => {
    expect(parseComfyControllerPath('comfy:3.cfg')).toBeNull();
    expect(parseComfyControllerPath('controller:')).toBeNull();
  });
});

describe('writeBasherControllerValues — inject baked arrays (the whole submit-time compile)', () => {
  it('writes values_json + frame_count onto the controller, leaving the author wiring intact', () => {
    const out = writeBasherControllerValues(AUTHORED, { '10': [6.5, 7, 8, 9] });
    expect(out['10'].inputs.values_json).toBe('[6.5,7,8,9]');
    expect(out['10'].inputs.frame_count).toBe(4);
    // the author's wire (KSampler.cfg = ['10',0]) is untouched — Basher never rewires
    expect(out['3'].inputs.cfg).toEqual(['10', 0]);
    // source graph not mutated
    expect(AUTHORED['10'].inputs.values_json).toBe('[7]');
  });

  it('skips an entry for a non-controller node or a now-wired values_json', () => {
    const wiredPayload: ComfyApiJson = {
      '10': {
        class_type: 'basher_controller',
        inputs: { name: 'x', kind: 'float', values_json: ['99', 0], frame_count: 1 },
      },
    };
    const out = writeBasherControllerValues(wiredPayload, { '10': [1, 2], '3': [5] });
    expect(out['10'].inputs.values_json).toEqual(['99', 0]); // wired → left alone
    expect(out['3']).toBeUndefined(); // non-existent node → no-op, not created
  });

  it('is the testable IP: a float ramp injected onto a wired controller is a stable snapshot', () => {
    expect(writeBasherControllerValues(AUTHORED, { '10': [6.5, 7, 8, 9] })).toMatchInlineSnapshot(`
      {
        "10": {
          "class_type": "basher_controller",
          "inputs": {
            "frame_count": 4,
            "kind": "float",
            "name": "Denoise CFG",
            "values_json": "[6.5,7,8,9]",
          },
        },
        "11": {
          "class_type": "basher_controller",
          "inputs": {
            "frame_count": 1,
            "kind": "string",
            "name": "Prompt",
            "values_json": "["a cube"]",
          },
        },
        "3": {
          "class_type": "KSampler",
          "inputs": {
            "cfg": [
              "10",
              0,
            ],
            "latent_image": [
              "5",
              0,
            ],
            "model": [
              "4",
              0,
            ],
            "seed": 1,
            "steps": 20,
          },
        },
        "6": {
          "class_type": "CLIPTextEncode",
          "inputs": {
            "clip": [
              "4",
              1,
            ],
            "text": [
              "11",
              0,
            ],
          },
        },
      }
    `);
  });
});
