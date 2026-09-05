// One rig, two name spaces — the boundary that reads as a broken map (#922).
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────────────────
// The same bone answers to two different strings depending on who is asked:
//
//   live three.js scene   `mixamorigHips`    (GLTFLoader sanitises every node
//                                             name on load — GLTFLoader.js:3655
//                                             calls PropertyBinding.sanitizeNodeName,
//                                             which REMOVES `[].:/`)
//   our asset params      `mixamorig_Hips`   (`sanitizeBoneName` REPLACES the
//                                             same characters with `_`)
//
// Neither is wrong. Nothing in the product compares them — the retarget resolves
// through asset params on both the read side and the render side — so the two
// spellings never have to agree, and no user-visible behaviour depends on this.
//
// The cost is borne entirely by INSTRUMENTS. A probe that narrows "rows whose
// target the live skin also carries" matches nothing, which reads exactly like a
// broken bone map rather than like two spellings of a healthy one. That has cost
// a debugging cycle once already, while writing the #921 observation (#922).
//
// A comment saying so already existed in three places and did not prevent either
// cycle — so this is a test instead. It reds if either sanitiser's rule moves, if
// the two ever silently converge, or if `canonicalBoneKey` stops reconciling them.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT IS AND IS NOT REPAIRABLE
// ─────────────────────────────────────────────────────────────────────────
// There is no function from our spelling to three's. `:` → `_` and `:` → `` are
// two different lossy maps and neither composes into the other, and ours is not
// even injective: `mixamorig:Hips` and `mixamorig_Hips` both become
// `mixamorig_Hips`, so the information a bridge would need is destroyed at
// import. Sharing one sanitiser would be a stored-name format migration.
//
// So names are not the key across this boundary. Two things are:
//   - the JOINT INDEX, which both sides already agree on by construction
//     (`projectGltfSkeleton.ts` INDEX DISCIPLINE — bone i == skin.joints[] i ==
//     render skeleton i), and
//   - `canonicalBoneKey` (`retarget.ts`), which already collapses separators and
//     case for exactly this reason on the FBX-vs-glTF road, and reconciles this
//     pair too — measured below at 23/23 on the tracked rig where direct
//     comparison gets 1/23.
//
// REF: node_modules/three/src/animation/PropertyBinding.js:144 (three's rule);
//      node_modules/three/examples/jsm/loaders/GLTFLoader.js:3655 (where it runs);
//      src/core/import/threeAdapter.ts (ours); src/core/import/retarget.ts
//      (canonicalBoneKey); src/viewport/SceneFromDAG.tsx (the `boneName` seam);
//      issues #922, #921.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PropertyBinding } from 'three';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { sanitizeBoneName } from './threeAdapter';
import { canonicalBoneKey } from './retarget';
import type { GltfSkinMetadata } from '../../nodes/types';

const RIG = resolve(process.cwd(), 'public/fixtures/rig/standin-character.glb');

/** The name three.js will carry in the live scene for a given raw glTF node
 *  name. Delegated to three's own function rather than reimplemented, so this
 *  gate cannot drift from the library it is a claim about. */
const threeSceneName = (raw: string): string => PropertyBinding.sanitizeNodeName(raw);

describe('the two bone-name spaces (#922)', () => {
  it("our sanitiser and three's disagree on the canonical Mixamo bone", () => {
    expect(sanitizeBoneName('mixamorig:Hips')).toBe('mixamorig_Hips');
    expect(threeSceneName('mixamorig:Hips')).toBe('mixamorigHips');
    expect(sanitizeBoneName('mixamorig:Hips')).not.toBe(threeSceneName('mixamorig:Hips'));
  });

  it('neither sanitiser composes into the other, so no bridge function exists', () => {
    const raw = 'mixamorig:Hips';
    // Running three's rule over OUR output does not recover three's output —
    // the `_` we substituted is not a reserved character, so it survives.
    expect(threeSceneName(sanitizeBoneName(raw))).not.toBe(threeSceneName(raw));
    expect(threeSceneName(sanitizeBoneName(raw))).toBe('mixamorig_Hips');
  });

  it('our sanitiser is not injective, so the lost separator is unrecoverable', () => {
    // A rig may legitimately ship a bone already named with an underscore. After
    // import the two are the same string, and nothing downstream can tell which
    // file it came from — which is why the repair is a migration, not a function.
    expect(sanitizeBoneName('mixamorig:Hips')).toBe(sanitizeBoneName('mixamorig_Hips'));
  });

  it('the divergence is not only the colon — whitespace goes the OTHER way', () => {
    // three replaces whitespace with `_`; ours passes it through untouched. So a
    // bone named with a space diverges in the opposite direction to a namespaced
    // one, and any hand-written "just swap _ for :" repair is wrong for it.
    expect(threeSceneName('arm L')).toBe('arm_L');
    expect(sanitizeBoneName('arm L')).toBe('arm L');
    expect(sanitizeBoneName('a.b')).toBe('a_b');
    expect(threeSceneName('a.b')).toBe('ab');
  });

  it('canonicalBoneKey reconciles the two spellings', () => {
    for (const raw of ['mixamorig:Hips', 'a.b', 'arm L', 'Root']) {
      expect(canonicalBoneKey(sanitizeBoneName(raw))).toBe(canonicalBoneKey(threeSceneName(raw)));
    }
  });

  describe('on the tracked stand-in rig', () => {
    it('direct comparison finds almost nothing; the canonical key finds everything', async () => {
      const buf = readFileSync(RIG);
      const { json, bin } = parseGltfContainer(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      );
      const buffers = await resolveBuffers(json, bin);
      const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'standin');
      const [skinMeta] = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
      const ours = projectGltfSkeleton(skinMeta as unknown as GltfSkinMetadata).bones.map(
        (b) => b.name,
      );
      // The live scene's spelling, derived from the same asset by three's rule.
      const nodes = (json as { nodes?: { name?: string }[] }).nodes ?? [];
      const joints = (json as { skins?: { joints: number[] }[] }).skins![0].joints;
      const live = joints.map((n) => threeSceneName(nodes[n]?.name ?? ''));

      expect(live).toHaveLength(ours.length);
      expect(ours.length).toBeGreaterThan(20);

      // A bone matches directly ONLY if its raw name had nothing to sanitise.
      // Derived from the asset, not hardcoded, so the claim survives a re-export.
      const clean = joints.filter((n) => !/[[\].:/\s]/.test(nodes[n]?.name ?? '')).length;
      const direct = ours.filter((n, i) => n === live[i]).length;
      expect(direct).toBe(clean);
      expect(direct).toBeLessThan(ours.length); // the whole point: it is NOT a match

      // Every bone reconciles through the canonical key...
      const viaCanonical = ours.filter(
        (n, i) => canonicalBoneKey(n) === canonicalBoneKey(live[i]),
      ).length;
      expect(viaCanonical).toBe(ours.length);

      // ...and the key stays unique on both sides, so it is safe to index by.
      // A rig whose bones differ only by separator or case would break this, and
      // the failure would be a wrong bone rather than a missing one.
      expect(new Set(ours.map(canonicalBoneKey)).size).toBe(ours.length);
      expect(new Set(live.map(canonicalBoneKey)).size).toBe(live.length);
    });
  });
});
