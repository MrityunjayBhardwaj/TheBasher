// materialSocket — THE rule for a node that can get its material from either an edge
// or its own param (#394 S2). One spelling, shared, because two spellings of one rule is
// exactly the drift that puts a data node and its renderer on different answers.
//
// ── THE RULE: A CONNECTED SOCKET SUPERSEDES THE PARAM, WHOLESALE ────────────────────
//
// Not a merge, not a field-by-field fallback: if an edge is present, the param is not
// consulted at all. Grounded, not chosen — measured on Blender 5.1.1, an object-level
// material slot carries exactly two writable fields (`link` + `material`), i.e. a
// redirect flag and a pointer, with NO material fields to merge with; and clearing the
// pointer while `link='OBJECT'` resolves to nothing rather than falling back to the
// data's material. The override is a pointer swap, and it is not a fallback chain.
//
// Blender's third state — linked but empty — is UNREPRESENTABLE here, because an edge
// either exists or does not. That is a simplification the reference licenses; it is
// written down so it is not rediscovered as a bug later.
//
// THIS IS THE FIRST socket-supersedes-param site in the codebase. Textures-as-nodes
// (#513) is the next one and must REUSE this rule rather than mint a second: an input
// that shadows a param is a shape, and the moment there are two spellings of it, one of
// them is wrong somewhere.
//
// ── WHY `list` CARDINALITY WITH ONE ENTRY READ ──────────────────────────────────────
//
// `InputBindingSchema` is `NodeRef | NodeRef[]` and `connect` picks between them from the
// INPUT socket's declared cardinality (ops.ts), so `single → list` is a change to the
// PERSISTED shape — a real migration on live save files, not a type-level tweak. Both
// references make the material slot list data-owned and per-element indexed
// (`MeshPolygon.material_index`; Houdini's primitive class), so a list is where this ends
// up. Declaring it now costs one array index; declaring it later costs a format bump.
// A primitive has exactly one slot in Blender too, so reading entry 0 is not a stopgap
// for these kinds — it is the whole correct answer until per-element material (#395).

import type { InlineMaterialSpec, OpenPBRMaterialValue } from './types';
import { hydrateInlineMaterial } from './materialSchema';

/** The material a `'Material'` socket is carrying, or null when nothing is connected. */
function linkedMaterial(socket: unknown): OpenPBRMaterialValue | null {
  // The evaluator shapes `inputs[socket]` from the BINDING, not from the declared
  // cardinality, so accept both: a list binding arrives as an array, and a legacy or
  // hand-built single binding arrives bare. An empty array is a disconnected socket.
  const first = Array.isArray(socket) ? socket[0] : socket;
  if (!first || typeof first !== 'object') return null;
  const v = first as OpenPBRMaterialValue;
  return v.kind === 'OpenPBRMaterial' ? v : null;
}

/**
 * Resolve a node's material from its `material` socket and its `material` param.
 *
 * Always returns a COMPLETE IR: the socket is a FOURTH source of a material value, so it
 * goes through the SAME hydrate seam as the other three rather than around it — a
 * consumer must never have to ask whether the material it was handed has all its lobes.
 */
export function resolveNodeMaterial(socket: unknown, param: unknown): InlineMaterialSpec {
  const linked = linkedMaterial(socket);
  return hydrateInlineMaterial(linked ? linked.spec : param);
}

/** Whether a `'Material'` socket is actually carrying a material. Exported so a test can
 *  assert PROVENANCE — that a green run is one where the socket was really connected,
 *  not one where it silently fell through to the param and happened to match. */
export function isMaterialLinked(socket: unknown): boolean {
  return linkedMaterial(socket) !== null;
}
