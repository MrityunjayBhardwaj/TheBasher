// overlayWithIdentity — the render-time overlay, WITH the identity repair the overlay owes
// the value it patches (#536 S2b).
//
// ── THE DEFECT THIS EXISTS TO CLOSE ────────────────────────────────────────────────────
//
// The two primitives below are correct and untouched. `overlayChannels` deep-clones the
// evaluated value and writes each sampled channel at its paramPath; `overlayTransients`
// does the same for held, un-keyed edits. Neither mutates anything shared. What neither
// does — and could not, since neither knows what a material is — is RE-IDENTIFY the copy.
//
// Since #536 S1 the evaluator mints `MeshDataValue.materialKey`: the material's identity,
// decided by the graph after the full fold, so two objects that resolve to one material are
// known to draw one instance rather than being re-discovered downstream by content-hashing.
// S2 taught the material registry to key on it. Both are right. Together they made the
// clone above a bug: it carries the animated colour AND the key minted before the animation,
// so the registry hits its cache on the pre-edit key and hands back the pre-edit material.
// The inspector shows the new colour; the object is frozen under the director's hand; the
// value itself is correct, so nothing that inspects the value can see anything wrong.
//
// ── THE RULE, AND WHY IT IS NOT "STOP TRUSTING THE KEY" ────────────────────────────────
//
// > A writer that patches an evaluated value OWNS the identity on it.
//
// The repair that suggests itself is to derive the key from the patched content at the point
// of use. It turns every failing test green in three lines, and it is a retreat: it is
// exactly "recover identity by walking the result", which the invariant forbids in its own
// words, and it leaves the minted field with no consumer — deleting the mechanism rather
// than completing it. A green suite is not the acceptance test for this class.
//
// The reference system says the same thing from the other side, and names the half we were
// missing. A Houdini filter SOP does not write into its input: `SOP_Node::duplicateSource`
// copies the input's geometry — and the duplicate BECOMES that node's own output, carrying
// THAT node's identity. We already copy. Content wearing the producer's name is simply not a
// representable state there; here it was, and this module is the repack step.
//
// ── THREE PROPERTIES THIS MUST HAVE, ALL OF THEM LOAD-BEARING ──────────────────────────
//
// 1. CONDITIONAL ON A WRITE HAPPENING AT ALL. When nothing is animated or held, both
//    primitives return the base by reference and this returns it too, unchanged. The two
//    call sites are built around exactly that reference identity (their per-frame guard
//    skips `setState` when the inputs are unchanged), so an unconditional repair would
//    defeat the static-node guard and churn every frame.
// 2. CONDITIONAL ON THE WRITE TOUCHING THE KEYED REGION. Animating `position` must not
//    clear a material key: that costs a real, silent loss of dedup — two objects sharing a
//    material would stop sharing an instance the moment one of them moved.
// 3. DERIVED, NOT SPELLED. Which paths matter comes from `identityFieldsForBand`, which
//    derives both halves from `channelPathForBand`. A hardcoded `data.` here would be a
//    per-kind assumption sitting beside a per-band rule — correct for the children band and
//    silently wrong for the next one.
//
// REF: src/app/objectDataBand.ts (`identityFieldsForBand` — the rule); src/nodes/materialKey.ts
//      (the mint); src/app/material/primitiveMaterialInputs.ts (`irKeyFor` — the documented
//      fallback a cleared key lands on); src/app/materialRegistry.ts (the consumer);
//      src/app/overlayIdentity.gate.test.ts (the structural gate);
//      ref/houdini/SOP.md §6b; hetvabhasa H261, vyapti V149, dharana B20; issues #536, #537.

import { overlayChannels, readAt, writeAt } from '../nodes/overlayChannels';
import { overlayTransients } from './overlayTransients';
import type { KeyframeChannelValue } from '../nodes/types';
import type { TransientEdit } from './stores/transientEditStore';
import { identityFieldsForBand, writeInvalidates, type OverlayBand } from './objectDataBand';

