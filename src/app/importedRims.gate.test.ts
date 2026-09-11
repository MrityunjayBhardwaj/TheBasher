// importedRims.gate — an imported mesh's polygon rims, and the check that stands in for the
// alignment one it cannot have (#1025).
//
// ── WHAT THIS GATE IS FOR, AND WHY IT MOUNTS A REAL CLONE ────────────────────────────────
//
// Every function here reaches AMBIENT STATE on the way to its answer: a `gltf` ref is an
// address, and the geometry it addresses lives in `gltfCloneRegistry`, not in the descriptor.
// A probe that builds a well-typed ref and mounts nothing exercises each function with its
// input present and its world empty, and every null it reads is a statement about the fixture.
// That measurement error was published to two issues before it was caught, so every row below
// mounts a real clone and every table carries a `box` control — a kind that needs no clone, so
// a row that goes quiet tells you which of the two is at fault.
//
// ── THE CLAIM EACH GROUND PINS ───────────────────────────────────────────────────────────
//
//   1  the two roads are classified exhaustively, and the classification is exactly the escape
//      hatch `weldedPolygonsOf` / `faceCountOf` / `pointCountOf` already declare
//   2  a mounted, captured imported mesh recovers its rims, and they are the buffer's own walk
//      order — NOT rotated onto a synthesised substrate, because there is no substrate
//   3  the substrate kinds are untouched: they still align, and still refuse a disagreement
//   4  a captured face count that disagrees with the buffer REFUSES, in both directions — the
//      undercount is the one that matters, because on its own it answers, plausibly, with half
//      a mesh
//   5  the corner-domain consumer answers for an imported mesh, and its refusal names the
//      disagreement rather than borrowing "the buffers have not arrived"
//
// REF: src/app/builtRims.ts (`alignedSplitRims`, `topologyIsBufferOnly`);
//      src/app/uvAttributes.ts (`refusalFor`); src/app/asset/gltfCloneRegistry.ts;
//      issues #1025, #1023, #1024, #738.

import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { GeometryDescriptor, GeometryRef } from '../nodes/types';
import {
  bevelGeometryRef,
  boxGeometryRef,
  mirrorGeometryRef,
  sphereGeometryRef,
} from './modifierGeometry';
import { alignedSplitRims, builtPolygonRims, topologyIsBufferOnly } from './builtRims';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { captureChildFaceCount } from '../core/import/gltfImportChain';
import { firstMeshGeometry } from './firstMeshGeometry';
import { faceArityOf, faceElementStarts } from './faceCount';
import { weldedPolygonsOf } from './edgeIdentity';
import { getForRead, readGeometry } from './geometryRegistry';
import { readMeshUVs } from './uvAttributes';
import { __clearGltfCloneRegistryForTests, registerGltfClone } from './asset/gltfCloneRegistry';

const ASSET = 'u/imported-rims.gltf';
const CHILD = 'Cube';
/** A three.js box is 12 triangles, so an imported one is 12 triangular faces. */
const BOX_TRIANGLES = 12;

const box = boxGeometryRef([1, 1, 1], null);

function importedRef(faceCount: number | undefined, asset = ASSET): GeometryRef {
  const descriptor: GeometryDescriptor =
    faceCount === undefined
      ? { kind: 'gltf', assetRef: asset, childName: CHILD }
      : { kind: 'gltf', assetRef: asset, childName: CHILD, faceCount };
  return { key: `k|${JSON.stringify(descriptor)}`, descriptor };
}

/** Mount a real clone — a named child carrying a real buffer — and hand back its geometry. */
function mountClone(asset = ASSET): THREE.BufferGeometry {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  mesh.name = CHILD;
  const group = new THREE.Group();
  group.add(mesh);
  registerGltfClone(asset, group);
  return mesh.geometry;
}

afterEach(() => __clearGltfCloneRegistryForTests());

