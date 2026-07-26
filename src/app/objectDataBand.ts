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
// ([[V109]], and the same reasoning that closes `modifierSource`).
//
// REF: src/viewport/SceneFromDAG.tsx (the four hooks that consume this);
//      src/nodes/lightRecompose.ts (the flattening the 'lights' band names);
//      docs/OBJECT-DATA-SPLIT-DESIGN.md §3.1.

/**
 * Which render band a split object's value is recombined in. Not a property of the
 * data node's TYPE but of the road its value travels — which is why a new data kind
 * in an existing band inherits the band's answer for free, and a new BAND does not.
 */
export type SplitBand = 'children' | 'lights';

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
    default: {
      const exhaustive: never = band;
      void exhaustive;
      return paramPath;
    }
  }
}
