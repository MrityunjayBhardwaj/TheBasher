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
import type { GeometryDescriptor, GeometryRef, ObjectData } from '../nodes/types';
import {
  arrayGeometryRef,
  bevelGeometryRef,
  boxGeometryRef,
  mirrorGeometryRef,
  sphereGeometryRef,
} from './modifierGeometry';
import { alignedSplitRims, builtPolygonRims, topologyIsBufferOnly } from './builtRims';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { captureChildFaceCount } from '../core/import/gltfImportChain';
import { firstMeshGeometry } from './firstMeshGeometry';
import { faceArityOf, faceElementStarts, faceCountOf } from './faceCount';
import { edgeCountOf, weldedPolygonsOf } from './edgeIdentity';
import { bevelLayoutOf } from './bevelLayout';
import {
  ANGLE_LIMIT_PARAM,
  LIMIT_METHOD_PARAM,
  resolveComponentSelection,
  SCOPE_PARAM,
} from '../nodes/componentSelection';
import { weldByPosition } from './pointIdentity';
import { getForRead, prime, readGeometry } from './geometryRegistry';
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

  it('6b — and a baked mesh keeps its OWN reason, which is not an imported one', () => {
    // 🔴 THE NEGATIVE CONTROL FOR THE REFUSAL SENTENCES. `baked` shares the buffer-only road
    // and none of the imported vocabulary: it was authored here, not imported, so there is no
    // import to redo and no captured count to be stale. The first draft of the refusal block
    // did not separate them and told a baked mesh it had been "imported before its face count
    // was captured". Pinned here because this file's code is what can break it again.
    const baked: GeometryDescriptor = { kind: 'baked', hash: 'cafebabe', vertexCount: 3 };
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));
    prime({ key: 'k|baked-own-reason', descriptor: baked }, geometry);

    const read = readMeshUVs({ key: 'k|baked-own-reason', descriptor: baked }) as {
      status: string;
      attribute?: { why?: string };
    };
    if (read.status !== 'ok') return;
    const why = read.attribute?.why ?? '';
    expect(why, 'a baked mesh names OPFS, its own reason').toMatch(/OPFS/);
    expect(why, 'and never the imported vocabulary').not.toMatch(/imported/);
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

