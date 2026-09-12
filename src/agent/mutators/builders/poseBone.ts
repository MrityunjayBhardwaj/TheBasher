// poseBone Mutator — the AUTHORING road into the pose lane (#993).
//
//   RetargetClip.posed ──→ PoseOverride ──→ PoseOverride ──→ (the pose band)
//                             ↑ this mutator mints and extends these
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS AT ALL
// ─────────────────────────────────────────────────────────────────────────
// `PoseOverride` shipped complete: registered, typed, evaluated, consumed by
// `poseBandForAsset`, covered by rows that red on cue — and NOBODY COULD CREATE
// ONE. Node creation in this codebase runs through curated builders; there is no
// add-node palette and no generic `addNode` agent tool, so a registered type
// with no builder can be evaluated but not authored. Registration and
// reachability look like one property and are two, and every gate we have takes
// the node as GIVEN, so the whole class is invisible to a green suite.
//
// The lane needed three things and had two: a producer (`RetargetClip.posed`), a
// consumer (the band), and an AUTHOR. This is the author.
//
// ─────────────────────────────────────────────────────────────────────────
// 🔴 THE BONE NAME ARRIVES IN THE WRONG SPELLING, AND IT ALWAYS WILL
// ─────────────────────────────────────────────────────────────────────────
// The obvious wiring — take the name the armature's bone selection yields and
// store it — is WRONG, and wrong silently. That name is the LIVE three.js
// `Bone.name`, and the two consumers of `PoseOverride.bone` both speak the DAG's
// key space instead:
//
//   `poseBandForAsset` skips any bone not `in nodeNameMap`     → no pixels
//   `PoseOverride.evaluate` resolves against `skeleton.bones`  → index -1,
//                                                                pass-through
//
// The two spaces are different by construction, not by accident. GLTFLoader runs
// three's `PropertyBinding.sanitizeNodeName` over every node name as it loads,
// which REMOVES `[].:/`; our `sanitizeBoneName` REPLACES them with `_`. So the
// same Mixamo bone is `mixamorigHips` live and `mixamorig_Hips` in params, and
// `canonicalBoneKey`'s own header records the measurement: comparing the two
// directly matches 1 of 23 bones on the tracked stand-in rig, and through the
// canonical key, 23 of 23.
//
// A builder that stored the caller's spelling would therefore mint a node that
// types, validates, saves and drives NOTHING — the same shape as the gap this
// mutator was written to close, one layer further in. So the name is RESOLVED
// here, against the rig this override will actually hang off, and what is stored
// is the rig's own spelling. `resolveBoneNames` does the resolving: an exact name
// always wins, and an inexact one matches only when its canonical form names
// exactly one bone. An unresolvable name is REFUSED rather than stored, because
// an override on a bone the rig does not have is precisely the inert node this
// file exists to make unconstructible.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY OVERRIDES CHAIN INSTEAD OF FANNING OUT
// ─────────────────────────────────────────────────────────────────────────
// Two overrides could each hang directly off the retarget — the band would find
// both, since it enumerates every override whose `pose` chain reaches a bound
// clip. The VALUE lane would not: `PoseOverride.evaluate` wraps ONE upstream
// pose, so two siblings are two separate poses and whoever consumes one never
// sees the other. That is a displayed-≠-rendered split (V446/H40) — the band
// showing two posed bones while the value lane carries one.
//
// So a new override is connected to the TIP of the rig's existing chain, and the
// chain is walked consumer-side from the retarget to find it. One chain per rig,
// and the split is unconstructible through this road.
//
// ONE OVERRIDE PER (rig, bone), for the neighbouring reason: with two overrides
// on one bone the band breaks the tie by node id (`Object.keys().sort()` + `??=`)
// while the value lane breaks it by chain position (outermost applies last).
// Those rules disagree. A second pose on a bone therefore EXTENDS the existing
// override rather than stacking a new one — the same idempotence
// `ensureChannelForBone` gives a bone channel, and for the same reason: a
// director poses a bone repeatedly, and every repeat must land on the thing
// already driving it.
//
// REF: src/nodes/PoseOverride.ts (the node); src/app/bakedGltfChannels.ts
//      (`poseBandForAsset`, the render-side consumer); src/core/import/retarget.ts
//      (`canonicalBoneKey` / `resolveBoneNames`, the name-space bridge and its
//      measurement); src/app/animate/retargetFromNodes.ts (`bonesOfSkeletonNode`);
//      src/agent/mutators/builders/addChannel.ts (the sibling authoring verb);
//      issues #993, #974, #900, #922.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { NodeId, Op } from '../../../core/dag/types';
import { edgeTarget, type GraphNodeLike } from '../../../app/animate/graphNodes';
import { bonesOfSkeletonNode } from '../../../app/animate/retargetFromNodes';
import { resolveBoneNames } from '../../../core/import/retarget';

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

