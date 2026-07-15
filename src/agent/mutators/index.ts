// Mutator barrel — register all first-party mutators.
//
// REF: P2.5.2 PLAN §5 Wave C.

export {
  registerMutator,
  getMutator,
  getMutatorMetadata,
  listMutators,
  listMutatorSummaries,
  firstSentence,
  __resetMutatorRegistryForTests,
} from './catalog';
export type { MutatorMetadata, MutatorSummary } from './catalog';
export type {
  MutatorDefinition,
  MutatorContract,
  MutatorPlan,
  MutatorRejection,
  MutatorValidationResult,
  PreservedAspect,
  LossyAspect,
  PreconditionResult,
} from './types';
export { validatePlan } from './validate';

import { registerMutator } from './catalog';
import { rotateMutator } from './builders/rotate';
import { translateMutator } from './builders/translate';
import { scaleMutator } from './builders/scale';
import { setMaterialColorMutator } from './builders/setMaterialColor';
import { duplicateMutator } from './builders/duplicate';
import { deleteNodeMutator } from './builders/deleteNode';
import { addChannelMutator } from './builders/addChannel';
import { keyframeMutator } from './builders/keyframe';
import { simplifyChannelMutator } from './builders/simplifyChannel';
import { removeKeyframesMutator } from './builders/removeKeyframes';
import { shotCreateMutator } from './builders/shotCreate';
import { retargetMutator } from './builders/retarget';
import { addPassMutator } from './builders/addPass';
import { addAIPassMutator } from './builders/addAIPass';
import { addStitchMutator } from './builders/addStitch';
import { randomizeMutator } from './builders/randomize';
import { bakeGltfChannelMutator } from './builders/bakeGltfChannel';
import { addModifierMutator } from './builders/addModifier';
import { addChannelModifierMutator } from './builders/addChannelModifier';
import { setChannelExtendMutator } from './builders/setChannelExtend';
import { setKeyframeInterpMutator } from './builders/setKeyframeInterp';
import { createActionMutator } from './builders/createAction';
import { addStripMutator } from './builders/addStrip';
import { setStripTimingMutator } from './builders/setStripTiming';
import { setStripBlendMutator } from './builders/setStripBlend';
import { setTrackStateMutator } from './builders/setTrackState';

export {
  rotateMutator,
  translateMutator,
  scaleMutator,
  setMaterialColorMutator,
  duplicateMutator,
  deleteNodeMutator,
  addChannelMutator,
  keyframeMutator,
  simplifyChannelMutator,
  removeKeyframesMutator,
  shotCreateMutator,
  retargetMutator,
  addPassMutator,
  addAIPassMutator,
  addStitchMutator,
  randomizeMutator,
  bakeGltfChannelMutator,
  addModifierMutator,
  addChannelModifierMutator,
  setChannelExtendMutator,
  setKeyframeInterpMutator,
  createActionMutator,
  addStripMutator,
  setStripTimingMutator,
  setStripBlendMutator,
  setTrackStateMutator,
};

export function registerAllMutators(): void {
  registerMutator(rotateMutator);
  registerMutator(translateMutator);
  registerMutator(scaleMutator);
  registerMutator(setMaterialColorMutator);
  registerMutator(duplicateMutator);
  registerMutator(deleteNodeMutator);
  // P3 Wave B — animation Mutators (THESIS §42, issue #34). v0.7 #199: the
  // AnimationLayer wrapper is retired (direct channels, V57). `addLayer` is gone;
  // `addChannel` now mints a FREE-FLOATING channel (no layer), then `keyframe`
  // appends samples to it by channelId.
  registerMutator(addChannelMutator);
  registerMutator(keyframeMutator);
  // P6 W6 — RDP simplify; issue #60 / H36 — removeKeyframes parameterizes
  // the former clearChannel ('all') and deleteKeyframe ({time}) into one
  // op (Blender Shift-Alt-I + Alt-I share an underlying handler).
  registerMutator(simplifyChannelMutator);
  registerMutator(removeKeyframesMutator);
  registerMutator(shotCreateMutator);
  // P3.1 Wave C — animation retargeting
  registerMutator(retargetMutator);
  // P4 Wave C — render graph
  registerMutator(addPassMutator);
  // P5 Wave C — AI render bridge
  registerMutator(addAIPassMutator);
  // P5 Wave D — video stitch
  registerMutator(addStitchMutator);
  // P7.2 — issue #26 path B: per-target randomization, N × P ops in
  // one atomic dispatch.
  registerMutator(randomizeMutator);
  // P7.12 — issue #108 / D1: copy-on-write bake of an imported glTF bone's
  // clip track into editable per-bone KeyframeChannel nodes (no edges, R4).
  registerMutator(bakeGltfChannelMutator);
  // #209 (epic #201) — the geometry OperatorStack's agent op: add a SOP/modifier
  // (ArrayModifier) on top of a mesh's stack, through the same operatorStack
  // wiring the UI uses (V58, §2.2 "add a Subdivide / add a Track-To").
  registerMutator(addModifierMutator);
  // #281 (Blender anim-parity) — agent authoring op for the channel F-Modifier
  // stack (#274–#280): add a Noise/Cycles/Generator/Limits/Stepped/Envelope
  // modifier via the same defaultModifier() factory the NPanel "+ Add" uses (V88 D2).
  registerMutator(addChannelModifierMutator);
  // #281 — agent authoring op for per-side channel extrapolation (hold/slope,
  // #269/#275, V88 D1): the agent counterpart of the NPanel Extend dropdowns.
  registerMutator(setChannelExtendMutator);
  // #281 — agent authoring op for per-keyframe interpolation / ease / handle type
  // (#272/#273): the agent counterpart of the curve editor's interp/handle pickers.
  registerMutator(setKeyframeInterpMutator);
  // #283 Phase 4 (NLA agent mutators) — author + place the Action/Strip/Track
  // vocabulary. createAction mints an immutable relative-path Action (addNode);
  // addStrip binds it to a target and lands it in a Track (auto-creating the Track
  // when trackId is omitted, appending via setParam(Track,'strips')). Track-birth
  // folds into addStrip → no colliding standalone createTrack (V14/V88 D2).
  registerMutator(createActionMutator);
  registerMutator(addStripMutator);
  // #283 Phase 4 inc 4B — edit a placed Strip: retime (start/timeScale/repeat/reverse)
  // and blend (blendMode/influence/blendIn/blendOut, the Phase-3 crossfade seam). Two
  // setParam mutators separated by honest lossy kinds (timing vs blend) under ['Strip'].
  registerMutator(setStripTimingMutator);
  registerMutator(setStripBlendMutator);
  // #283 Phase 4 inc 4C — Track state: order (cross-track fold rank, I-2) / mute / solo.
  // requiredNodeTypes:['Track'] is the honest V14 discriminator vs the set-Strip family.
  registerMutator(setTrackStateMutator);
}
