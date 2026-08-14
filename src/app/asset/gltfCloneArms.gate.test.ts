// #629 — the four arms that reach into the live glTF clone registry. A RATCHET.
//
// ── WHAT AN "ARM" IS, AND WHY COUNTING THEM IS WORTH A GATE ───────────────────────────
//
// `getGltfClone(assetRef)` hands back the live three.js Group the renderer is currently
// showing. Four production modules call it, and each does so for the same underlying
// reason: it needs geometry data that an imported glTF has and the geometry model has
// nowhere to put. There is no `GeometryDescriptor` member that carries an imported
// mesh's buffers, so a consumer that needs them has to go around the model and ask the
// RENDERER for the object it is drawing.
//
// That is a symptom, not a design. Each arm is a place where the read path branches on
// "did this come from glTF?", which is exactly what the geometry data model exists to
// abolish. The arms are deleted wholesale when glTF becomes an ordinary importer — they
// do not get individually refactored.
//
// ── WHY THE COUNT MAY ONLY GO DOWN ────────────────────────────────────────────────────
//
// The attribute phase edits `resolveMeshUVSpace.ts`, which IS one of these four. Wiring
// an attribute read there is precisely the moment someone needs "the UVs of a glTF mesh"
// and reaches for the clone because it is right there and it works. A fifth arm added
// that way is invisible — every test stays green, the feature works, and the debt is
// only discovered when the importer phase tries to delete a set that has grown.
//
// So this gate is a ratchet. Four is not a target; it is a ceiling that must fall.
//
// ── THE TWO WAYS A CENSUS LIKE THIS LIES, AND HOW EACH IS CLOSED ──────────────────────
//
// 1. A NAME-OCCURRENCE grep over-counts and lies in the SAFE direction. At the time of
//    writing, `getGltfClone` appears 12 times in non-test sources; only 4 are imports.
//    The rest are the definition, doc comments and references in prose. A gate keyed on
//    the name would report 12, someone would "fix" it to 12, and the ratchet would then
//    have three spare notches nobody could account for. Comments are stripped first.
//
// 2. An IMPORT-CLAUSE sweep under-counts and lies in the DANGEROUS direction. A clause
//    sweep keys on the imported binding, so `import * as reg from './gltfCloneRegistry'`
//    names the module and never the binding — the sweep sees nothing and reports clean.
//    That exact hole was measured in this repo before, in the sibling registry gate,
//    where five of nine importers were namespace imports.
//
//    This gate keys on the MODULE SPECIFIER instead. Every form of import — named,
//    aliased, namespace, default, side-effect — has to name the module it comes from, so
//    the hole is closed by construction rather than by enumerating the forms.
//
// ── WHY THE MODULE-KEYED SET IS PARTITIONED RATHER THAN COUNTED ───────────────────────
//
// Keying on the module alone over-counts in the other direction, and this was measured
// while writing the gate rather than reasoned about: the census returned FIVE, not four.
// The fifth is `SceneFromDAG.tsx`, which imports `registerGltfClone` / `unregisterGltfClone`.
// It is the PRODUCER — the renderer filling the registry as it mounts and unmounts clones.
// It does not reach past the geometry model into anything; it is the thing being reached
// into. Counting it as an arm would mean the importer phase had one more site to delete
// than it does, and the ratchet would be measuring the wrong quantity.
//
// So the module set is PARTITIONED by which binding a file names, and the partition is
// required to be exhaustive: readers + producer must account for every module importer,
// with no remainder.
//
// Be precise about what each half does, because the obvious summary is wrong and was
// measured wrong here. The halves classify on the NAME appearing anywhere in the
// comment-stripped source, not on the import clause. So a namespace importer that writes
// `reg.getGltfClone(…)` is caught by the reader half and counted as an arm, correctly —
// verified by perturbation, where the arm assertions red and the remainder assertion
// stays green. The remainder assertion is therefore NOT the thing that catches ordinary
// namespace imports; the reader half already does.
//
// What the remainder assertion catches is the residue: a module that imports the registry
// and names neither binding anywhere — an opaque or computed access. That is a narrow
// case, and it is stated narrowly rather than sold as general namespace coverage. It is
// still worth its assertion, because it is the only shape that would otherwise pass all
// three of the others while holding a live clone. Verified by perturbation: a probe
// reaching the door through a computed key reds it, by path.
//
// ── THE QUESTION THIS GATE ANSWERS, AND THE ONE IT DOES NOT ───────────────────────────
//
// It answers: which production modules take a dependency on the clone registry. It does
// NOT answer: who is holding a live clone. A module handed a Group by one of these four
// holds the same object while importing nothing, and an import census is structurally
// incapable of seeing that. Stated here so a future reader does not mistake a green
// ratchet for a closed question.
//
// REF: src/app/asset/gltfCloneRegistry.ts (the subject);
//      src/app/registryDoors.gate.test.ts (the sibling gate this technique comes from);
//      tools/gates/sourceFiles.ts (the shared enumeration); issues #629, #389, #628.

import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../../../tools/gates/sourceFiles';
import { stripComments } from '../../test-utils/sourceScan';

/** The module every arm must name to reach the registry, whatever it calls the binding. */
const CLONE_REGISTRY_MODULE = 'gltfCloneRegistry';

