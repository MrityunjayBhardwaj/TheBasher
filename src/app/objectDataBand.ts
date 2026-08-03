// objectDataBand — WHERE a split object's data half lands inside the value the
// renderer actually reads, and therefore where an overlay has to WRITE for read to
// equal render ([[H40]]).
//
// The object↔data split gives every scene object two nodes: an `Object` owning the
// pose, and an `ObjectData` node owning the substance. But the two halves are NOT
// recombined the same way on every render road, and that difference is the whole
// content of this file:
//
//   'children' (BoxData / SphereData / CurveData — the scene.children band)
//       `ObjectR` reads the data half off `value.data` (`value.data.geometry`,
//       `value.data.material`). An overlay for a data param must be REBASED under
//       `data.` or it lands on the Object, which nothing reads.
//
//   'lights' (LightData — the scene.lights band)
//       `recomposeLightObject` flattens the pair into the `LightValue` the light
//       renderer still consumes, so shading is TOP-LEVEL (`value.intensity`). An
//       overlay must stay FLAT. Copying the mesh rebase writes `value.data.intensity`,
//       which the light renderer never reads — the animated intensity FREEZES, with
//       typecheck and the whole unit suite green (#386 R2).
//
//   'camera' (CameraData — the scene.camera band)
//       Flat like the light, but for a DIFFERENT reason, and the difference is the
//       point: nothing renders from the camera's evaluated value AT ALL. The
//       recomposed `CameraValue` reaches the renderer only as an ingredient in a
//       render-cache key; the picture is framed by a `CameraPose` that
//       `activeCamera.ts` builds from RAW params and overlays with its own private,
//       node-id-keyed channel scan. Both structs are flat, so the path answer is
//       identity — but a caller that concluded "flat, therefore the value overlay
//       works" would be wrong. `renderReachForBand` below is what makes that second
//       question askable instead of assumed (#387).
//
// WHY THIS IS A FUNCTION, AND WHY IT IS CLOSED BY A `never`:
// the rule used to exist only as *which of four private hooks the viewport dispatcher
// happened to call* (useDataParamChannels / useDataParamTransients rebasing, and
// useLightShadingChannels / useLightShadingTransients not). Nothing NAMED the rule, so
// nothing could ask it: no test could state the decision, and a new band inherited
// whichever branch it was pasted next to rather than being decided. Naming it is what
// makes it testable, falsifiable, and — via the `never` — impossible to forget.
//
// Adding a member to `SplitBand` (the camera band, #387) is deliberately a COMPILE
// ERROR here: at the one site that has to decide the new band's channel shape. Do NOT
// add a `default:` arm that guesses — the defensive-looking fallthrough IS the bug
// ([[V109]], and the same reasoning that closes `modifierDataSource`).
//
// REF: src/viewport/SceneFromDAG.tsx (the four hooks that consume this);
//      src/nodes/lightRecompose.ts (the flattening the 'lights' band names);
//      docs/OBJECT-DATA-SPLIT-DESIGN.md §3.1.

/**
 * Which render band a split object's value is recombined in. Not a property of the
 * data node's TYPE but of the road its value travels — which is why a new data kind
 * in an existing band inherits the band's answer for free, and a new BAND does not.
 */
export type SplitBand = 'children' | 'lights' | 'camera';

/**
 * The bands whose picture actually comes from the overlaid VALUE — and therefore the only
 * bands the lane overlay may be asked for (#522).
 *
 * ⚠️ THIS EXISTS BECAUSE A TEXT GATE WENT BLIND, AND THE REPLACEMENT IS STRICTER. The band
 * used to be a literal at each of the four viewport hooks, so a scan of production sources
 * for `channelPathForBand('camera', …)` could assert the camera never took the value road.
 * #522 threads the band through two shared hooks instead, which left the scan with no
 * subject at all — caught by that gate's own positive control, which is the only reason it
 * was noticed. Excluding the band at the TYPE means a camera overlay is a compile error
 * rather than something a scan has to keep being able to see.
 *
 * `renderReachForBand` is still the place that says WHY the camera is excluded; this is the
 * enforcement, not the reason.
 */
export const OVERLAY_BANDS = ['children', 'lights'] as const;
export type OverlayBand = (typeof OVERLAY_BANDS)[number];

/**
 * The paramPath an overlay must use so the renderer reads it, given the band the
 * value renders in and the param's path ON THE DATA NODE.
 *
 * Pure string transform: it must not allocate, must not depend on state, and must
 * return `paramPath` unchanged whenever the band needs no rebase, so a caller can
 * preserve object identity (and therefore memo stability) on the no-op path.
 */
