// overlayWithIdentity — the render-time overlay, WITH the repairs the overlay owes the value
// it patches: an identity key it invalidated (#536 S2b) and a handle it wrote through (#537).
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
// REF: src/app/objectDataBand.ts (`identityFieldsForBand` + `handleFieldsForBand` — the two
//      rules); src/app/modifierGeometry.ts (`rebuildGeometryRef` — the handle repair);
//      src/app/geometryHandleReach.gate.test.ts (the correspondence it rests on);
//      tests/e2e/p537-animated-geometry-param.spec.ts (the behaviour, in a browser);
//      src/nodes/materialKey.ts
//      (the mint); src/app/material/primitiveMaterialInputs.ts (`irKeyFor` — the documented
//      fallback a cleared key lands on); src/app/materialRegistry.ts (the consumer);
//      src/app/overlayIdentity.gate.test.ts (the structural gate);
//      ref/houdini/SOP.md §6b; hetvabhasa H261, vyapti V149, dharana B20; issues #536, #537.

import { overlayChannels, readAt, writeAt } from '../nodes/overlayChannels';
import { overlayTransients } from './overlayTransients';
import type { KeyframeChannelValue } from '../nodes/types';
import type { TransientEdit } from './stores/transientEditStore';
import {
  channelPathForBand,
  handleFieldsForBand,
  identityFieldsForBand,
  writeInvalidates,
  type OverlayBand,
} from './objectDataBand';
import { descriptorParamFields, rebuildGeometryRef } from './modifierGeometry';
import type { GeometryRef, SceneObject } from '../nodes/types';

// ── THE BRAND (#536 S3, rung 3) ───────────────────────────────────────────────────────
//
// Everything above closes the defect for the two call sites that HAD it. It does not stop
// a third site from mounting a renderer with a value whose identity nobody considered —
// which is how this bug arrived in the first place, and gating for it would be a third
// defence rather than a stronger tier.
//
// So the renderer's entry point stops accepting a bare `SceneObject`. A value reaches it
// only from a named producer: either it went through the repair above, or a caller stated
// that nothing wrote to it and said which guarantee makes that true.
//
// ⚠️ WHAT THIS IS AND IS NOT — the honest limit, because the difference matters. This makes
// it impossible to mount the renderer with a value NOBODY DECIDED ABOUT. It does NOT verify
// that a declaration is true: `identityIntact` cannot check that no write happened, it can
// only record a caller's claim that none did. The strengthening is real — the two exempt
// sites become visible and named instead of silently indistinguishable from the two that
// needed repair, and a fifth mount cannot compile until it picks a side — and it stops
// exactly there. Rung 4 (the bad pairing unconstructible) would mean the renderer taking
// the un-overlaid value and doing the overlay itself, which is a different design.

declare const IDENTITY_INTACT: unique symbol;

/**
 * A value whose render identity agrees with its content — i.e. any identity field on it
 * (today, `materialKey`) still describes what the value actually holds.
 *
 * Only the two producers below mint this. It is a marker, not data: it exists at the type
 * level and nothing is added to the value at runtime.
 */
export type IdentityIntact<T> = T & { readonly [IDENTITY_INTACT]: true };

/**
 * The closed set of reasons a value can carry sound identity WITHOUT going through the
 * repair. Each member is a specific structural guarantee that no render-time write
 * happened — not a general "looks fine to me".
 *
 * Closed on purpose. A sixth mount site cannot quietly join by inventing a reason string;
 * adding a member is an edit to this union, which is where the argument belongs.
 */
export type NoWriteReason =
  /**
   * The overlay dispatcher took its bare branch: the node has no active constraint and no
   * direct channels, so neither overlay renderer ran and nothing patched the evaluated
   * value. Its identity is the one the evaluator minted, which is by definition correct.
   */
  | 'no-overlay-ran'
  /**
   * A road with no render-time overlay at all — the scatter instances, which draw an
   * asset value straight off the evaluated scatter. No writer exists on this path, so
   * there is nothing that could invalidate an identity.
   */
  | 'no-overlay-on-this-road';

/**
 * Declare that `value` carries sound identity because nothing wrote to it.
 *
 * This is a DECLARATION, not a check — see the limit above. It is nonetheless the point of
 * the exercise: before this existed, a site that legitimately needed no repair and a site
 * that had silently skipped one were the same expression, so neither reader nor compiler
 * could tell them apart. Now the first states its reason and the second does not compile.
 */
export function identityIntact<T>(value: T, _reason: NoWriteReason): IdentityIntact<T> {
  return value as IdentityIntact<T>;
}

/** Narrowed alias for the renderer's entry point, which is where the brand is enforced. */
export type IdentifiedSceneObject = IdentityIntact<SceneObject>;

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
): IdentityIntact<T> {
  const patched =
    overlayTransients(overlayChannels(base, channels, 1, seconds) ?? base, nodeId, transients) ??
    base;
  // Nothing was written — the base travels on untouched, and so does its identity. This is
  // the static scene, which must cost nothing and must not churn the caller's memo.
  if (patched === base) return base as IdentityIntact<T>;

  return repairInvalidatedIdentity(band, patched, writtenPaths(channels, nodeId, transients));
}