describe('#1025 — which road a descriptor takes', () => {
  it('1 — classified exhaustively, and the buffer-only set is the censused escape hatch', () => {
    // Typed as a Record over the kind union: a new kind that is not classified here is a
    // missing-property TYPE error rather than a silent default. `never` in the production
    // switch closes "did you decide?"; this closes "decided the same way twice?".
    const road: Record<GeometryDescriptor['kind'], 'substrate' | 'buffer-only'> = {
      box: 'substrate',
      sphere: 'substrate',
      array: 'substrate',
      mirror: 'substrate',
      subset: 'substrate',
      bevel: 'substrate',
      uvProject: 'substrate',
      gltf: 'buffer-only',
      baked: 'buffer-only',
    };
    const kinds = Object.keys(road) as GeometryDescriptor['kind'][];
    expect(kinds.length, 'every descriptor kind is classified').toBe(9);

    for (const kind of kinds)
      expect(
        topologyIsBufferOnly({ kind } as GeometryDescriptor),
        `${kind} — the road it takes through alignedSplitRims`,
      ).toBe(road[kind] === 'buffer-only');

    // The same two `weldedPolygonsOf`, `faceCountOf` and `pointCountOf` declare. Stated as an
    // equality rather than two lists, so the day one of them widens this reds instead of
    // drifting apart quietly.
    expect(kinds.filter((k) => road[k] === 'buffer-only')).toEqual(['gltf', 'baked']);

    // 🔴 AND IT IS NOT `polygonLayoutOf`'s `outside-the-descriptor` SET, which also holds
    // `bevel`. Pinned because reusing that verdict is the obvious shortcut and it would put a
    // bevel — whose welded rims ARE stated, and whose alignment check is real — on the road
    // that has no check at all.
    expect(topologyIsBufferOnly(bevelGeometryRef(box, 0.1).descriptor)).toBe(false);
  });
});

describe('#1025 — an imported mesh recovers its rims', () => {
  it('2 — mounted and captured, BOTH ARMS, with a box control', () => {
    const captured = importedRef(BOX_TRIANGLES);
    const uncaptured = importedRef(undefined);

    // ARM A — nothing mounted. Every imported row must be null, and that null is about the
    // registry rather than about the road, which is exactly why arm B exists.
    expect(readGeometry(captured).status, 'unmounted: the geometry is elsewhere').toBe('elsewhere');
    expect(getForRead(captured)).toBeNull();
    // The control answers with nothing mounted, which is what makes it a control.
    expect(alignedSplitRims(box, getForRead(box)!)).not.toBeNull();

    // ARM B — a real clone mounted.
    const buffer = mountClone();
    expect(readGeometry(captured).status, 'mounted: the geometry resolves').toBe('ok');
    expect(getForRead(captured), 'the ref resolves to the clone’s own buffer').toBe(buffer);

    const rims = alignedSplitRims(captured, buffer);
    expect(rims, 'a mounted, captured imported mesh answers').not.toBeNull();
    expect(rims!.length, 'one rim per imported face').toBe(BOX_TRIANGLES);
    expect(
      rims!.map((r) => r.length),
      'a glTF face is a triangle, so every rim has three corners',
    ).toEqual(new Array<number>(BOX_TRIANGLES).fill(3));

    // Still refused with no count captured — the arity is the precondition #1023 supplied, and
    // this road does not invent one.
    expect(faceArityOf(uncaptured.descriptor)).toBeNull();
    expect(alignedSplitRims(uncaptured, buffer)).toBeNull();
  });

  it('3 — the rims are the buffer’s own walk order, because there is no substrate to rotate onto', () => {
    // 🔴 THIS IS THE DECISION, PINNED. The reachable way onto the aligned road for this kind is
    // to synthesise `welded` as `weld.map[rim[k]]` — an array that IS a function of the walked
    // rim, so the rotation matches at offset 0 for every face by construction. That gate would
    // run, pass, and mean nothing. So no synthetic substrate is built and no rotation happens,
    // and this row is what would red if one were added: the answer is `builtPolygonRims`
    // verbatim, corner for corner.
    const buffer = mountClone();
    const ref = importedRef(BOX_TRIANGLES);
    const arity = faceArityOf(ref.descriptor)!;
    const walked = builtPolygonRims(buffer, arity, faceElementStarts(arity))!;
    expect(alignedSplitRims(ref, buffer)).toEqual(walked);

    // And the substrate side genuinely does rotate, so the row above is a real difference
    // between the two roads rather than a coincidence of this fixture.
    expect(weldedPolygonsOf(ref.descriptor), 'no substrate states an imported rim').toBeNull();
    expect(weldedPolygonsOf(box.descriptor), 'a box’s substrate does').not.toBeNull();
  });
});

