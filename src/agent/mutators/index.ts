// Mutator barrel — register all first-party mutators.
//
// REF: P2.5.2 PLAN §5 Wave C.

export {
  registerMutator,
  getMutator,
  listMutators,
  listMutatorMetadata,
  __resetMutatorRegistryForTests,
} from './catalog';
export type { MutatorMetadata } from './catalog';
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
}