/**
 * Rebuild any HANDLE on `value` that the writes fed (#537).
 *
 * The other half of the same debt, with the opposite repair. A material key is cleared
 * because its consumer re-derives from the spec the value still holds; a geometry ref cannot
 * be cleared, because the registry needs a descriptor to build anything and a null ref draws
 * nothing at all. So this folds the written params into the descriptor and re-mints through
 * `rebuildGeometryRef`, i.e. through the very builder the evaluator used — one spelling of a
 * geometry key, not two.
 *
 * Both questions are answered by the pieces that own them, and neither is spelled here:
 * WHERE the handle sits comes from the band (`handleFieldsForBand`), WHICH params feed it
 * comes from the handle's own descriptor (`descriptorParamFields`). That split is what lets a
 * new geometry kind work with no edit to this file, and a new band with no edit to the
 * geometry module.
 *
 * ⚠️ THE COST THIS SHIPS WITH, MEASURED RATHER THAN GUESSED — read before assuming it is
 * free. A re-minted key is a registry MISS, so every distinct animated value builds and
 * caches a `BufferGeometry`, and `geometryRegistry` is a plain Map with no refcount and no
 * eviction (unlike `materialRegistry`, which `usePrimitiveMaterial` retains and releases).
 * Measured: a 2s animation at 60fps leaves 121 entries, one per frame.
 *
 * What makes that acceptable rather than a leak is the second measurement: replaying the
 * SAME frames adds ZERO. The cache is content-keyed, so growth is bounded by the number of
 * DISTINCT values a director actually visits, not by time or by playback count — scrubbing
 * a timeline back and forth converges instead of accumulating. The residual is a long
 * editing session over continuously varying values, which is the geometry half of the
 * lifetime question #535 already owns; it is not created by this repair, only made
 * reachable by it. Deliberately NOT fixed here (the alternative was a refcount touching
 * every attach site, i.e. a different slice).
 */
function rebuildInvalidatedHandles(
  band: OverlayBand,
  value: unknown,
  paths: readonly string[],
): void {
  const fields = handleFieldsForBand(band);
  if (fields.length === 0) return;

  const clone = value as Record<string, unknown>;
  for (const field of fields) {
    const ref = readAt(clone, field.handlePath) as GeometryRef | null | undefined;
    // A data kind in this band may carry no handle at all (a curve has no geometry), and a
    // loose value may carry something that is not a ref. Neither is an error here.
    if (!ref || typeof ref !== 'object' || !('descriptor' in ref)) continue;

    const written: Record<string, unknown> = {};
    for (const param of descriptorParamFields(ref.descriptor)) {
      const paramPath = channelPathForBand(band, param);
      // `writeInvalidates`, not equality — reused from the identity half deliberately, so a
      // component-level write (`data.size.0`) counts as reaching `size` exactly as a whole
      // one does, and the containment rule has one definition rather than two.
      if (!paths.some((p) => writeInvalidates(p, paramPath))) continue;
      written[param] = readAt(clone, paramPath);
    }

    const rebuilt = rebuildGeometryRef(ref, written);
    // Returned by reference when nothing it builds from was written — so a value whose
    // animation never touches geometry keeps the key the evaluator minted, and two objects
    // sharing a build do not stop sharing because one of them moved.
    if (rebuilt !== ref) writeAt(clone, field.handlePath, rebuilt);

    // ⚠️ THE OVERLAY'S OWN WRITE IS LEFT WHERE IT LANDED, and a reader should know why. The
    // clone still carries `data.size` — a field with no consumer, which is precisely the
    // shape that kept this bug invisible. It is NOT deleted here, deliberately: the overlay
    // primitives own what they write, this function owns what those writes invalidated, and
    // reaching back to unwrite another owner's field would put two owners on one path. The
    // rebuilt handle is the authoritative one; treat `data.<param>` on a patched value as a
    // by-product of the write, never as something the renderer reads.
  }
}

/**
 * Repair everything on `value` that a write to `paths` invalidated, and brand the result.
 *
 * TWO repairs, because the boundary has two kinds of stale thing and they need opposite
 * treatment (#536 S2b, #537):
 *   • an identity KEY whose consumer can re-derive → CLEAR it, and let the documented
 *     fallback recompute from the content the value still holds.
 *   • a HANDLE whose consumer cannot → REBUILD it from the written params, because clearing
 *     it would replace a frozen picture with no picture at all.
 * Naming this "clear" would have been half the rule, and the half that shipped a freeze.
 *
 * The rule the overlay owes its own clone, available to any writer that patches a value
 * AFTER the overlay has run. There is exactly one such writer today — the constraint road
 * spreads the overlaid value into a fresh object to apply a derived aim/position — and it
 * calls this rather than declaring itself exempt, because "does writing `rotation`
 * invalidate a material key?" is a question this module already answers. A declaration
 * there would be a second spelling of that answer, and the two would drift the first time
 * a constraint learns to write a band it does not write today.
 *
 * ⚠️ PRECONDITION: `value` must be freshly built and not yet handed to anyone — this
 * mutates in place. Both callers satisfy it (the overlay's own clone, and the constraint's
 * spread), and it is the same precondition the overlay has always relied on.
 */
export function repairInvalidatedIdentity<T>(
  band: OverlayBand,
  value: T,
  paths: readonly string[],
): IdentityIntact<T> {
  rebuildInvalidatedHandles(band, value, paths);

  const fields = identityFieldsForBand(band);
  if (fields.length === 0) return value as IdentityIntact<T>;

  const clone = value as unknown as Record<string, unknown>;
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
  // Every identity the writes invalidated has been cleared, which is exactly the claim the
  // brand carries — so this is the one place entitled to mint it by repair.
  return value as IdentityIntact<T>;
}