describe('#1025 — every way an imported mesh can refuse says which way it was', () => {
  // 🔑 THE SELF-REVIEW ROW, AND IT FOUND TWO. `refusalFor` reaches `polygonLayoutOf` for
  // anything its first arm does not claim, and that sentence — *"a 'gltf' descriptor's buffers
  // live in a loaded asset clone"* — describes a mesh that has not arrived. Every case below
  // holds a buffer that HAS arrived, so borrowing it would tell the reader to wait for a load
  // that already happened. A wrong diagnosis is an instruction, so each arm says its own thing.
  function whyFor(ref: GeometryRef): string {
    const read = readMeshUVs(ref) as { status: string; attribute?: { why?: string } };
    expect(
      read.status,
      'the geometry itself resolved — this is about the reason, not the read',
    ).toBe('ok');
    return read.attribute?.why ?? '';
  }

  const NOT_ARRIVED = /buffers live in a loaded asset clone/;

  it('12 — no face count captured: it names the missing readout, not missing bytes', () => {
    mountClone();
    const why = whyFor(importedRef(undefined));
    expect(why).toMatch(/before its face count was captured/);
    expect(why, 'the bytes are here; it must not say otherwise').not.toMatch(NOT_ARRIVED);
  });

  it('13 — a NON-INDEXED import recovers its rims by closed form (#1028)', () => {
    // A glTF primitive may legally carry no `indices`, and the importer still captures a count
    // for it from the POSITION accessor — so this arrives with everything present and nothing
    // to walk. #1025 named that absence; #1028 answered it. In a split buffer every corner is
    // already its own vertex, so face `f` IS `[3f, 3f+1, 3f+2]` — positional, not derived.
    __clearGltfCloneRegistryForTests();
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1).toNonIndexed(),
      new THREE.MeshBasicMaterial(),
    );
    mesh.name = CHILD;
    const group = new THREE.Group();
    group.add(mesh);
    registerGltfClone(ASSET, group);

    const ref = importedRef(BOX_TRIANGLES);
    const buffer = getForRead(ref)!;
    expect(buffer.getIndex(), 'the fixture really is non-indexed').toBeNull();
    expect(buffer.getAttribute('position').count, 'and its corners are already split').toBe(36);

    const rims = alignedSplitRims(ref, buffer);
    expect(rims, 'a non-indexed import answers').not.toBeNull();
    expect(rims!.length).toBe(BOX_TRIANGLES);
    // Pinned as VALUES, not just a count: the closed form is the whole claim here, and a walk
    // that happened to return the right number of rims would pass a count-only check.
    expect(rims!.slice(0, 3)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
    ]);
    expect(rims![BOX_TRIANGLES - 1]).toEqual([33, 34, 35]);
    expect(whyFor(ref), 'and it no longer refuses at all').toBe('');
  });

  it('13b — a non-indexed buffer whose POSITIONS disagree with the captured count refuses', () => {
    // The same cross-source check the indexed road makes, against `position` instead of the
    // index: the count was captured at import, the buffer arrived from the asset just now.
    __clearGltfCloneRegistryForTests();
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1).toNonIndexed(),
      new THREE.MeshBasicMaterial(),
    );
    mesh.name = CHILD;
    const group = new THREE.Group();
    group.add(mesh);
    registerGltfClone(ASSET, group);

    const ref = importedRef(6); // 6 faces claimed, 12 triangles of positions present
    expect(
      alignedSplitRims(ref, getForRead(ref)!),
      'six faces against thirty-six split positions must refuse, not answer with half',
    ).toBeNull();
    const why = whyFor(ref);
    expect(why).toMatch(/6 faces \(6 triangles\).*holds 12/);
    expect(why, 'the bytes are here; it must not say otherwise').not.toMatch(NOT_ARRIVED);
  });

  it('13c — the multi-triangle guard is UNREACHABLE today, and this is what makes it reachable', () => {
    // 🔴 A GUARD NOTHING CAN MINT THE STATE FOR. In a split buffer two triangles of one face
    // share no vertex, so such a face has a boundary in two disjoint pieces and no rim. The
    // closed form therefore refuses any face of more than one triangle — and no imported mesh
    // can currently BE that, because `faceArityOf`'s imported arm returns a uniform array of
    // ones. The guard is not dead; it is un-minted.
    //
    // So this row pins the PRECONDITION rather than the guard. The day a kind on the
    // buffer-only road states a face of two triangles, this reds and names the guard that is
    // then live — instead of the guard silently becoming reachable with nothing exercising it.
    for (const faceCount of [1, 12, 100]) {
      const arity = faceArityOf({
        kind: 'gltf',
        assetRef: ASSET,
        childName: CHILD,
        faceCount,
      })!;
      expect(arity.length, `faceCount ${faceCount} yields one entry per face`).toBe(faceCount);
      expect(
        arity.filter((n) => n !== 1).length,
        `An imported face is no longer always ONE triangle. The split-buffer closed form in ` +
          `builtRims refuses such a face on purpose — check that its refusal is now reachable ` +
          `and gated, because nothing has exercised it until now.`,
      ).toBe(0);
    }
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

// ── #1042 — THE REGISTRY'S OWNERSHIP RULE, PINNED AS IT NOW BEHAVES ──────────────────────
//
// `geometryRegistry.ts`'s #630 ownership block said a `gltf` ref resolves to `null` ALWAYS, and
// that stopped being true at #367 when `get` gained its clone delegation, leaving the sentence
// contradicting the code forty lines below it.
//
// ⚠️ AND THE HONEST VERSION IS NOT "NOTHING TESTED THIS" — MEASURED, SIX GROUNDS ALREADY DID.
// Breaking the delegation (`get`'s glTF arm returned to `null`) reds grounds 2, 8, 9, 12, 13 and
// 13b along with the one below, because every one of them reaches a mounted buffer on its way to
// what it actually asserts. So the behaviour was covered INCIDENTALLY and the rule was nowhere
// NAMED, which is the gap that let a false sentence survive in the file that owns it: a ground
// that reds for a downstream reason tells a reader their rims broke, never that the ownership
// rule moved. What is added here is the name, not the coverage.
//
// The reason this is worth a gate and not just a corrected comment: the false sentence is
// load-bearing on DESIGN. A reader deciding how an imported mesh should get buffer-scale data
// reads "ALWAYS null / LOOK ELSEWHERE" and concludes the descriptor must carry it — which is
// the conclusion #1025 closed against, and which the #1041 census nearly re-derived from this
// sentence before measuring. So what is pinned here is the MOUNTED direction, because that is
// the half that went false; the unmounted half is asserted beside it so a green cannot come
// from a harness that mounted nothing.
describe('#1042 — a mounted glTF ref resolves through the registry', () => {
  it('14 — MOUNTED resolves and UNMOUNTED refuses, with a box control', () => {
    // UNMOUNTED first, deliberately: it is measured on the same ref shape BEFORE any clone
    // exists, so the pair below differs in exactly one thing — whether a clone is mounted.
    const ref = importedRef(BOX_TRIANGLES);
    expect(getForRead(ref)).toBeNull();
    expect(readGeometry(ref)).toMatchObject({ status: 'elsewhere' });

    const mounted = mountClone();
    const resolved = getForRead(ref);
    // The datum that falsifies "ALWAYS null". Identity, not merely non-null: the registry is
    // meant to hand back the CLONE'S buffer, and a fresh instance carrying the same vertex
    // count would satisfy a count-only assertion while meaning something else entirely.
    expect(resolved).toBe(mounted);
    expect(readGeometry(ref)).toMatchObject({ status: 'ok' });

    // The control — a kind that needs no clone at all, so a row going quiet says which of the
    // two is at fault rather than leaving the whole table ambiguous.
    expect(getForRead(box)).not.toBeNull();
  });
});

// ── #1041 — A DERIVED KIND OVER AN IMPORT REACHES THE IMPORT'S BUFFER ────────────────────
//
// The rim-consumer census for #1041 found no consumer that is descriptor-only by necessity: each
// holds a `GeometryRef` or is one field from one, because every derived descriptor carries
// `source: GeometryRef`. So the welded-rim door takes an OPTIONAL ref, and the derived arms pass
// their own `source` down — which is what lets an array over an import answer with its call site
// untouched.
//
// Every row mounts a real clone and carries a box control, and the point count is taken from
// production's weld over a SEPARATE BoxGeometry instance, so the fixture cannot hand the subject
// and the expectation the same object.
describe('#1041 — the welded-rim door reaches an imported mesh through the ref it holds', () => {
  const CAPTURED_POINTS = weldByPosition(new THREE.BoxGeometry(1, 1, 1)).points;

  function capturedRef(asset: string): GeometryRef {
    const descriptor: GeometryDescriptor = {
      kind: 'gltf',
      assetRef: asset,
      childName: CHILD,
      faceCount: BOX_TRIANGLES,
      pointCount: CAPTURED_POINTS,
    };
    return { key: `k|${JSON.stringify(descriptor)}`, descriptor };
  }

  it('15 — top level: a ref over a MOUNTED clone answers; no ref, or no clone, refuses', () => {
    const asset = 'u/1041-top.gltf';
    const ref = capturedRef(asset);
    expect(weldedPolygonsOf(ref)).toBeNull();

    mountClone(asset);
    // Without a ref the door is exactly what it was: a descriptor alone cannot reach a buffer.
    expect(weldedPolygonsOf(ref.descriptor)).toBeNull();
    const rims = weldedPolygonsOf(ref);
    expect(rims?.length).toBe(BOX_TRIANGLES);
    expect(new Set(rims?.flat()).size).toBe(CAPTURED_POINTS);

    expect(weldedPolygonsOf(box.descriptor)?.length).toBe(6);
  });

  it('16 — an array over an import supplies the ref itself, and its edge count agrees with Euler', () => {
    const asset = 'u/1041-array.gltf';
    mountClone(asset);
    const arr = arrayGeometryRef(capturedRef(asset), 3, [2, 0, 0]);

    expect(weldedPolygonsOf(arr.descriptor)?.length).toBe(3 * BOX_TRIANGLES);
    // Three disjoint closed copies: E = F + V - 2 per copy. A count derived from the rims and a
    // count derived from Euler are two routes, so agreement is not the rims agreeing with
    // themselves.
    expect(edgeCountOf(arr.descriptor)).toEqual({
      kind: 'counted',
      count: 3 * (BOX_TRIANGLES + CAPTURED_POINTS - 2),
    });

    expect(edgeCountOf(arrayGeometryRef(box, 3, [2, 0, 0]).descriptor)).toEqual({
      kind: 'counted',
      count: 36,
    });
  });

  it('17 — a cached bevel verdict follows the mount in BOTH directions', () => {
    // The defect this pins: `bevelLayoutOf` caches refusals, and once a source rooted at an import
    // could answer, a refusal cached before the mount was served after it. Asked mount-first, the
    // same bevel laid out — so the only difference was the order, which is the cache.
    const asset = 'u/1041-bevel.gltf';
    const bev = bevelGeometryRef(arrayGeometryRef(capturedRef(asset), 3, [2, 0, 0]), 0.05);
    const control = bevelGeometryRef(arrayGeometryRef(box, 3, [2, 0, 0]), 0.05);

    expect(bevelLayoutOf(bev.descriptor).kind).toBe('refused');
    mountClone(asset);
    expect(bevelLayoutOf(bev.descriptor).kind).toBe('laid-out');
    __clearGltfCloneRegistryForTests();
    expect(bevelLayoutOf(bev.descriptor).kind).toBe('refused');

    expect(bevelLayoutOf(control.descriptor).kind).toBe('laid-out');
  });

  it('18 — a captured point count that disagrees with the buffer refuses, in BOTH directions (#1044)', () => {
    // Measured before the check existed: 4 against a buffer welding to 8 gave an array over the
    // import `counted 44` edges where the mesh has 54. Every row here was a plausible answer.
    function refWith(asset: string, faceCount: number, pointCount: number): GeometryRef {
      const descriptor: GeometryDescriptor = {
        kind: 'gltf',
        assetRef: asset,
        childName: CHILD,
        faceCount,
        pointCount,
      };
      return { key: `k|${JSON.stringify(descriptor)}`, descriptor };
    }
    const disagreeing = [CAPTURED_POINTS + 1, CAPTURED_POINTS - 1, 4];
    for (const pointCount of disagreeing) {
      const asset = `u/1044-${pointCount}.gltf`;
      mountClone(asset);
      const ref = refWith(asset, BOX_TRIANGLES, pointCount);
      expect(weldedPolygonsOf(ref), `captured ${pointCount}`).toBeNull();
      expect(
        edgeCountOf(arrayGeometryRef(ref, 3, [2, 0, 0]).descriptor).kind,
        `captured ${pointCount}`,
      ).not.toBe('counted');
    }
    // The row that must NOT move, so a check refusing everything cannot pass.
    mountClone('u/1044-agree.gltf');
    const agreeing = refWith('u/1044-agree.gltf', BOX_TRIANGLES, CAPTURED_POINTS);
    expect(edgeCountOf(arrayGeometryRef(agreeing, 3, [2, 0, 0]).descriptor)).toEqual({
      kind: 'counted',
      count: 3 * (BOX_TRIANGLES + CAPTURED_POINTS - 2),
    });
    // The face-count twin still refuses, so the two halves are checked side by side.
    mountClone('u/1044-faces.gltf');
    expect(weldedPolygonsOf(refWith('u/1044-faces.gltf', 6, CAPTURED_POINTS))).toBeNull();
  });

  it('19 — a descriptor cannot be paired with another mesh’s ref', () => {
    // Measured on the first shape, `(descriptor, ref?)`: a box descriptor handed a sphere's ref
    // returned the sphere's 80 rims under the box's name.
    mountClone('u/1041-pair-A.gltf');
    const a = capturedRef('u/1041-pair-A.gltf');

    const sphere = new THREE.SphereGeometry(1, 8, 6);
    const mesh = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial());
    mesh.name = CHILD;
    const group = new THREE.Group();
    group.add(mesh);
    registerGltfClone('u/1041-pair-B.gltf', group);
    const bDescriptor: GeometryDescriptor = {
      kind: 'gltf',
      assetRef: 'u/1041-pair-B.gltf',
      childName: CHILD,
      faceCount: (sphere.getIndex()?.count ?? 0) / 3,
      pointCount: weldByPosition(new THREE.SphereGeometry(1, 8, 6)).points,
    };
    const b: GeometryRef = { key: `k|${JSON.stringify(bDescriptor)}`, descriptor: bDescriptor };

    // Each ref answers with its OWN mesh — there is no second argument to disagree with it.
    expect(weldedPolygonsOf(a)?.length).toBe(BOX_TRIANGLES);
    expect(weldedPolygonsOf(b)?.length).toBe(bDescriptor.faceCount);

    // The type pin: if the loose `(descriptor, ref?)` shape comes back, this directive is unused
    // and the test-file typecheck reds. At runtime the extra argument is ignored, so a bare
    // descriptor still cannot reach a buffer — the mismatch leaks nothing either way.
    // @ts-expect-error — a descriptor and a ref for a different mesh cannot be passed together
    expect(weldedPolygonsOf(a.descriptor, b)).toBeNull();
  });
});

// ── #1046 — THE SELECTION RESOLVER ASKS WITH THE REF IT HOLDS ─────────────────────────────
//
// Before this, `resolveComponentSelection` asked an import's edge count with a DESCRIPTOR, which
// cannot reach a buffer. So once a bevel over an import could build, two things went wrong
// silently: an angle limit resolved to the WHOLE mesh (an imported box's six flat triangulation
// diagonals got bevelled), and an authored edge scope threw on the render walk.
//
// ⚠️ WHAT THIS DOES NOT PIN, ON PURPOSE. Over an UNMOUNTED import, what a selection should BE is
// still open on #1046 — a "not arrived yet" answer given before the mount may stick, because the
// clone registry notifies nothing when a clone mounts. #862 set the precedent that a not-yet state
// resolves EMPTY ("chamfer nothing"), never WHOLE and never a throw; today an angle limit there
// resolves whole and an authored scope throws. Pinning either value would lock in a direction the
// precedent rules out, so only the safety property every design must keep is asserted: unscoped
// and angle-limited resolution does not throw.
describe('#1046 — a bevel’s edge selection over an import is resolved against its buffer', () => {
  function spine(geometry: GeometryRef): ObjectData {
    return { kind: 'MeshData', geometry, material: null } as unknown as ObjectData;
  }
  function capturedAt(asset: string): GeometryRef {
    const descriptor: GeometryDescriptor = {
      kind: 'gltf',
      assetRef: asset,
      childName: CHILD,
      faceCount: BOX_TRIANGLES,
      pointCount: weldByPosition(new THREE.BoxGeometry(1, 1, 1)).points,
    };
    return { key: `k|${JSON.stringify(descriptor)}`, descriptor };
  }
  const angle = (deg: number) => ({ [LIMIT_METHOD_PARAM]: 'angle', [ANGLE_LIMIT_PARAM]: deg });

  it('20 — an angle limit selects the non-flat edges, and the bevel changes because of it', () => {
    const asset = 'u/1046-angle.gltf';
    mountClone(asset);
    const imported = capturedAt(asset);

    const selection = resolveComponentSelection(spine(imported), angle(30), 'edge');
    // An imported box is the procedural box's 12 edges plus 6 flat diagonals. The expected count
    // comes from the PROCEDURAL box — a different topology — so it is not the import agreeing
    // with itself.
    const realEdges = edgeCountOf(box.descriptor);
    const allEdges = edgeCountOf(imported);
    expect(realEdges).toEqual({ kind: 'counted', count: 12 });
    expect(allEdges).toEqual({ kind: 'counted', count: 18 });
    expect(selection?.length).toBe(18);
    expect(selection?.count).toBe(12);

    const limited = bevelGeometryRef(imported, 0.05, selection?.canonicalQuery, 'edge');
    const unscoped = bevelGeometryRef(imported, 0.05);
    expect(faceCountOf(limited.descriptor)).not.toBeNull();
    expect(faceCountOf(limited.descriptor)).not.toBe(faceCountOf(unscoped.descriptor));
  });

  it('21 — an authored edge scope resolves instead of throwing', () => {
    const asset = 'u/1046-scope.gltf';
    mountClone(asset);
    const selection = resolveComponentSelection(
      spine(capturedAt(asset)),
      { [SCOPE_PARAM]: '0-3' },
      'edge',
    );
    expect(selection?.count).toBe(4);
    expect(selection?.length).toBe(18);
    // The box control answers the same scope against its own 12 edges.
    expect(resolveComponentSelection(spine(box), { [SCOPE_PARAM]: '0-3' }, 'edge')?.length).toBe(
      12,
    );
  });

  it('22 — over an UNMOUNTED import, unscoped and angle-limited resolution do not throw', () => {
    const unmounted = capturedAt('u/1046-never-mounted.gltf');
    expect(() => resolveComponentSelection(spine(unmounted), {}, 'edge')).not.toThrow();
    expect(() => resolveComponentSelection(spine(unmounted), angle(30), 'edge')).not.toThrow();
  });
});