describe('#1025 — the check that stands in for the alignment one', () => {
  // `sum(arity) x 3 === index.count`. Two REAL sources: the count was captured at import and
  // written into a save file, the buffer arrived from the asset that loaded just now.
  const rows = [
    { captured: BOX_TRIANGLES, expect: 'rims' },
    { captured: 6, expect: 'refuse' },
    { captured: 1, expect: 'refuse' },
    { captured: 24, expect: 'refuse' },
  ] as const;

  it('4 — a captured count that disagrees with the buffer refuses, in BOTH directions', () => {
    expect(rows.length, 'captured counts examined').toBe(4);
    for (const row of rows) {
      __clearGltfCloneRegistryForTests();
      // A fresh clone per row on purpose: `builtPolygonRims` caches on the GEOMETRY, so reusing
      // one buffer would serve row 1's rims to every row after it and the table would agree
      // with itself. Ground 5 is where that collision is measured deliberately.
      const buffer = mountClone();
      const ref = importedRef(row.captured);
      const rims = alignedSplitRims(ref, buffer);
      if (row.expect === 'rims') {
        expect(rims, `captured ${row.captured} — agrees with the buffer`).not.toBeNull();
        expect(rims!.length).toBe(BOX_TRIANGLES);
      } else {
        expect(
          rims,
          `captured ${row.captured} against a ${BOX_TRIANGLES}-triangle buffer must refuse. An ` +
            `undercount is the dangerous one: walked on its own it yields ${row.captured} ` +
            `well-formed rims and no complaint, so the rest of the mesh leaves the corner ` +
            `domain silently.`,
        ).toBeNull();
      }
    }
  });

  it('5 — two captured counts over ONE clone buffer do not serve each other’s rims', () => {
    // `rimCache` keys on the geometry alone, on the stated assumption that a built geometry
    // comes from exactly one descriptor. An asset clone's buffer does not: two nodes can name
    // one imported child with different captured counts. Measured — the second call receives
    // the first's rims. The agreement check is what makes the assumption true again, because
    // an imported arity is uniform, so only one count can pass it for a given buffer.
    const buffer = mountClone();
    const right = alignedSplitRims(importedRef(BOX_TRIANGLES), buffer);
    const wrong = alignedSplitRims(importedRef(6), buffer);
    expect(right!.length).toBe(BOX_TRIANGLES);
    expect(wrong, 'the disagreeing count is refused, not served the cached answer').toBeNull();
  });

  it('6 — baked stays refused, and it is the arity that refuses it', () => {
    // Not a road question: a `baked` descriptor carries a vertex count and no face count, so
    // there is no arity to walk a buffer against. It shares `gltf`'s road and reaches none of
    // it. This row is what reds the day a baked face count is captured without a decision.
    const baked: GeometryDescriptor = { kind: 'baked', hash: 'deadbeef', vertexCount: 24 };
    const ref: GeometryRef = { key: 'k|baked', descriptor: baked };
    expect(topologyIsBufferOnly(baked)).toBe(true);
    expect(faceArityOf(baked)).toBeNull();
    expect(alignedSplitRims(ref, mountClone())).toBeNull();
  });
});

