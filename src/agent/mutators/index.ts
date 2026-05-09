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
import { addLayerMutator } from './builders/addLayer';
import { addChannelMutator } from './builders/addChannel';
import { keyframeMutator } from './builders/keyframe';
import { shotCreateMutator } from './builders/shotCreate';
import { retargetMutator } from './builders/retarget';
import { addPassMutator } from './builders/addPass';
import { addAIPassMutator } from './builders/addAIPass';
import { addStitchMutator } from './builders/addStitch';

export {
  rotateMutator,
  translateMutator,
  scaleMutator,
  setMaterialColorMutator,
  duplicateMutator,
  deleteNodeMutator,
  addLayerMutator,
  addChannelMutator,
  keyframeMutator,
  shotCreateMutator,
  retargetMutator,
  addPassMutator,
  addAIPassMutator,
  addStitchMutator,
};

export function registerAllMutators(): void {
  registerMutator(rotateMutator);
  registerMutator(translateMutator);
  registerMutator(scaleMutator);
  registerMutator(setMaterialColorMutator);
  registerMutator(duplicateMutator);
  registerMutator(deleteNodeMutator);
  // P3 Wave B — animation Mutators (THESIS §42, issue #34)
  registerMutator(addLayerMutator);
  registerMutator(addChannelMutator);
  registerMutator(keyframeMutator);
  registerMutator(shotCreateMutator);
  // P3.1 Wave C — animation retargeting
  registerMutator(retargetMutator);
  // P4 Wave C — render graph
  registerMutator(addPassMutator);
  // P5 Wave C — AI render bridge
  registerMutator(addAIPassMutator);
  // P5 Wave D — video stitch
  registerMutator(addStitchMutator);
}
