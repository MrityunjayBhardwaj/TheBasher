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
}
