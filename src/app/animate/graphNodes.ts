// The minimal node shape the params-side walks read, and the one edge accessor
// they share.
//
// Split out of `boundClipsForAsset` when #901 added a second params-side reader
// (`retargetFromNodes`) that the walk itself then consumes — a cycle if the
// accessor stayed with the walk. Both still resolve an edge exactly one way; that
// is the point of the split, not a casualty of it. `boundClipsForAsset` re-exports
// both names, so the existing importers are unchanged.

/** Minimal node shape the walks read: type, params, and incoming edges. */
export interface GraphNodeLike {
  readonly type: string;
  readonly params?: unknown;
  readonly inputs?: Readonly<Record<string, unknown>>;
}

/**
 * The node id on the far end of `node.inputs[socket]`, or null.
 *
 * A `single` socket resolves to one connection; an array is tolerated so a
 * cardinality change upstream degrades to "no clip found" rather than a crash —
 * the same tolerance `bindMotionToCharacter.assetRefOfSkeleton` applies for the
 * same reason.
 */
export function edgeTarget(node: GraphNodeLike | undefined, socket: string): string | null {
  const s = node?.inputs?.[socket];
  if (!s) return null;
  const one = (Array.isArray(s) ? s[0] : s) as { node?: unknown } | undefined;
  return typeof one?.node === 'string' ? one.node : null;
}