describe('#1025 — the substrate kinds are untouched', () => {
  it('7 — every kind that answered before still answers, and is still ROTATED', () => {
    // 🔴 THE `rotates` COLUMN IS WHY THIS ROW DISCRIMINATES. Counting rims and comparing them
    // against `weldedPolygonsOf` passes whichever road a kind takes, so on its own this row
    // stays green even if every kind is misclassified as buffer-only — measured, when that
    // falsifier was run. What separates the roads is whether the rotation moves anything, and
    // for three of the four it moves a lot: a box's walk starts at a different corner from the
    // substrate on all 6 faces, a sphere on 32 of 48, a mirror on all 12.
    //
    // `bevel` is FALSE and is kept rather than dropped: its builder happens to lay each face
    // down starting where the layout does, so the rotation is an identity for it today. That is
    // a property of the builder, not a guarantee — asserting movement there would red on a
    // harmless change to it, and asserting the road is what this column is for.
    const substrate: readonly (readonly [string, GeometryRef, boolean])[] = [
      ['box', box, true],
      ['sphere', sphereGeometryRef(1, 8, 6, null), true],
      ['mirror', mirrorGeometryRef(box, 'x', 1), true],
      ['bevel', bevelGeometryRef(box, 0.1), false],
    ];
    expect(substrate.length, 'substrate kinds examined').toBe(4);
    for (const [name, ref, rotates] of substrate) {
      const geometry = getForRead(ref);
      expect(geometry, `${name} builds`).not.toBeNull();
      const rims = alignedSplitRims(ref, geometry!);
      expect(rims, `${name} still recovers its rims`).not.toBeNull();
      // The aligned road's own gate: one rim per welded rim, corner for corner.
      expect(rims!.length, `${name} — one rim per substrate rim`).toBe(
        weldedPolygonsOf(ref.descriptor)!.length,
      );

      const arity = faceArityOf(ref.descriptor)!;
      const walked = builtPolygonRims(geometry!, arity, faceElementStarts(arity))!;
      const moved = rims!.filter((rim, f) => rim.join() !== walked[f].join()).length;
      if (rotates)
        expect(
          moved,
          `${name} — the walk and the substrate disagree about where each rim starts, so the ` +
            `rotation must be doing work. Zero here means this kind has been routed onto the ` +
            `imported road, where nothing aligns it.`,
        ).toBeGreaterThan(0);
    }
  });
});

describe('#1025 — the corner-domain consumer', () => {
  it('8 — an imported mesh’s UVs read at the corner domain, with a box control', () => {
    const buffer = mountClone();
    const ref = importedRef(BOX_TRIANGLES);
    const read = readMeshUVs(ref);
    expect(read.status, 'the imported mesh reads').toBe('ok');

    const corners = alignedSplitRims(ref, buffer)!.reduce((n, rim) => n + rim.length, 0);
    expect(corners, 'twelve triangles is thirty-six corners').toBe(36);
    // The control, so a row that passes because both sides went quiet is visible.
    expect(readMeshUVs(box).status).toBe('ok');
  });

  it('9 — the refusal for a disagreement names it, instead of saying the buffers have not arrived', () => {
    const buffer = mountClone();
    const read = readMeshUVs(importedRef(6));
    expect(read.status, 'the geometry itself resolved fine').toBe('ok');
    expect(buffer.getIndex()!.count / 3).toBe(BOX_TRIANGLES);

    // 🔴 THE POINT OF THE ROW IS THE CONTENT. `polygonLayoutOf` would answer "its buffers live
    // in a loaded asset clone" — a description of a mesh that has not arrived, for one that
    // has. Acting on it means waiting for a load that already happened.
    const why = JSON.stringify(read);
    expect(why, 'the refusal states the disagreement').toMatch(/captured at import/);
    expect(why, 'and it does not borrow the not-yet-arrived reason').not.toMatch(
      /buffers live in a loaded asset clone/,
    );

    // 🔴 BOTH CAUSES, AND NEITHER INSTRUCTED. Ground 11 measures a real two-primitive child
    // that disagrees for a reason re-importing cannot fix, so a sentence naming only the stale
    // capture would be a wrong instruction for it. The site cannot tell the two apart, so it
    // states what it observed and leaves both roads open.
    expect(why, 'names the stale-capture road').toMatch(/asset changed since it was imported/);
    expect(why, 'names the multi-primitive road').toMatch(/several primitives/);
    expect(why, 'and it holds both numbers').toMatch(/6 faces \(6 triangles\).*holds 12/);
  });
});