export function channelPathForBand(band: SplitBand, paramPath: string): string {
  switch (band) {
    case 'children':
      // ObjectR reads `value.data.*`.
      return `data.${paramPath}`;
    case 'lights':
      // The recomposed LightValue is flat — `value.intensity`, not `value.data.intensity`.
      return paramPath;
    case 'camera':
      // Both structs the camera has to satisfy are flat: the recomposed CameraValue
      // (`value.fov`) and the CameraPose the resolver writes as `pose[path]`. So the
      // answer is identity — but see `renderReachForBand`: for this band the value
      // overlay is not what frames the shot, and no production caller passes 'camera'
      // here today. That is deliberate, and it is pinned rather than commented.
      return paramPath;
    default: {
      const exhaustive: never = band;
      void exhaustive;
      return paramPath;
    }
  }
}

/**
 * WHERE a band's renderer takes the value it draws from.
 *
 * `channelPathForBand` answers "where does an overlay have to be written?". That
 * question quietly presumes a second one — "is the thing being overlaid what the
 * renderer reads?" — and for the first two bands the answer was so obviously yes that
 * nobody had to ask. The camera is the case where it is NO: its evaluated value is a
 * render-cache-key ingredient, and the picture comes from a `CameraPose` that
 * `activeCamera.ts` builds from raw params. An overlay onto the value would land
 * somewhere real, be readable back, and change nothing on screen.
 *
 * So the two questions get two functions. A band that answered the path question and
 * inherited the reach answer from whichever arm it was pasted beside is exactly the
 * failure `channelPathForBand`'s header describes, one level up.
 *
 * ⚠️ THE `never` BELOW DOES NOT GUARD THIS. It closes against a NEW band, not against
 * a WRONG answer for an existing one: flipping the camera to 'evaluated-value'
 * compiles, and sends the conformance road down the value path where the flat
 * recomposed `CameraValue` accepts the overlay and the road PASSES. A road cannot
 * guard its own dispatch. The guard is the per-band equality in
 * `objectDataBand.test.ts`, which states every answer once, by name.
 */
export type RenderReach = 'evaluated-value' | 'params-resolver';

export function renderReachForBand(band: SplitBand): RenderReach {
  switch (band) {
    case 'children':
      // ObjectR draws from `value.data.*`.
      return 'evaluated-value';
    case 'lights':
      // LightKindR draws from the recomposed flat LightValue.
      return 'evaluated-value';
    case 'camera':
      // `cameraPoseFromNode` reads node.params RAW; `resolveCameraPoseAt` overlays
      // channels itself, by node id. The evaluated value is not on that road.
      return 'params-resolver';
    default: {
      const exhaustive: never = band;
      void exhaustive;
      return 'evaluated-value';
    }
  }
}

/**
 * An identity field the band's value carries, and the region of the value whose CONTENT
 * that identity stands for.
 *
 * Both paths are stated in the band's own vocabulary — i.e. rebased through
 * `channelPathForBand`, exactly like an overlay write — so a caller compares like with
 * like and never has to know that the children band lives under `data.`.
 */
export interface BandIdentityField {
  /** Where the identity field itself sits on the band's value. */
  readonly identityPath: string;
  /** The region it identifies. A write at or under this path invalidates it. */
  readonly sourcePath: string;
}

/**
 * The DUAL of `channelPathForBand`, and the third member of this family.
 *
 * `channelPathForBand` answers "where must an overlay be WRITTEN?"; `renderReachForBand`
 * answers "is that what the renderer READS?". This one answers the question those two left
 * unasked, and whose absence shipped as a bug (#536 S2, [[H261]]): **what does that write
 * INVALIDATE?**
 *
 * Identity is minted by evaluation (`MeshDataValue.materialKey`) and consumed by a
 * content-keyed registry. An overlay does not write into the evaluator's output — it clones
 * the evaluated value, writes the animated field into the clone, and hands the clone on. The
 * clone inherits the producer's key verbatim, so content and identity disagree and the
 * registry answers with the resource built for the PRE-EDIT content. Nothing errors; the
 * inspector shows the new value and the picture is frozen.
 *
 * So a writer that patches an evaluated value owns the identity on it. This function is what
 * lets it discharge that without knowing anything about materials: it holds the paths it
 * wrote, and this says which identity fields those writes killed.
 *
 * ⚠️ DERIVED FROM `channelPathForBand`, NEVER SPELLED. Writing `data.material` here would
 * put a per-KIND assumption beside a per-BAND rule — the exact shape that broke the first
 * attempt at S1 ([[H260]]): the rebase rule keys on the band, so a hardcoded prefix is
 * correct for one band and silently wrong for the next.
 *
 * ⚠️ GEOMETRY IS NOT IN THIS LIST, AND THAT IS STILL DELIBERATE — it is repaired by
 * {@link handleFieldsForBand} instead, because its repair is a REBUILD rather than a clear
 * (#537). Clearing works for material only because the consumer has a documented fallback
 * (`materialKeyOf(ir)` — it re-derives from the spec the value still holds); a null geometry
 * ref draws NOTHING, since the registry needs a descriptor to build anything at all. Listing
 * geometry here would replace a freeze with a blank.
 */