const PoseBoneSpec = z.object({
  /** The `RetargetClip` whose rig is being posed — the anchor of the pose chain. */
  retarget: z.string().min(1),
  /**
   * The bone to pose. Accepted in EITHER spelling — the live three.js name
   * (`mixamorigHips`) or the DAG's (`mixamorig_Hips`) — and stored as the rig's
   * own. See the header: storing the caller's spelling is a silent no-op.
   */
  bone: z.string().min(1),
  /** Authored local translation. Supplying it IS the authoring bit. */
  position: Vec3Schema.optional(),
  /** Authored local Euler rotation, DEGREES XYZ (the codebase convention). */
  rotation: Vec3Schema.optional(),
  overrideId: z.string().optional(),
  overrideName: z.string().optional(),
});
export type PoseBoneSpec = z.infer<typeof PoseBoneSpec>;

/** Sanitize a bone name for id use, as `addChannel.safePath` does for a param path. */
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * The deterministic override id for a (retarget, bone), unless caller-supplied.
 *
 * Keyed on the bone name AS THE CALLER SPELLED IT, because `buildClosureSpec` has
 * no state and so cannot resolve the name — the same trade `addChannel` makes
 * when it keys a channel id to `spec.target` while `build` resolves the owner
 * elsewhere. Harmless for the same reason: every lookup on this lane is a
 * `params.bone` scan, never an id compare. Two spellings of one bone therefore
 * propose two ids, and `build` collapses them onto the ONE existing override —
 * the id is a convenience, the params are the identity.
 */
function overrideIdFor(spec: PoseBoneSpec): NodeId {
  return spec.overrideId ?? `${spec.retarget}_${safeName(spec.bone)}_pose`;
}

interface OverrideNode {
  readonly id: string;
  readonly bone: string;
  readonly overridden: { position?: boolean; rotation?: boolean };
}

/**
 * The chain of `PoseOverride`s hanging off `retargetId`, nearest first.
 *
 * Walked consumer-side one hop at a time: at each step, the override whose `pose`
 * input names the current node. Bounded by the node count so a malformed graph
 * cannot spin, and by taking the FIRST match at each hop it reports a single
 * chain even if a previous road (or a hand-edited file) left a fork — `build`
 * appends to the tip of what it reports, which keeps a fork from widening.
 */
function overrideChain(
  nodes: Readonly<Record<string, GraphNodeLike>>,
  retargetId: string,
): OverrideNode[] {
  const ids = Object.keys(nodes).sort();
  const out: OverrideNode[] = [];
  let cur = retargetId;
  const seen = new Set<string>([retargetId]);
  for (let hops = 0; hops < ids.length; hops++) {
    const nextId = ids.find(
      (id) =>
        nodes[id].type === 'PoseOverride' && edgeTarget(nodes[id], 'pose') === cur && !seen.has(id),
    );
    if (nextId === undefined) break;
    const p = (nodes[nextId].params ?? {}) as {
      bone?: unknown;
      overridden?: { position?: boolean; rotation?: boolean };
    };
    out.push({
      id: nextId,
      bone: typeof p.bone === 'string' ? p.bone : '',
      overridden: p.overridden ?? {},
    });
    seen.add(nextId);
    cur = nextId;
  }
  return out;
}

/** The bones of the rig a `RetargetClip` drives, or null when it names none. */
function targetBonesOf(state: DagState, retargetId: string): readonly { name: string }[] | null {
  const nodes = state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;
  const node = nodes[retargetId];
  if (!node || node.type !== 'RetargetClip') return null;
  return bonesOfSkeletonNode(nodes, edgeTarget(node, 'skeleton'));
}

/**
 * The rig's own spelling of `bone`, or null when the rig does not carry it.
 *
 * `resolveBoneNames` maps an unresolved name to ITSELF, so "did it resolve?" is
 * "is the answer a name the rig actually has" — checked against the rig rather
 * than against the input, which is what makes a caller's typo a refusal instead
 * of a stored bone nobody has.
 */
function resolveBoneOn(bones: readonly { name: string }[], bone: string): string | null {
  const resolved = resolveBoneNames([bone], bones as never)[bone];
  return resolved !== undefined && bones.some((b) => b.name === resolved) ? resolved : null;
}