/**
 * Every path this overlay actually WRITES, in the band's vocabulary.
 *
 * Mirrors each primitive's own filter deliberately and exactly — `overlayChannels` drops
 * muted and empty-path channels, `overlayTransients` keeps only edits targeting this node —
 * because a written-path set that disagreed with what was written would repair the wrong
 * thing in both directions: a missed write leaves the key stale, a phantom write throws away
 * dedup that was never invalidated. Both filters have a case of their own in
 * `overlayWithIdentity.test.ts` (a muted channel, another node's held edit).
 *
 * ⚠️ DECLARED LIMIT — THOSE CASES PIN THE BEHAVIOUR, NOT THE MIRRORING. If a primitive grows
 * a THIRD filter, this set silently over-counts and the tests here still pass, because they
 * assert what this function does rather than that it agrees with what the primitive does.
 * The direction of that drift is the safe one — an over-counted write clears a key that was
 * still valid, which costs dedup and never a wrong picture — and per-channel SOLO is already
 * filtered upstream in `channelValuesFromNodes` rather than inside the primitive, which is
 * why the two filters here are the whole set today.
 *
 * Note it does NOT ask what changed by comparing the patched value against the base. That
 * is the same "walk the result" move the invariant rules out, one level down: it would make
 * the repair depend on the content it is supposed to be independent of, and it would cost a
 * deep compare per frame.
 */
function writtenPaths(
  channels: readonly KeyframeChannelValue[],
  nodeId: string,
  transients: Map<string, TransientEdit>,
): string[] {
  const paths: string[] = [];
  for (const ch of channels) if (!ch.mute && ch.paramPath) paths.push(ch.paramPath);
  for (const edit of transients.values()) if (edit.nodeId === nodeId) paths.push(edit.paramPath);
  return paths;
}

/**
 * Sample `channels` at `seconds` and apply the held edits for `nodeId` onto `base`, then
 * clear any identity the writes invalidated.
 *
 * Returns `base` BY REFERENCE when nothing was written (see property 1 above). Otherwise
 * returns the primitives' fresh clone, mutated in place — safe because the clone is ours and
 * has not been handed to anyone yet, and done through the same `writeAt` the overlay itself
 * uses, so there is one path-writer rather than two spellings of one.
 *
 * Precedence is unchanged: channels first (the committed curve), transients on top (the live
 * uncommitted edit). This composes the two primitives, it does not reimplement either.
 */
export function overlayWithIdentity<T>(
  band: OverlayBand,
  base: T,
  nodeId: string,
  channels: readonly KeyframeChannelValue[],
  transients: Map<string, TransientEdit>,
  seconds: number,
): T {
  const patched =
    overlayTransients(overlayChannels(base, channels, 1, seconds) ?? base, nodeId, transients) ??
    base;
  // Nothing was written — the base travels on untouched, and so does its identity. This is
  // the static scene, which must cost nothing and must not churn the caller's memo.
  if (patched === base) return base;

  const fields = identityFieldsForBand(band);
  if (fields.length === 0) return patched;

  const paths = writtenPaths(channels, nodeId, transients);
  const clone = patched as unknown as Record<string, unknown>;
  for (const field of fields) {
    if (!paths.some((p) => writeInvalidates(p, field.sourcePath))) continue;
    // Only clear an identity that is actually there. A data kind in this band that carries
    // no such field (a curve has no material) must not have one stamped onto it, and a value
    // whose key is already null has nothing to invalidate.
    if (readAt(clone, field.identityPath) == null) continue;
    // CLEAR, not re-mint. The consumer's documented fallback re-derives identity from the
    // spec it already holds (`irKeyFor` → `materialKeyOf(ir)`), which is the same function
    // the evaluator minted with — one spelling of identity, not two. Re-minting here would
    // be a second one, and it would have to live in the renderer.
    writeAt(clone, field.identityPath, null);
  }
  return patched;
}