/**
 * The arms as they stand. Listed by path rather than counted, because a set is strictly
 * stronger than a number: swapping one arm for another keeps a count at four and is
 * exactly the change that should be noticed.
 *
 * `resolveMeshUVSpace.ts` carries two call sites behind its single import. The unit here
 * is the MODULE — one module taking the dependency is one arm to delete — so the import
 * is the thing counted, not the call.
 */
const EXPECTED_ARMS = [
  'src/app/animate/dispatchApplyTransform.ts',
  'src/app/geometrySampleSource.ts',
  'src/app/resolveMeshUVSpace.ts',
  'src/app/resolveOverrideSlots.ts',
] as const;

/**
 * The renderer, and only the renderer, fills the registry. Pinned as its own claim: a
 * second producer would mean two writers for a shared resource, which is a different and
 * worse problem than a fifth reader.
 */
const EXPECTED_PRODUCERS = ['src/viewport/SceneFromDAG.tsx'] as const;

/** Every production module that imports the clone registry, however it phrases it. */
function moduleImporters(): { path: string; src: string }[] {
  const specifier = new RegExp(`from\\s*['"][^'"]*${CLONE_REGISTRY_MODULE}['"]`);
  return sourceFiles()
    .filter(([path]) => !path.endsWith(`asset/${CLONE_REGISTRY_MODULE}.ts`)) // the module itself
    .map(([path, src]) => ({ path, src: stripComments(src) }))
    .filter(({ src }) => specifier.test(src))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Reaches IN for a live clone — an arm. */
function armsInProduction(): string[] {
  return moduleImporters()
    .filter(({ src }) => /\bgetGltfClone\b/.test(src))
    .map(({ path }) => path);
}

/** Puts clones IN — the registry's filler, not a consumer of the geometry model. */
function producersInProduction(): string[] {
  return moduleImporters()
    .filter(({ src }) => /\b(register|unregister)GltfClone\b/.test(src))
    .map(({ path }) => path);
}

const WHY = [
  'Each of these modules reaches past the geometry model into the live render clone,',
  'because an imported glTF mesh has no data half for its buffers to live in. The fix for',
  'a new one is never "add another reader" — it is to give glTF a data half, which is what',
  'the importer phase does. All four are then deleted together.',
].join(' ');

describe('#629 — the clone-reaching arms are pinned and may only go down', () => {
  it('is exactly the four known arms, by path', () => {
    const arms = armsInProduction();
    expect(
      arms,
      `The set of modules importing ${CLONE_REGISTRY_MODULE} changed.\n${WHY}\n` +
        `If an arm was REMOVED, delete its line from EXPECTED_ARMS — that is the ratchet ` +
        `turning the right way. If one was ADDED, it should not have been.`,
    ).toEqual([...EXPECTED_ARMS]);
  });

  it('never grows, even if the paths are re-arranged', () => {
    const arms = armsInProduction();
    // Deliberately separate from the set assertion. A rename that moves an arm to a new
    // path is a legitimate edit and should be a one-line update above; growing the count
    // is not, and this states that as its own claim with its own message.
    expect(
      arms.length,
      `${arms.length} modules now reach the clone registry, up from ${EXPECTED_ARMS.length}.\n${WHY}`,
    ).toBeLessThanOrEqual(EXPECTED_ARMS.length);
  });

  it('the renderer is the only producer', () => {
    expect(
      producersInProduction(),
      'A second module now writes into the clone registry. That is a shared resource with ' +
        'two writers, which is a different and worse problem than another reader.',
    ).toEqual([...EXPECTED_PRODUCERS]);
  });

  it('every module importer is classified — no unclassified remainder', () => {
    const all = moduleImporters().map(({ path }) => path);
    const classified = new Set([...armsInProduction(), ...producersInProduction()]);
    const remainder = all.filter((p) => !classified.has(p));

    // THE ASSERTION THAT CLOSES THE NAMESPACE HOLE. A namespace importer names the module,
    // so it lands in `all`; it matches neither binding pattern, so it lands in neither
    // half; so it surfaces here. Without this, a namespace import is invisible to the
    // binding-keyed halves and the gate would pass while an arm hid behind `reg.get…`.
    expect(
      remainder,
      `These modules import ${CLONE_REGISTRY_MODULE} but use neither a reader nor a producer ` +
        `binding — most likely a namespace import, which hides which door it opens. ` +
        `Name the binding.\n${WHY}`,
    ).toEqual([]);
  });

  it('the census is not vacuous — it walked a real file set and the name-grep over-counts', () => {
    const files = sourceFiles();
    // Report the denominator. A `found=4` over an empty walk is indistinguishable from a
    // correct answer unless the size of the thing walked is stated.
    expect(files.length, 'the enumeration must have found production sources').toBeGreaterThan(400);

    // The over-count made observable rather than asserted about in prose: files merely
    // MENTIONING the reader exceed files that import it. That gap is what a name-keyed
    // gate would have swallowed.
    const nameHits = files.filter(([, src]) => /getGltfClone/.test(src)).length;
    expect(nameHits).toBeGreaterThan(armsInProduction().length);

    // And the module-keyed technique sees a namespace import, which a clause-keyed one
    // cannot. Asserted against a synthetic source so it stays true whether or not a real
    // namespace importer happens to exist today.
    const namespaceForm = `import * as anything from './asset/${CLONE_REGISTRY_MODULE}';`;
    expect(new RegExp(`from\\s*['"][^'"]*${CLONE_REGISTRY_MODULE}['"]`).test(namespaceForm)).toBe(
      true,
    );
  });
});