export const poseBoneMutator: MutatorDefinition<PoseBoneSpec> = {
  name: 'mutator.animate.poseBone',
  // 🔴 THE FIRST SENTENCE IS THE PICKER PAYLOAD, so it ends before a CAPITAL.
  // `firstSentence` splits on a period followed by an upper-case letter, digit or
  // quote; a period followed by a lower-case word is not a boundary, and the
  // "summary" then runs on to the next capital — the measured way three entries
  // became 400-550 characters each and pushed the catalog over its byte ceiling.
  description:
    'Hand-pose ONE bone of a retargeted rig, by minting a PoseOverride on the ' +
    "RetargetClip's pose chain or extending that bone's existing override. " +
    'Position is local translation; rotation is local Euler DEGREES XYZ, and at ' +
    'least one of the two is required — an override authoring neither is inert. ' +
    'The bone may be named in either the live-scene or the DAG spelling; it is ' +
    "stored as the rig's own.",
  spec: PoseBoneSpec,
  specExample: {
    retarget: 'node_id',
    bone: 'mixamorig_LeftArm',
    rotation: [0, 0, 45],
  },
  contract: {
    // 'parent' walks consumer-side from the retarget, which is how the existing
    // pose chain gets into the closure: an override is reached only by the node
    // that consumes the retarget, then the node that consumes THAT.
    requiredEdges: ['parent'],
    requiredNodeTypes: ['RetargetClip'],
    // The rig's motion is untouched — an override REPLACES components of one
    // bone's sampled pose downstream of the retarget and writes nothing back.
    preserves: ['position', 'rotation', 'scale', 'material', 'children', 'animation'],
  },
  buildClosureSpec(spec): ClosureSpec {
    // Roots: the anchor (whose consumer-side walk reaches the whole chain) and
    // the fresh id (a gate-3 isFreshAddNode, unused when build extends instead).
    return { rootSelectors: [spec.retarget, overrideIdFor(spec)], followedEdges: ['parent'] };
  },
  preconditions(spec, _closure, state) {
    const node = state.nodes[spec.retarget];
    if (!node) return { ok: false, reason: `retarget "${spec.retarget}" not in DAG.` };
    if (node.type !== 'RetargetClip') {
      return {
        ok: false,
        reason: `"${spec.retarget}" is a ${node.type}; poseBone anchors on a RetargetClip (the node carrying the \`posed\` output).`,
      };
    }
    if (spec.position === undefined && spec.rotation === undefined) {
      return {
        ok: false,
        reason:
          'poseBone needs position, rotation, or both — an override authoring neither component is inert.',
      };
    }
    const bones = targetBonesOf(state, spec.retarget);
    if (!bones || bones.length === 0) {
      return {
        ok: false,
        reason: `retarget "${spec.retarget}" names no target rig (its \`skeleton\` input is unwired, or the rig has no bones).`,
      };
    }
    if (resolveBoneOn(bones, spec.bone) === null) {
      return {
        ok: false,
        reason: `bone "${spec.bone}" is not on this rig. Its bones are: ${bones
          .slice(0, 12)
          .map((b) => b.name)
          .join(', ')}${bones.length > 12 ? `, … (${bones.length} total)` : ''}.`,
      };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const nodes = state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;
    const bones = targetBonesOf(state, spec.retarget);
    // Non-null by the precondition; the fallback keeps `build` total rather than
    // throwing into gate 5 if it is ever called without one.
    const bone = (bones && resolveBoneOn(bones, spec.bone)) ?? spec.bone;

    const chain = overrideChain(nodes, spec.retarget);
    const existing = chain.find((o) => o.bone === bone);

    // The authored set is the union of what is already authored and what this
    // call names — EXPLICIT, never derived from value≠default (V28). A director
    // who poses rotation and later poses position keeps both.
    const overridden = {
      ...(existing?.overridden ?? {}),
      ...(spec.position !== undefined ? { position: true } : {}),
      ...(spec.rotation !== undefined ? { rotation: true } : {}),
    };

    if (existing) {
      // EXTEND. Only the components this call names are written, so an untouched
      // component keeps the value it already had.
      const ops: Op[] = [];
      if (spec.position !== undefined) {
        ops.push({
          type: 'setParam',
          nodeId: existing.id,
          paramPath: 'position',
          value: spec.position,
        });
      }
      if (spec.rotation !== undefined) {
        ops.push({
          type: 'setParam',
          nodeId: existing.id,
          paramPath: 'rotation',
          value: spec.rotation,
        });
      }
      ops.push({
        type: 'setParam',
        nodeId: existing.id,
        paramPath: 'overridden',
        value: overridden,
      });
      return ops;
    }

    // MINT, onto the tip of the chain — the retarget itself when there is none.
    // The tip's output socket differs by type: a retarget hands out `posed`, an
    // override `out`.
    const tip = chain.length > 0 ? chain[chain.length - 1].id : spec.retarget;
    const fromSocket = chain.length > 0 ? 'out' : 'posed';
    const overrideId = overrideIdFor(spec);

    return [
      {
        type: 'addNode',
        nodeId: overrideId,
        nodeType: 'PoseOverride',
        params: {
          name: spec.overrideName ?? `pose ${bone}`,
          bone,
          position: spec.position ?? [0, 0, 0],
          rotation: spec.rotation ?? [0, 0, 0],
          overridden,
        },
      },
      {
        type: 'connect',
        from: { node: tip, socket: fromSocket },
        to: { node: overrideId, socket: 'pose' },
      },
    ];
  },
};
