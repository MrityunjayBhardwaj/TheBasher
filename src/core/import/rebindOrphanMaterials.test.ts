// #221 — bounded producer-side repair: bind unbound mesh primitives to the
// document's single orphaned material (the 3dripper-export bug), only when the
// mapping is unambiguous.
import { describe, it, expect } from 'vitest';
import type { GltfDoc } from './specGlossToMetalRough';
import { rebindOrphanMaterials, rebindOrphanMaterialsInEntry } from './rebindOrphanMaterials';
import { parseGlb, repackGlb } from './glb';

function doc(over: Partial<GltfDoc>): GltfDoc {
  return { ...over } as GltfDoc;
}

describe('rebindOrphanMaterials', () => {
  it('binds an unbound primitive to the single orphaned material (the horse case)', () => {
    const d = doc({
      materials: [{ name: 'M_Horse' }],
      meshes: [{ primitives: [{ attributes: {} }] }], // no `material`
    });
    const { doc: out, rebinds } = rebindOrphanMaterials(d);
    expect(rebinds).toEqual([{ materialIndex: 0, materialName: 'M_Horse', primitiveCount: 1 }]);
    expect(
      (out.meshes as { primitives: { material?: number }[] }[])[0].primitives[0].material,
    ).toBe(0);
    // Pure — the input is not mutated.
    expect(
      (d.meshes as { primitives: { material?: number }[] }[])[0].primitives[0].material,
    ).toBeUndefined();
  });

  it('binds MULTIPLE unbound primitives across meshes to the one orphan', () => {
    const d = doc({
      materials: [{ name: 'Solo' }],
      meshes: [{ primitives: [{}, {}] }, { primitives: [{}] }],
    });
    const { doc: out, rebinds } = rebindOrphanMaterials(d);
    expect(rebinds[0].primitiveCount).toBe(3);
    const meshes = out.meshes as { primitives: { material?: number }[] }[];
    expect(meshes.flatMap((m) => m.primitives.map((p) => p.material))).toEqual([0, 0, 0]);
  });

  it('leaves a correctly-bound document verbatim (no orphan)', () => {
    const d = doc({
      materials: [{ name: 'A' }],
      meshes: [{ primitives: [{ material: 0 }] }],
    });
    const { doc: out, rebinds } = rebindOrphanMaterials(d);
    expect(rebinds).toEqual([]);
    expect(out).toBe(d); // verbatim (same reference)
  });

  it('does NOT rebind when an unbound primitive coexists with a referenced material', () => {
    // material 0 IS used (by prim 0); prim 1 is intentionally default → not an orphan.
    const d = doc({
      materials: [{ name: 'A' }],
      meshes: [{ primitives: [{ material: 0 }, {}] }],
    });
    const { rebinds } = rebindOrphanMaterials(d);
    expect(rebinds).toEqual([]);
  });

  it('does NOT rebind when more than one material is orphaned (ambiguous)', () => {
    const d = doc({
      materials: [{ name: 'A' }, { name: 'B' }],
      meshes: [{ primitives: [{}] }],
    });
    const { rebinds } = rebindOrphanMaterials(d);
    expect(rebinds).toEqual([]);
  });

  it('binds to the one orphan even when other materials are referenced', () => {
    // mats 0 & 1 used, mat 2 orphaned; one unbound prim → bind it to 2.
    const d = doc({
      materials: [{ name: 'A' }, { name: 'B' }, { name: 'Orphan' }],
      meshes: [{ primitives: [{ material: 0 }, { material: 1 }, {}] }],
    });
    const { doc: out, rebinds } = rebindOrphanMaterials(d);
    expect(rebinds).toEqual([{ materialIndex: 2, materialName: 'Orphan', primitiveCount: 1 }]);
    const prims = (out.meshes as { primitives: { material?: number }[] }[])[0].primitives;
    expect(prims.map((p) => p.material)).toEqual([0, 1, 2]);
  });

  it('no-ops a document with no materials or no meshes', () => {
    expect(rebindOrphanMaterials(doc({ meshes: [{ primitives: [{}] }] })).rebinds).toEqual([]);
    expect(rebindOrphanMaterials(doc({ materials: [{ name: 'A' }] })).rebinds).toEqual([]);
  });
});

describe('rebindOrphanMaterialsInEntry', () => {
  const horseGltf = JSON.stringify({
    asset: { version: '2.0' },
    materials: [{ name: 'M_Horse' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  });

  it('rewrites a .gltf entry, binding the unbound primitive', () => {
    const bytes = new TextEncoder().encode(horseGltf);
    const { entryBytes, rebinds } = rebindOrphanMaterialsInEntry('horse.gltf', bytes);
    expect(rebinds[0].materialName).toBe('M_Horse');
    const out = JSON.parse(new TextDecoder().decode(entryBytes));
    expect(out.meshes[0].primitives[0].material).toBe(0);
  });

  it('repacks a .glb entry (BIN preserved), binding the unbound primitive', () => {
    const bin = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const glb = repackGlb({
      json: {
        asset: { version: '2.0' },
        materials: [{ name: 'M_Horse' }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      },
      bin,
    });
    const { entryBytes, rebinds } = rebindOrphanMaterialsInEntry('horse.glb', glb);
    expect(rebinds[0].primitiveCount).toBe(1);
    const reparsed = parseGlb(entryBytes.buffer.slice(0) as ArrayBuffer);
    expect(
      (reparsed.json.meshes as { primitives: { material?: number }[] }[])[0].primitives[0].material,
    ).toBe(0);
    expect(Array.from(reparsed.bin.subarray(0, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('returns bytes verbatim when nothing to rebind, or unknown extension', () => {
    const ok = new TextEncoder().encode(
      JSON.stringify({ materials: [{ name: 'A' }], meshes: [{ primitives: [{ material: 0 }] }] }),
    );
    expect(rebindOrphanMaterialsInEntry('ok.gltf', ok).rebinds).toEqual([]);
    expect(rebindOrphanMaterialsInEntry('ok.gltf', ok).entryBytes).toBe(ok);
    const junk = new Uint8Array([0, 1, 2]);
    expect(rebindOrphanMaterialsInEntry('x.bin', junk).entryBytes).toBe(junk);
    const badJson = new TextEncoder().encode('not json');
    expect(rebindOrphanMaterialsInEntry('bad.gltf', badJson).rebinds).toEqual([]);
  });
});
