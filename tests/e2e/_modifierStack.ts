// modifierChainOps — the canonical op list for splicing a geometry modifier stack onto a
// split object's DATA lane (#415).
//
// THE TOPOLOGY, and why it has exactly one description:
//
//   before #415:  Object ──▶ Array ──▶ Scene.children     (the modifier WAS the scene child)
//   after  #415:  Data ──▶ Array ──▶ Object ──▶ Scene.children
//
// Five end-to-end specs wired that chain by hand, each spelling the same three edges from
// memory. That is the parallel-list shape [[V101]] warns about, and the flip is exactly the
// event it fails at: a spec still describing the old topology does not read as stale, it
// reads as a spec. So the topology is written ONCE, here, and the specs say what they are
// testing instead of how the graph is shaped.
//
// It mirrors what `buildAddModifierOps` (src/app/operatorStack.ts) produces when the user
// clicks "+ Add Modifier" — deliberately, since a spec that builds a chain no UI can build
// proves nothing about the app. The one difference is that this takes explicit ids so the
// spec can name its subject; the panel mints them.
//
// WHICH NODE A SPEC SHOULD THEN NAME:
//   the scene child / selection / gizmo / pose  → the OBJECT id
//   geometry + material params                  → the DATA id
//   count / offset / axis / muted               → the MODIFIER id
//
// REF: src/app/operatorStack.ts (`buildAddModifierOps`, `resolveStackBase`);
//      tests/e2e/_splitSphere.ts; docs/OBJECT-DATA-SPLIT-DESIGN.md §3.1; issue #415.

export interface ModifierSpec {
  /** Node id for this operator. */
  id: string;
  /** 'ArrayModifier' | 'MirrorModifier' | any registered data-lane operator. */
  nodeType: string;
  params: Record<string, unknown>;
}

export interface ModifierChainOpts {
  /** The Object that wears the result — it stays the scene child throughout. */
  objectId: string;
  /** The data node the stack sits on top of (e.g. `splitSphereDataId(objectId)`). */
  dataId: string;
  /** Bottom → top: `modifiers[0]` consumes the data, the last one feeds the Object. */
  modifiers: ModifierSpec[];
}

/**
 * Build the ops that splice `modifiers` between `dataId` and `objectId`, bottom → top.
 *
 * Assumes `dataId.out` currently feeds `objectId.data` — which is what every split-kind
 * builder produces — and re-routes that edge through the chain. Ready to splice into a
 * `dispatchAtomic` call after the split-object ops themselves.
 */
export function modifierChainOps(opts: ModifierChainOpts): unknown[] {
  const { objectId, dataId, modifiers } = opts;
  if (modifiers.length === 0) return [];

  const ops: unknown[] = modifiers.map((m) => ({
    type: 'addNode',
    nodeId: m.id,
    nodeType: m.nodeType,
    params: m.params,
  }));

  // Detach the data from the Object — the edge the stack splices into.
  ops.push({
    type: 'disconnect',
    from: { node: dataId, socket: 'out' },
    to: { node: objectId, socket: 'data' },
  });

  // data → m1 → m2 → … → mN
  let producer = dataId;
  for (const m of modifiers) {
    ops.push({
      type: 'connect',
      from: { node: producer, socket: 'out' },
      to: { node: m.id, socket: 'target' },
    });
    producer = m.id;
  }

  // …and the top of the stack is what the Object now wears.
  ops.push({
    type: 'connect',
    from: { node: producer, socket: 'out' },
    to: { node: objectId, socket: 'data' },
  });

  return ops;
}
