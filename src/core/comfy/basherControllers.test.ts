// basherControllers — the pure two-node-contract core. No server, no GPU: the scan +
// the value-injected JSON ARE the testable IP (docs/COMFYUI-BASHER-NODES.md, design
// §15). A workflow with two `basher_controller` nodes (one wired to KSampler.cfg, one
// to a prompt) stands in for an author-built graph.

import { describe, expect, it } from 'vitest';
import {
  BASHER_CONTROLLER_TYPE,
  comfyControllerPath,
  hasBasherControllers,
  injectBasherControllers,
  isScalarControllerKind,
  parseComfyControllerPath,
  scanBasherControllers,
  writeBasherControllerFrameCounts,
  writeBasherControllerValues,
  type InjectableTrack,
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

describe('writeBasherControllerFrameCounts — Basher-supplied batch N for media controllers ([[H128]])', () => {
  const VIDEO_WF: ComfyApiJson = {
    '14': {
      class_type: 'basher_controller',
      inputs: { name: 'Source Video', kind: 'video', frame_count: 0, video: 'clip.mp4' },
    },
  };

  it('writes frame_count onto the named controller so the extension resamples to N', () => {
    const out = writeBasherControllerFrameCounts(VIDEO_WF, { '14': 30 });
    expect(out['14'].inputs.frame_count).toBe(30);
    // floors + clamps to >=1; source not mutated
    expect(writeBasherControllerFrameCounts(VIDEO_WF, { '14': 5.9 })['14'].inputs.frame_count).toBe(
      5,
    );
    expect(writeBasherControllerFrameCounts(VIDEO_WF, { '14': 0 })['14'].inputs.frame_count).toBe(
      1,
    );
    expect(VIDEO_WF['14'].inputs.frame_count).toBe(0);
  });

  it('skips a non-controller node and a now-wired frame_count', () => {
    const wired: ComfyApiJson = {
      '14': {
        class_type: 'basher_controller',
        inputs: { name: 'v', kind: 'video', frame_count: ['9', 0], video: 'c.mp4' },
      },
    };
    const out = writeBasherControllerFrameCounts(wired, { '14': 12, '3': 7 });
    expect(out['14'].inputs.frame_count).toEqual(['9', 0]); // wired → left alone
    expect(out['3']).toBeUndefined();
  });
});

describe('injectBasherControllers — auto-inject a controller for a keyframed Mode-B param', () => {
  // A VANILLA workflow (NO basher_controller): a KSampler whose cfg is an authored
  // literal. The user keyframes comfy:3.cfg; Basher bakes the curve + auto-injects.
  const VANILLA: ComfyApiJson = {
    '3': {
      class_type: 'KSampler',
      inputs: { seed: 1, steps: 20, cfg: 7, model: ['4', 0], latent_image: ['5', 0] },
    },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cube', clip: ['4', 1] } },
  };

  it('injects a basher_controller for a VARYING scalar and rewires the input to read it', () => {
    const tracks: InjectableTrack[] = [
      {
        nodeId: '3',
        inputName: 'cfg',
        classType: 'KSampler',
        valueKind: 'float',
        values: [1.5, 8, 16],
      },
    ];
    const { apiJson, injectedIds } = injectBasherControllers(VANILLA, tracks);
    expect(injectedIds).toEqual(['bctl_3_cfg']);
    const ctrl = apiJson['bctl_3_cfg'];
    expect(ctrl.class_type).toBe(BASHER_CONTROLLER_TYPE);
    expect(ctrl.inputs.kind).toBe('float');
    expect(ctrl.inputs.name).toBe('KSampler.cfg');
    expect(ctrl.inputs.values_json).toBe('[1.5,8,16]');
    expect(ctrl.inputs.frame_count).toBe(3);
    // the foreign input now READS the injected controller (the proven OUTPUT_IS_LIST wire)
    expect(apiJson['3'].inputs.cfg).toEqual(['bctl_3_cfg', 0]);
    // source not mutated
    expect(VANILLA['3'].inputs.cfg).toBe(7);
  });

  it('a CONSTANT track injects NOTHING — the literal is substituted (the passthrough)', () => {
    const tracks: InjectableTrack[] = [
      {
        nodeId: '3',
        inputName: 'cfg',
        classType: 'KSampler',
        valueKind: 'float',
        values: [9, 9, 9],
      },
    ];
    const { apiJson, injectedIds } = injectBasherControllers(VANILLA, tracks);
    expect(injectedIds).toEqual([]); // no controller — extension not needed
    expect(apiJson['bctl_3_cfg']).toBeUndefined();
    expect(apiJson['3'].inputs.cfg).toBe(9); // literal substituted, not a wire
  });

  it('with NO tracks the graph submits exactly as authored (zero-touch passthrough)', () => {
    const { apiJson, injectedIds } = injectBasherControllers(VANILLA, []);
    expect(injectedIds).toEqual([]);
    expect(apiJson).toEqual(VANILLA);
  });

  it('ignores media + bool kinds (out-of-band / discrete) and a now-wired input', () => {
    const tracks: InjectableTrack[] = [
      // media → handled by applyComfyImageBindings, never injected here
      {
        nodeId: '3',
        inputName: 'cfg',
        classType: 'KSampler',
        valueKind: 'image',
        values: ['a.png', 'b.png'],
      },
      // bool → discrete constant, no per-frame channel
      {
        nodeId: '3',
        inputName: 'steps',
        classType: 'KSampler',
        valueKind: 'bool',
        values: [true, false],
      },
      // points at a WIRED input (model) → keep the wire, never overwrite
      {
        nodeId: '3',
        inputName: 'model',
        classType: 'KSampler',
        valueKind: 'float',
        values: [1, 2, 3],
      },
      // points at a MISSING node → skipped, never created
      { nodeId: '99', inputName: 'x', classType: 'Foo', valueKind: 'float', values: [1, 2] },
    ];
    const { apiJson, injectedIds } = injectBasherControllers(VANILLA, tracks);
    expect(injectedIds).toEqual([]);
    expect(apiJson['3'].inputs.model).toEqual(['4', 0]); // wire untouched
    expect(apiJson['99']).toBeUndefined();
    // cfg/steps unchanged from authored (media/bool ignored)
    expect(apiJson['3'].inputs.cfg).toBe(7);
    expect(apiJson['3'].inputs.steps).toBe(20);
  });

  it('mixes a varying param (injected) with a constant one (passthrough) in one graph', () => {
    const tracks: InjectableTrack[] = [
      {
        nodeId: '3',
        inputName: 'cfg',
        classType: 'KSampler',
        valueKind: 'float',
        values: [2, 4, 6],
      },
      {
        nodeId: '6',
        inputName: 'text',
        classType: 'CLIPTextEncode',
        valueKind: 'string',
        values: ['x', 'x'],
      },
    ];
    const { apiJson, injectedIds } = injectBasherControllers(VANILLA, tracks);
    expect(injectedIds).toEqual(['bctl_3_cfg']); // only the varying one
    expect(apiJson['3'].inputs.cfg).toEqual(['bctl_3_cfg', 0]);
    expect(apiJson['6'].inputs.text).toBe('x'); // constant string → literal, no controller
  });

  it('is the testable IP: an injected float ramp is a stable snapshot', () => {
    const tracks: InjectableTrack[] = [
      {
        nodeId: '3',
        inputName: 'cfg',
        classType: 'KSampler',
        valueKind: 'float',
        values: [1.5, 8, 16],
      },
    ];
    expect(injectBasherControllers(VANILLA, tracks).apiJson['bctl_3_cfg']).toMatchInlineSnapshot(`
      {
        "_meta": {
          "title": "Basher Controller: 3.cfg",
        },
        "class_type": "basher_controller",
        "inputs": {
          "frame_count": 3,
          "kind": "float",
          "name": "KSampler.cfg",
          "values_json": "[1.5,8,16]",
        },
      }
    `);
  });
});
