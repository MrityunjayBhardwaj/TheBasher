// #536 S2b — the structural gate: a renderer patch site may not hand on a value whose
// IDENTITY disagrees with its CONTENT.
//
// ── WHY THIS FILE EXISTS, AND WHY IT IS WRITTEN BEFORE THE FIX ──────────────────────
//
// S2 minted a material identity at evaluation and taught the registry to key on it. Its
// premise was checked by enumerating every INPUT the material build reads, and that
// enumeration was correct and complete. It still shipped a defect, because the animation
// overlay is not an input to the build: it rewrites the evaluated value itself, downstream
// of the mint, and hands the rewritten copy on carrying the producer's key. Eight browser
// tests went red — an animated or held-edit material colour never reaching the screen.
//
// So the missing question at this boundary is not "what does the build read?" but
// **"who WRITES to this value between the mint and the draw?"**. That question has a
// syntactic answer — a module cannot patch an evaluated value without importing one of the
// two overlay primitives — which is what makes it gateable rather than merely documented.
//
// ── WHY THE SWEEP IS KEYED ON THE IMPORT CLAUSE, NOT ON THE CALL ────────────────────
//
// A call-shape sweep (`/overlayChannels\(/`) reports whatever the current spelling happens
// to be: an aliased import, a re-export, or a wrapper renames the call and the sweep goes
// quietly clean. The same trap was MEASURED on the sibling slice — three of ten registry
// consumers import `get` under an alias, so a call-shape sweep misses them TODAY, before
// any refactor. An import-clause sweep cannot be dodged that way: aliasing keeps the
// original binding name on the left of `as`, and a module cannot consume a primitive
// without naming its path in an import statement. Guarded below by a positive control on
// exactly that alias form. ⚠️ The one thing that WOULD defeat it is a barrel re-export of
// either primitive; neither is re-exported today, and a gate case pins that.
//
// ── WHAT THIS GATE DOES AND DOES NOT PROVE ─────────────────────────────────────────
//
// It proves: the set of modules that patch an evaluated value is CLOSED and each member
// has stated which class of value it patches; and a module that patches RENDER values —
// the ones carrying minted identity — has the identity seam in scope. An eleventh call
// site in a new module reds this file until somebody classifies it.
//
// DECLARED LIMIT, stated rather than discovered later: importing the seam is not the same
// as routing every site through it. This is a structural backstop, not a proof of use. The
// behavioural gate is the eight browser specs that were already red before this slice
// began (conformance R5/R6 box+sphere, p522 ×2, p422, p149) plus `overlayWithIdentity`'s
// own unit tier, which is where "the key actually gets cleared" is measured.
//
// REF: src/app/overlayWithIdentity.ts (the seam); src/app/objectDataBand.ts
//      (`identityFieldsForBand` — the rule this enforces the reach of);
//      src/nodes/overlayChannels.ts + src/app/overlayTransients.ts (the two primitives);
//      hetvabhasa H261, vyapti V149 (the fourth hole), dharana B20 target 4; issue #536.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// #536 S3 — the enumeration is shared with the other two structural censuses rather than
// copied a third time. All three assert over "every source file", and a walk that silently
// narrowed in one copy would let that gate report a closed set over a smaller subject while
// still passing. Its positive controls live in `src/test-utils/sourceFiles.test.ts`; the
// walk itself sits in `tools/` for the typecheck reason its header records.
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { stripComments } from '../test-utils/sourceScan';

const SRC = join(__dirname, '..');

/**
 * Does this source APPLY an overlay — i.e. import one of the two primitives that write a
 * sampled channel or a held edit into an evaluated value?
 *
 * Keyed on the import CLAUSE naming the binding, so `overlayChannels as oc` still matches
 * (the alias keeps the original name), while `writeAt` / `readAt` — the dotted-path
 * helpers that live in the same module and patch nothing — correctly do not.
 */
export function appliesOverlay(src: string): boolean {
  return /import\s*\{[^}]*\b(overlayChannels|overlayTransients)\b[^}]*\}\s*from/.test(src);
}

/** What class of value a patch site hands on — and therefore what it owes the identity rule. */
type PatchClass =
  /**
   * Transform values: a `SceneChild`'s position/rotation/scale, resolved for the gizmo, the
   * inspector and the world-transform readers. Nothing minted travels on them, so a stale
   * key is not representable here.
   */
  | 'transform-values'
  /**
   * Values the renderer DRAWS from, which carry identity the evaluator minted
   * (`MeshDataValue.materialKey`). A patch here can produce content wearing the producer's
   * name, so this class owes the repair.
   */
  | 'render-values'
  /** The seam itself: it is where the repair lives, so it calls the primitives directly. */
  | 'identity-seam';

const PATCH_SITES: Record<string, PatchClass> = {
  // The read side. `resolveEvaluatedTransform` overlays a SceneChild's TRS for the gizmo
  // and the inspector; `resolveWorldTransform` does the same for the world-matrix walk and
  // the camera pose. Both patch transform bands only.
  'src/app/resolveEvaluatedTransform.ts': 'transform-values',
  'src/app/resolveWorldTransform.ts': 'transform-values',
  // The renderer. Five composite sites: two light-band sites (a recomposed LightValue
  // carries no minted identity), the glTF materials road (which writes scalars onto
  // per-clone THREE.Materials and never touches the registry), and the two `<MeshChild>`
  // sites — the ones measured to hand on a stale `materialKey`.
  'src/viewport/SceneFromDAG.tsx': 'render-values',
  // The seam.
  'src/app/overlayWithIdentity.ts': 'identity-seam',
};

