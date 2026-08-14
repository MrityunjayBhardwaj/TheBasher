// socketMembership — "does this input socket accept type T?", and nothing else.
//
// WHY THIS IS ITS OWN FILE (#612)
// The answer used to live in `types.ts` and was re-spelled inline in
// `test-utils/splitKinds.ts`, because that descriptor is imported by Playwright specs
// and a gate in its own spec forbids VALUE imports of `core/dag` there — importing a
// function from `types.ts` would drag the DAG module graph (zod schemas, the registry
// contract, every socket type's neighbours) into every browser run. The duplication was
// forced by a real constraint, so removing it needed a module the constraint permits
// rather than a widened rule.
//
// THE PROPERTY THAT MAKES IT IMPORTABLE IS "DRAGS NOTHING", NOT ITS NAME.
// This file has no VALUE imports — its only import is `import type`, which the compiler
// erases, so the emitted module pulls in nothing at all. That is what earns the
// exemption, and `splitKinds.registry.test.ts` DERIVES the exemption from that fact
// instead of listing this path: it reads whatever `splitKinds.ts` value-imports out of
// `core/dag` and asserts each one is genuinely leaf. Add a value import here and the
// gate that lets `splitKinds.ts` reach this module stops passing — which is the intended
// behaviour, not an inconvenience. A widened allowlist would have said "this path is
// fine" forever; this says "this path is fine while it stays leaf".

import type { InputDescriptor, SocketTypeName } from './types';

/**
 * The types an input socket accepts, always as a set (one-element for the
 * ordinary single-type socket). The one place the two spellings collapse.
 */
export function acceptedTypes(desc: InputDescriptor): readonly SocketTypeName[] {
  return Array.isArray(desc.type) ? desc.type : [desc.type as SocketTypeName];
}

/**
 * Does this input socket accept a producer emitting `produced`? Takes `undefined` —
 * an absent socket accepts nothing — because every caller is asking about a socket
 * looked up by name, and `?.type === 'X'` is exactly the spelling that reads FALSE
 * on a set-valued socket while still compiling.
 */
export function inputAccepts(desc: InputDescriptor | undefined, produced: SocketTypeName): boolean {
  if (!desc) return false;
  return Array.isArray(desc.type) ? desc.type.includes(produced) : desc.type === produced;
}
