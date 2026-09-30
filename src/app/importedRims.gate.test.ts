// importedRims.gate — an imported mesh's polygon rims, and the check that stands in for the
// alignment one it cannot have (#1025).
//
// ⚠️ #1053 — the clone renderer is gone and nothing mounts a clone, so every ground below that
// mounted one was removed; see the note above ground 22 for what stayed and why.
//
// ── WHAT THIS GATE IS FOR, AND WHY IT MOUNTED A REAL CLONE ───────────────────────────────
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
//      src/app/uvAttributes.ts (`refusalFor`); app/asset/gltfCloneRegistry.ts (gone in #1053);
//      issues #1025, #1023, #1024, #738.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { GeometryDescriptor, GeometryRef, ObjectData } from '../nodes/types';
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
import {
  ANGLE_LIMIT_PARAM,
  LIMIT_METHOD_PARAM,
  resolveComponentSelection,
} from '../nodes/componentSelection';
import { weldByPosition } from './pointIdentity';
import { getForRead, prime } from './geometryRegistry';
import { readMeshUVs } from './uvAttributes';

const ASSET = 'u/imported-rims.gltf';
const CHILD = 'Cube';
/** A three.js box is 12 triangles, so an imported one is 12 triangular faces. */
const BOX_TRIANGLES = 12;

const box = boxGeometryRef([1, 1, 1], null);

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

describe('#1025 — the check that stands in for the alignment one', () => {
  it('6 — baked stays refused, and it is the arity that refuses it', () => {
    // Not a road question: a `baked` descriptor carries a vertex count and no face count, so
    // there is no arity to walk a buffer against. It shares `gltf`'s road and reaches none of
    // it. This row is what reds the day a baked face count is captured without a decision.
    const baked: GeometryDescriptor = { kind: 'baked', hash: 'deadbeef', vertexCount: 24 };
    const ref: GeometryRef = { key: 'k|baked', descriptor: baked };
    expect(topologyIsBufferOnly(baked)).toBe(true);
    expect(faceArityOf(baked)).toBeNull();
    expect(alignedSplitRims(ref, new THREE.BoxGeometry(1, 1, 1))).toBeNull();
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

describe('#1025 — every way an imported mesh can refuse says which way it was', () => {
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

// ── #1042, #1041 — THE MOUNTED GROUNDS WENT WITH THE CLONE RENDERER (#1053) ────────────────
//
// Grounds 2–5, 8, 9, 12–21 each mounted a clone so an import's buffer could be read — the rims,
// the corner-domain UVs, the welded-rim door, the bevel's edge selection. The clone renderer and
// the registry it filled are gone, so a `gltf` ref has no buffer and none of them can be built.
// What stays is what needs no clone: the classification (1), the baked controls (6, 6b), the
// substrate kinds (7), the unreachable guard (13c), the real-parse agreement (10, 11) and the
// no-throw safety property (22). The `gltf` arms these grounds pinned retire with the kind.

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

  it('22 — over an UNMOUNTED import, unscoped and angle-limited resolution do not throw', () => {
    const unmounted = capturedAt('u/1046-never-mounted.gltf');
    expect(() => resolveComponentSelection(spine(unmounted), {}, 'edge')).not.toThrow();
    expect(() => resolveComponentSelection(spine(unmounted), angle(30), 'edge')).not.toThrow();
  });
});