/** The module a `render-values` patch site must have in scope. */
const SEAM = 'overlayWithIdentity';

describe('#536 S2b — every overlay patch site is classified', () => {
  it('has exactly one closed set of modules that patch an evaluated value', () => {
    // A new importer is not forbidden — it is a RED that forces whoever adds it to say
    // which class of value it patches, here, in this table. That is the point: the
    // eleventh patch site cannot be added without answering the identity question.
    const appliers = sourceFiles()
      .filter(([, src]) => appliesOverlay(src))
      .map(([path]) => path)
      .sort();

    expect(appliers).toEqual(Object.keys(PATCH_SITES).sort());
  });

  it('every module that patches RENDER values has the identity seam in scope', () => {
    // The obligation, in the only form a static gate can carry it: a module that rewrites
    // a value the renderer draws from must have the repair available to it. Without this
    // case the table above is a census; with it, the census has teeth.
    const missing: string[] = [];
    for (const [path, cls] of Object.entries(PATCH_SITES)) {
      if (cls !== 'render-values') continue;
      const src = readFileSync(join(SRC, '..', path), 'utf8');
      if (!new RegExp(`from\\s+['"][^'"]*${SEAM}['"]`).test(src)) missing.push(path);
    }
    expect(missing).toEqual([]);
  });

  it('neither overlay primitive is re-exported through a barrel', () => {
    // The one thing that would defeat an import-keyed sweep: a module a patch site could
    // import the primitive FROM without naming the primitive's own path. Nothing does this
    // today, and this case is what keeps it that way.
    const reExporters = sourceFiles()
      .filter(([path]) => path !== 'src/nodes/overlayChannels.ts')
      .filter(([, src]) =>
        /export\s*(?:\{[^}]*\b(?:overlayChannels|overlayTransients)\b[^}]*\}|\*)\s*from\s*['"][^'"]*overlay(?:Channels|Transients)['"]/.test(
          src,
        ),
      )
      .map(([path]) => path);

    expect(reExporters).toEqual([]);
  });

  it('keeps the set of values DECLARED exempt from the repair closed (#536 S3)', () => {
    // The brand on the renderer's entry point makes it impossible to draw a value nobody
    // decided about — but `identityIntact` is the one answer the compiler cannot check. It
    // records a caller's claim that nothing wrote to the value; it cannot verify it.
    //
    // So the claim itself is censused. This is not a third defence for the same question:
    // the brand enforces "you must decide", and this enforces "the set of things declared
    // exempt is small, named, and reviewed". A new caller is a RED that forces whoever adds
    // it to justify the exemption here, which is exactly where that argument belongs.
    const declarers = sourceFiles()
      .filter(([, src]) => /import\s*\{[^}]*\bidentityIntact\b[^}]*\}\s*from/.test(src))
      .map(([path]) => path)
      .sort();

    expect(declarers).toEqual(['src/viewport/SceneFromDAG.tsx']);

    // EXACTLY two call sites — the dispatcher's bare branch and the scatter road — not a
    // floor. A floor was the first version and falsification showed it too weak: swapping
    // the constraint road's `repairInvalidatedIdentity` for a declaration typechecks once the
    // now-unused import is also removed, and a `>= 2` census stays green through it. The
    // whole point of routing that site through the shared rule is that it does NOT get to
    // assert its own exemption, so a THIRD declaration must red and be argued for here.
    //
    // It also stops the subject silently emptying, which is the failure a bare census has.
    //
    // Comments are stripped, and that is not a precaution — the first version counted 3 on
    // a clean tree because the prop's own doc comment spells `identityIntact(value, reason)`
    // while explaining the rule. Prose that documents a mechanism must not register as a use
    // of it, or the honest way to make this gate green is to stop writing the explanation.
    const src = stripComments(readFileSync(join(SRC, 'viewport/SceneFromDAG.tsx'), 'utf8'));
    expect(src.match(/\bidentityIntact\(/g)?.length ?? 0).toBe(2);
  });

  it('guards the guard — the sweep sees an ALIASED import, which a call-shape sweep cannot', () => {
    // The positive control that makes the two cases above evidence rather than an empty
    // assertion. Three synthetic sources: the plain form, the alias form (the one that
    // defeats a call-shape sweep), and a same-module helper import that must NOT match.
    expect(appliesOverlay(`import { overlayChannels } from '../nodes/overlayChannels';`)).toBe(
      true,
    );
    expect(
      appliesOverlay(`import { overlayChannels as oc } from '../nodes/overlayChannels';`),
    ).toBe(true);
    expect(appliesOverlay(`import { writeAt, readAt } from '../nodes/overlayChannels';`)).toBe(
      false,
    );

    // And it really matches the live sources, so a regex that had gone stale would fail
    // here rather than reporting an empty patch-site set forever.
    expect(appliesOverlay(readFileSync(join(SRC, 'viewport/SceneFromDAG.tsx'), 'utf8'))).toBe(true);
  });
});