export function identityFieldsForBand(band: SplitBand): readonly BandIdentityField[] {
  switch (band) {
    case 'children':
      // `MeshDataValue.materialKey` sits beside `material` on the data half, so both rebase
      // the same way and the pair is derived, not written.
      return [
        {
          identityPath: channelPathForBand(band, 'materialKey'),
          sourcePath: channelPathForBand(band, 'material'),
        },
      ];
    case 'lights':
      // The recomposed LightValue carries shading scalars and no minted identity: a light
      // is not built through a content-keyed registry, so no write here can go stale.
      // ⚠️ IF THIS ARM EVER BECOMES NON-EMPTY, THE TWO LIGHT PATCH SITES MUST BE MOVED ONTO
      // THE SEAM — they still call the overlay primitives directly today, which is correct
      // only while there is nothing here for them to invalidate. Nothing enforces that
      // ordering, so it is written at the arm whose change would create the obligation.
      return EMPTY_IDENTITY_FIELDS;
    case 'camera':
      // Nothing renders from the camera's evaluated value at all (`renderReachForBand`), so
      // there is no identity on it for a write to invalidate. Same answer as the light band,
      // for a different reason — which is exactly why this file states each band's answer
      // rather than letting one arm be inherited from whichever it was pasted beside.
      return EMPTY_IDENTITY_FIELDS;
    default: {
      const exhaustive: never = band;
      void exhaustive;
      return EMPTY_IDENTITY_FIELDS;
    }
  }
}

/** Stable empty array — a band with no minted identity must not churn a caller's memo. */
const EMPTY_IDENTITY_FIELDS: readonly BandIdentityField[] = [];

/**
 * Does a write at `writtenPath` invalidate an identity standing for `sourcePath`?
 *
 * Prefix containment on whole segments: `data.material` is invalidated by `data.material`
 * itself and by `data.material.base.color`, and NOT by `data.materialKey` — which shares a
 * character prefix and is a different field. A naive `startsWith` gets that pair wrong in
 * the one place it matters most, since the key sits right beside the region it identifies.
 */
export function writeInvalidates(writtenPath: string, sourcePath: string): boolean {
  return writtenPath === sourcePath || writtenPath.startsWith(`${sourcePath}.`);
}

/**
 * A HANDLE the band's value carries — a field whose content is not on the value at all, but
 * behind a key into a registry that builds it.
 *
 * The FIFTH member of this family, and the dual of {@link BandIdentityField}. That one says
 * "a write here invalidates an identity, and the repair is to clear it". This says "a write
 * to a param this handle is BUILT FROM invalidates the handle, and the repair is to rebuild
 * it" — which is a different repair because a cleared handle has no fallback to land on.
 */
export interface BandHandleField {
  /** Where the handle sits on the band's value. */
  readonly handlePath: string;
}

/**
 * The handles a band's value carries, in the band's own vocabulary (#537).
 *
 * ⚠️ THE QUESTION THIS ANSWERS IS NOT "WHICH PARAMS FEED IT". That would be a per-KIND table
 * sitting beside a per-BAND rule — [[H260]]'s trap, and the reason the first attempt at
 * carrying material identity failed. Which params feed a handle is answered by the handle
 * itself, from its own descriptor (`descriptorParamFields`), so a new geometry kind needs no
 * edit here. This function only says WHERE the handle lives on this band's value.
 */
export function handleFieldsForBand(band: SplitBand): readonly BandHandleField[] {
  switch (band) {
    case 'children':
      // `ObjectR` draws `getForAttach(value.data.geometry)`. Derived through the rebase rule
      // exactly like every other path in this file — `data.` is never spelled.
      return CHILDREN_HANDLE_FIELDS;
    case 'lights':
      // A light has no geometry: `LightKindR` builds from flat scalars on the recomposed
      // value, with no registry between it and the picture. Nothing here to go stale.
      return EMPTY_HANDLE_FIELDS;
    case 'camera':
      // Nothing renders from the camera's evaluated value at all (`renderReachForBand`), so
      // it holds no handle the renderer could resolve. Same answer as the light band, for a
      // different reason — which is why each band states its own.
      return EMPTY_HANDLE_FIELDS;
    default: {
      const exhaustive: never = band;
      void exhaustive;
      return EMPTY_HANDLE_FIELDS;
    }
  }
}

/** Stable arrays — a band's handle list must not churn a caller's memo (see the identity twin). */
const EMPTY_HANDLE_FIELDS: readonly BandHandleField[] = [];
const CHILDREN_HANDLE_FIELDS: readonly BandHandleField[] = [
  { handlePath: channelPathForBand('children', 'geometry') },
];