describe('#1025 — measured against a real glTF parse, not a hand-built clone', () => {
  // 🔑 WHY A REAL PARSE EARNS ITS PLACE HERE. Every other ground mounts a clone this file
  // built, so all of them share one assumption: that a captured face count and the buffer a
  // child name reaches are the same mesh. `captureChildFaceCount` reads the glTF JSON and sums
  // EVERY primitive of the mesh; `firstMeshGeometry` returns the first `isMesh` descendant and
  // its own module records, in writing, that a multi-mesh child resolves to "whichever three
  // visits first" and that nothing had yet asked what that means. #1025 is what asks.
  //
  // So the agreement check had one way to be catastrophic — refusing ordinary imports — and
  // that is what row A rules out by observation rather than by argument.
  const QUAD_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

  function gltfJson(primitives: number) {
    const posBytes = new Uint8Array(QUAD_POSITIONS.buffer);
    const idxBytes = new Uint8Array(QUAD_INDICES.buffer);
    const all = new Uint8Array(posBytes.length + idxBytes.length);
    all.set(posBytes, 0);
    all.set(idxBytes, posBytes.length);
    const uri = `data:application/octet-stream;base64,${Buffer.from(all).toString('base64')}`;
    return {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, name: 'Panel' }],
      meshes: [
        {
          name: 'Panel',
          primitives: new Array(primitives).fill({
            attributes: { POSITION: 0 },
            indices: 1,
          }),
        },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 4,
          type: 'VEC3',
          min: [0, 0, 0],
          max: [1, 1, 0],
        },
        { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: posBytes.length, target: 34962 },
        { buffer: 0, byteOffset: posBytes.length, byteLength: idxBytes.length, target: 34963 },
      ],
      buffers: [{ byteLength: all.length, uri }],
    };
  }

  async function parsed(primitives: number) {
    const json = gltfJson(primitives);
    const gltf = await new GLTFLoader().parseAsync(JSON.stringify(json), '');
    const child = gltf.scene.getObjectByName('Panel');
    return {
      captured: captureChildFaceCount(json.nodes[0], json as never),
      child,
      reached: firstMeshGeometry(child),
    };
  }

  it('10 — a single-primitive child AGREES, so an ordinary import is not refused', async () => {
    const { captured, child, reached } = await parsed(1);
    expect(child?.type, 'one primitive loads as a Mesh').toBe('Mesh');
    expect(captured, 'a quad is two triangles').toBe(2);
    expect(reached!.getIndex()!.count / 3, 'and the buffer holds two').toBe(2);

    // The whole point: the check the other grounds exercise passes on a real import.
    const ref: GeometryRef = {
      key: 'k|real-1',
      descriptor: {
        kind: 'gltf',
        assetRef: 'u/real.gltf',
        childName: 'Panel',
        faceCount: captured,
      },
    };
    const rims = alignedSplitRims(ref, reached!);
    expect(rims, 'a real single-primitive import recovers its rims').not.toBeNull();
    expect(rims!.length).toBe(2);
  });

  it('11 — a two-primitive child DISAGREES, and refusing is the right answer', async () => {
    const { captured, child, reached } = await parsed(2);
    expect(child?.type, 'two primitives load as a Group').toBe('Group');
    expect(captured, 'the capture sums BOTH primitives').toBe(4);
    expect(reached!.getIndex()!.count / 3, 'the child name reaches only the FIRST').toBe(2);

    const ref: GeometryRef = {
      key: 'k|real-2',
      descriptor: {
        kind: 'gltf',
        assetRef: 'u/real.gltf',
        childName: 'Panel',
        faceCount: captured,
      },
    };
    expect(
      alignedSplitRims(ref, reached!),
      'walking a 4-face arity over a 2-triangle buffer would answer, wrongly — refusing is correct',
    ).toBeNull();

    // The REASON this produces is ground 9's — one sentence serves both causes, because from
    // the refusal site the descriptor and the buffer are all there is and they cannot tell a
    // stale capture from a multi-primitive child. What matters here is that it refuses at all.
  });
});
