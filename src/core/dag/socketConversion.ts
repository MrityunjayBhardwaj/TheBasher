// #1549 — what happens when a wire carries a type its input does not take.
//
// Until now nothing: a socket took the types it declared and `connect` refused the rest, with
// a message that named the two types and no way forward. Blender's answer to "one role, several
// incoming types" is a table of implicit conversions applied at the link
// (`type_conversions.cc`, grounded in ref/GROUND_TRUTH_BLENDER_NODE_SOCKET_TYPING.md). This is
// that table, for the types Basher has.
//
// ── WHICH PAIRS, MEASURED ─────────────────────────────────────────────────────────────────
//
// A census of the registry on 2026-10-07 (90 node types): the only plain-value types any
// socket carries are Number (14 inputs, 14 outputs) and Vector3 (4 inputs, 6 outputs), plus
// one input that takes either (`ParamDriver.in`). No socket carries a Color, a Boolean, a
// Vector2 or a Quaternion; those live in params. So two pairs can meet and be refused:
//
//   Number → Vector3   CONVERTED. Blender's `float_to_float3` (`type_conversions.cc:50`):
//                      the number on all three axes. Nothing is lost.
//   Vector3 → Number   REFUSED, with the way forward. Blender converts this too, by averaging
//                      the axes (`float3_to_float`, `type_conversions.cc:153`), and that is the
//                      one place this table deliberately does not follow it: an average of
//                      x, y and z is a number nobody asked for, and the node that picks an axis
//                      (`VecBreak3`) already exists. Recorded in docs/GRAPH.md §6.
//
// ── A TYPE THE SOCKET ALREADY TAKES IS NEVER CONVERTED ────────────────────────────────────
//
// `ParamDriver.in` takes Number OR Vector3 and must know which arrived: a Number broadcast to
// a Vector3 there would silently drive all three axes of a position (#609, and the note on
// `InputDescriptor`). So conversion is consulted only for a type the socket would otherwise
// refuse. Acceptance wins; conversion is what is left.
//
// ── WHERE IT IS APPLIED ───────────────────────────────────────────────────────────────────
//
// On the value, where it enters the input: in the evaluator's input resolution, and in the two
// places that read a producer for a socket without going through it (a stateless owner's leaf,
// and the Solver's cook of its `bodies`). The wire and the stored graph are unchanged, so there
// is nothing to migrate, and the content hash needs no new term: whether a wire converts is
// fixed by the two node types, which the consumer's cache key already carries.
//
// COST, MEASURED 2026-10-07 (vitest, node; a 500-node Math chain evaluated uncached, median of
// 7 runs of 400): 0.365 ms with the check against 0.358 ms with it short-cut, so about 14 ns a
// wire. An input with no conversion pays one WeakMap read and never looks its producer up.

import { getNodeType } from './registry';
import { acceptedTypes, inputAccepts } from './socketMembership';
import type { EvaluableState } from './state';
import type { InputDescriptor, NodeId, SocketTypeName } from './types';

type Convert = (value: unknown) => unknown;

/** `from>to` → the conversion. A value that is not what `from` promises passes through
 *  untouched: an unevaluable producer must stay recognisable as one downstream. */
const CONVERSIONS: Readonly<Record<string, Convert>> = {
  'Number>Vector3': (v) => (typeof v === 'number' ? [v, v, v] : v),
};

/** Pairs that are refused on purpose, and what to do instead. */
const WAY_FORWARD: Readonly<Record<string, string>> = {
  'Vector3>Number':
    'a Vector3 holds three numbers and none is picked for you: wire it through a VecBreak3 node and take x, y or z',
};

const perInput = new WeakMap<InputDescriptor, ReadonlyMap<SocketTypeName, Convert> | null>();

/** Every type `desc` does not take but can be handed, with its conversion; null when none.
 *  Worked out once per descriptor: most inputs have none, and the evaluator asks per wire. */
export function conversionsInto(
  desc: InputDescriptor,
): ReadonlyMap<SocketTypeName, Convert> | null {
  const known = perInput.get(desc);
  if (known !== undefined) return known;
  const found = new Map<SocketTypeName, Convert>();
  for (const to of acceptedTypes(desc)) {
    for (const [pair, convert] of Object.entries(CONVERSIONS)) {
      const [from, target] = pair.split('>') as [SocketTypeName, SocketTypeName];
      if (target === to && !inputAccepts(desc, from) && !found.has(from)) found.set(from, convert);
    }
  }
  const result = found.size > 0 ? found : null;
  perInput.set(desc, result);
  return result;
}

/** The type `ref`'s output socket declares, or undefined for a node or socket that is gone. */
export function producedTypeOf(
  state: EvaluableState,
  ref: { node: NodeId; socket: string },
): SocketTypeName | undefined {
  const producer = state.nodes[ref.node];
  return producer ? getNodeType(producer.type)?.outputs[ref.socket]?.type : undefined;
}

/** Whether a wire carrying `produced` may enter `desc`: it is taken as it is, or it converts. */
export function inputTakes(desc: InputDescriptor | undefined, produced: SocketTypeName): boolean {
  if (!desc) return false;
  return inputAccepts(desc, produced) || (conversionsInto(desc)?.has(produced) ?? false);
}

/** `value`, of type `produced`, as it arrives in `desc`: converted if the socket would not
 *  otherwise take that type, untouched if it takes it or if there is no conversion. */
export function arriving(
  desc: InputDescriptor | undefined,
  produced: SocketTypeName | undefined,
  value: unknown,
): unknown {
  if (!desc || produced === undefined) return value;
  const convert = conversionsInto(desc)?.get(produced);
  return convert ? convert(value) : value;
}

/** Why a wire carrying `produced` cannot enter `desc`, for the refusal: the way forward where
 *  one exists, otherwise that no conversion does. */
export function whyNotTaken(desc: InputDescriptor, produced: SocketTypeName): string {
  const wanted = acceptedTypes(desc);
  for (const to of wanted) {
    const way = WAY_FORWARD[`${produced}>${to}`];
    if (way) return way;
  }
  return `there is no conversion from ${produced} to ${wanted.join(' or ')}, so a converter node is needed between them`;
}
