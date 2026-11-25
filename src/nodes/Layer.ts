// Layer — one step of a Composition's layer stack (the Compositor's AE-style layer).
//
// #1879 — a layer is an operator on the IMAGE lane, as every stack in Basher is a chain of
// T → T steps (#1805): its `below` input is everything under it in the stack, its `source` is
// its own picture (a MediaClip / scene render / ComfyWorkflow), and its output is the stack with
// this layer composited on top. The Composition reads the top of that chain. Before, the
// Composition held a LIST of layers and composited them itself, so nothing could sit between
// two layers and adjust everything below.
//
// Composite params: trim (inPoint/outPoint), position on the comp timeline (startFrame), 2D
// transform, opacity, blend mode. `opacity` and the transform fields are keyframeable via
// free-floating V57 channels targeting this node (the twirl-down dopesheet rows).
//
// Hiding a layer is the stack mute every operator has (`muted`, `chain.bypass`): the evaluator
// hands `below` through unchanged, as BlendShop mutes a layer node. It replaced `enabled`
// (true = shown), converted in the file format.
//
// A layer's OWN effects are Image→Image operators spliced onto its `source` edge (V58), so the
// `source` it receives is already the top of that effect chain.
//
// evaluate is pure metadata (V2): an ImageValue handle whose hash covers the layer's params and
// both inputs. Pixels are made at runtime by walking the chain (compositeDecode → composite),
// which re-evaluates the source at a time-shifted ctx (§4.4) — this node does not remap time.
//
// REF: docs/COMPOSITOR-DESIGN.md §4.2; vyapti V2 + V34 + V57 + V58; src/core/dag/operatorLane.ts
//      (the lane is the type that flows through); sibling: Composition, ColorCorrect.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import { hashValue } from '../core/dag/hash';
import type { ImageValue } from './types';
import { nameParam } from './paramWidget';

export const LAYER_BLEND_MODES = ['normal', 'add', 'multiply', 'screen'] as const;

const Vec2 = z.tuple([z.number(), z.number()]);

export const LayerParams = z.object({
  name: nameParam('Layer'),
  /** Hidden (AE's eyeball off). A muted layer is bypassed: the stack below passes through. */
  muted: z.boolean().default(false),
  /** Solo (AE): when any layer in a comp is solo, only solo layers composite. */
  solo: z.boolean().default(false),
  /** Lock: protects the layer from timeline edits (trim/slide/reorder). */
  locked: z.boolean().default(false),
  /** In-point on the comp timeline, in comp frames. */
  startFrame: z.number().int().default(0),
  /** Source-local trim, in source frames. outPoint -1 = "to source end". */
  inPoint: z.number().int().nonnegative().default(0),
  outPoint: z.number().int().default(-1),
  blendMode: z.enum(LAYER_BLEND_MODES).default('normal'),
  /** 0..1, keyframeable (paramPath 'opacity'). */
  opacity: z.number().min(0).max(1).default(1),
  transform: z
    .object({
      anchor: Vec2.default([0, 0]),
      position: Vec2.default([0, 0]),
      scale: Vec2.default([1, 1]),
      rotation: z.number().default(0),
    })
    .default({}),
});
export type LayerParams = z.infer<typeof LayerParams>;

export const LayerNode: NodeDefinition<LayerParams, ImageValue> = {
  type: 'Layer',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: LayerParams,
  inputs: {
    below: { type: 'Image', cardinality: 'single' },
    /** #1716 — a layer plays its source over time; a still source holds for the layer's span. */
    source: { type: 'Image', cardinality: 'single', takes: 'frames' },
  },
  // The spine is `below`: the stack continues underneath a layer, and its own picture is a side
  // input. Section 'layer': the composition's layer stack offers it, through Add Layer.
  chain: {
    input: 'below',
    // An Image has no components, so no selection is resolvable against it.
    scope: { kind: 'unscoped', why: 'no-component-domain' },
    bypass: { kind: 'passthrough', param: 'muted' },
    section: 'layer',
    // #1894 — a composition layer's own params ARE the blend: `opacity` is the amount, `blendMode`
    // the mode (both on LayerParams). This is the canonical `own` mix the ChainDeclaration doc names.
    mix: { kind: 'own', amount: 'opacity', mode: 'blendMode' },
  },
  outputs: { out: { type: 'Image', cardinality: 'single' } },
  inspectorSections: ['layout', 'animate'],
  home: {
    name: 'layout',
    startFrame: 'animate',
  },
  evaluate(params, inputs: ResolvedInputs): ImageValue {
    const below = inputs.below as ImageValue | undefined;
    const source = inputs.source as ImageValue | undefined;
    const base = below ?? source;
    // Nothing below and no picture of its own (transient authoring state): nothing to show.
    if (!base) return base as unknown as ImageValue;
    // A composite has no render pass of its own; it keeps the kind of what it sits on, and its
    // own hash, so a change to any layer below or to this one is a different image. Its extent
    // (#1716) is what it sits on too, as an effect on the Image lane passes its input's on.
    return {
      kind: 'Image',
      passKind: base.passKind,
      descriptor: base.descriptor,
      extent: base.extent,
      sourceHash: hashValue({
        layer: {
          solo: params.solo ?? false,
          startFrame: params.startFrame ?? 0,
          inPoint: params.inPoint ?? 0,
          outPoint: params.outPoint ?? -1,
          blendMode: params.blendMode ?? 'normal',
          opacity: params.opacity ?? 1,
          transform: params.transform ?? {},
        },
        below: below?.sourceHash ?? null,
        source: source?.sourceHash ?? null,
      }),
    };
  },
};
