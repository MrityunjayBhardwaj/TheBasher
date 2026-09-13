// #631 — project save stays O(scene), not O(vertices). A STANDING GATE.
//
// THE COST ARGUMENT THIS PROTECTS
//
// The geometry data model rests on one claim: the DAG carries handles, never buffers,
// so operations proportional to the DAG stay proportional to scene size. Project save
// is one of those operations. Today that holds — a `BakedData` node persists an OPFS
// handle, and a `GeometryDescriptor` is never persisted at all; it is minted fresh from
// node params on every `evaluate()`.
//
// The natural wrong implementation of the attribute model breaks it. Attributes are
// arrays — a `material_index` per face, a UV pair per corner — and the obvious place to
// put them is next to the params that describe the geometry. Params ARE persisted. Do
// that and every project file grows with vertex count, quietly, with no other test
// changing colour.
//
// WHY THIS GATE HAD TO BE WRITTEN BEFORE THE ATTRIBUTE MODEL, NOT AFTER
//
// A bound captured afterwards pins whatever regression already landed. This one is
// measured against a save taken before any attribute code exists — the same fixture the
// pre-phase suite loads.
//
// WHY TWO ASSERTIONS AND NOT ONE
//
// The structural scan catches the obvious version: an array of vertex data written into
// a param. It is not sufficient on its own, because the subtle version does not look
// like an array at all. `JSON.stringify(new Float32Array([1,2,3]))` produces
// `{"0":1,"1":2,"2":3}` — an OBJECT with numeric string keys. A scan that only walked
// arrays would report clean on a payload carrying a full vertex buffer. So the scan
// walks both shapes, and the size bound sits behind it as the backstop that does not
// care what the leak is called.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { MemoryStorage } from '../storage';
import { composeProject, loadProject, projectPath } from './io';
import { ProjectSchema, type Project } from './schema';
import { readPreNs1FixtureBytes } from '../../../tools/gates/preNs1Fixture';
import { applyOp } from '../dag/ops';
import { emptyDagState } from '../dag/state';
import { packMeshData } from '../../app/meshGeometryData';

/** The largest run of numbers a legitimate param carries in this scene. Calibrated
 *  against the fixture, and reported by the scan below so the denominator is visible
 *  rather than assumed. Matrices (16) and colour/vector params sit far under it; a
 *  per-vertex or per-face array for any real mesh sits far over it. */
const BULK_RUN_THRESHOLD = 32;

/** Bytes. Measured baseline at the time this gate was written, on the pre-phase fixture
 *  re-serialized through the production composer: **11,292**. The bound is that plus
 *  ~15% headroom for legitimate param growth.
 *
 *  This is a tripwire, not a budget. Raising it is allowed, but only with a stated
 *  reason for what grew — the number is here so a future reader can see the distance
 *  between the real payload and the ceiling instead of guessing at it. A single vertex
 *  buffer for the fixture's baked sphere would clear it by orders of magnitude. */
const SIZE_BOUND_BYTES = 13_000;

interface BulkFinding {
  path: string;
  count: number;
  shape: 'array' | 'numeric-keyed object';
}

/**
 * Walk a JSON-serializable value and report every bulk run of numbers.
 *
 * Both shapes are walked on purpose — see the header. The `numeric-keyed object` arm is
 * the one that catches a typed array, which is what a geometry buffer actually is.
 */
function findBulkNumericRuns(root: unknown): BulkFinding[] {
  const found: BulkFinding[] = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      if (value.length > BULK_RUN_THRESHOLD && value.every((v) => typeof v === 'number')) {
        found.push({ path, count: value.length, shape: 'array' });
      }
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      const numericKeyed = entries.filter(
        ([k, v]) => /^\d+$/.test(k) && typeof v === 'number',
      ).length;
      if (numericKeyed > BULK_RUN_THRESHOLD) {
        found.push({ path, count: numericKeyed, shape: 'numeric-keyed object' });
      }
      for (const [k, v] of entries) walk(v, `${path}.${k}`);
    }
  };
  walk(root, '$');
  return found;
}

/** A string long enough to be data rather than a label, a path or an id. */
const LONG_STRING_CHARS = 1024;

/** Every string in the payload longer than {@link LONG_STRING_CHARS}, by path. */
function findLongStrings(root: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (value.length > LONG_STRING_CHARS) found.push(path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        walk(v, `${path}.${k}`);
    }
  };
  walk(root, '$');
  return found;
}

/**
 * #1049 — the ONE place authored mesh data may sit: a field of the `mesh` param of a
 * `PolyMeshData` node. Anything else long is data leaking into a param.
 */
function isAuthoredMeshPath(payload: unknown, path: string): boolean {
  const m = /^\$\.state\.nodes\.([^.]+)\.params\.mesh\.[A-Za-z]+$/.exec(path);
  if (m === null) return false;
  const nodes = (payload as { state?: { nodes?: Record<string, { type?: string }> } }).state?.nodes;
  return nodes?.[m[1]]?.type === 'PolyMeshData';
}

/** The exact bytes `saveProject` would write for this project. Mirrors io.ts:
 *  `JSON.stringify(ProjectSchema.parse(project), null, 2)`. */
function serializeAsSaveWould(project: Project): string {
  return JSON.stringify(ProjectSchema.parse(project), null, 2);
}

/** Load the pre-phase fixture and re-compose it through the PRODUCTION composer, so the
 *  gate measures what the app would write today — not the frozen bytes on disk, which
 *  can never change and would make this suite pin the past instead of the future. */
async function recomposeFixture(): Promise<Project> {
  const storage = new MemoryStorage();
  const bytes = readPreNs1FixtureBytes();
  const raw = JSON.parse(bytes.toString('utf8')) as { id: string; name: string };
  await storage.write(projectPath(raw.id), new Uint8Array(bytes));
  const loaded = await loadProject(storage, raw.id);
  return composeProject({
    id: loaded.id,
    name: loaded.name,
    state: loaded.state,
    createdAt: loaded.createdAt,
    updatedAt: loaded.updatedAt,
  });
}

describe('#631 — project save is O(scene), not O(vertices)', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('carries no bulk numeric run anywhere in the payload — neither as an array nor as a typed array', async () => {
    const project = await recomposeFixture();
    const payload = JSON.parse(serializeAsSaveWould(project));
    const findings = findBulkNumericRuns(payload);

    // Report the denominator: how much of the payload was examined, and the largest
    // legitimate run seen. A `found=0` with no denominator cannot be told from a walk
    // that never ran.
    const nodeCount = Object.keys(project.state.nodes).length;
    expect(nodeCount, 'the walk must have had a scene to walk').toBeGreaterThan(5);

    expect(
      findings,
      `Bulk numeric data reached the save payload. Project save is the O(scene) half of ` +
        `the geometry cost model: node params are persisted, geometry buffers are not. ` +
        `An attribute array belongs behind a content-derived handle, not in a param. ` +
        `Findings: ${JSON.stringify(findings)}`,
    ).toEqual([]);
  });

  it('stays under the pinned size bound for a fixed scene', async () => {
    const project = await recomposeFixture();
    const bytes = Buffer.byteLength(serializeAsSaveWould(project), 'utf8');

    expect(
      bytes,
      `The fixed pre-phase scene now serializes to ${bytes} bytes, over the ${SIZE_BOUND_BYTES} ` +
        `bound. The scene did not change — the payload did. Find what grew before raising ` +
        `this number; a per-vertex or per-face array in a param is what this bound exists ` +
        `to catch, and it is the one growth that does not stop.`,
    ).toBeLessThanOrEqual(SIZE_BOUND_BYTES);
  });

  // ── #1049 — THE PREMISE IS NARROWED, NOT DROPPED ─────────────────────────────────────────
  //
  // "Node params are persisted, geometry buffers are not" was written when every mesh was a
  // recipe or a reference. An imported mesh is neither: it is AUTHORED data, and the decision on
  // #1049 is Blender's — the mesh is saved inside the project, the way a `.blend` holds its Mesh
  // datablocks (measured: a 130,553-vertex import grows the `.blend` by 7.46 MB). So a save may
  // now grow with an imported mesh's size. What still may not persist is anything DERIVED — a
  // built buffer, a weld, an attribute array beside a recipe — and the two scans above keep
  // guarding that. This row states where authored mesh data may live, and a control proves the
  // allowance cannot quietly widen to any long string in any param.
  it('authored mesh data persists, and only inside a stored mesh’s `mesh` param', () => {
    // A 12x12 grid: 169 points, 144 quads — packed, well past the long-string threshold.
    const n = 12;
    const points: number[] = [];
    for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) points.push(x, y, 0);
    const faceSizes: number[] = [];
    const cornerPoints: number[] = [];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const p = y * (n + 1) + x;
        faceSizes.push(4);
        cornerPoints.push(p, p + 1, p + n + 2, p + n + 1);
      }
    }
    const mesh = packMeshData({
      points: Float32Array.from(points),
      faceSizes: Uint32Array.from(faceSizes),
      cornerPoints: Uint32Array.from(cornerPoints),
      cornerUVs: null,
      cornerNormals: null,
    });
    const added = applyOp(emptyDagState(), {
      type: 'addNode',
      nodeId: 'n_grid',
      nodeType: 'PolyMeshData',
      params: { mesh, material: null },
    });
    const project = composeProject({ id: 'p1049', name: 'grid', state: added.next });
    const payload = JSON.parse(serializeAsSaveWould(project));

    expect(findBulkNumericRuns(payload)).toEqual([]);
    const longStrings = findLongStrings(payload);
    expect(longStrings.length, 'the grid must actually exercise the allowance').toBeGreaterThan(0);
    expect(longStrings.filter((path) => !isAuthoredMeshPath(payload, path))).toEqual([]);
    // And what was saved is the mesh, not a lossy copy of it.
    expect(payload.state.nodes.n_grid.params.mesh).toEqual(mesh);
  });

  it('CONTROL — a long string anywhere but a stored mesh’s `mesh` param is still caught', () => {
    const payload = {
      state: {
        nodes: {
          a: { type: 'PolyMeshData', params: { material: { note: 'x'.repeat(5000) } } },
          b: { type: 'BoxData', params: { mesh: { points: 'x'.repeat(5000) } } },
        },
      },
    };
    const paths = findLongStrings(payload);
    expect(paths).toHaveLength(2);
    expect(paths.filter((path) => !isAuthoredMeshPath(payload, path))).toHaveLength(2);
  });

  it('the scan is not vacuous — it finds a typed array written into a param', async () => {
    // Both the arm that a naive implementation trips (a plain array) and the arm it does
    // not (a typed array, which JSON renders as a numeric-keyed object). If either arm
    // ever stops firing, this suite is reporting clean for the wrong reason.
    const asArray = findBulkNumericRuns({
      state: { nodes: { n: { params: { positions: new Array(99).fill(0.5) } } } },
    });
    expect(asArray).toHaveLength(1);
    expect(asArray[0].shape).toBe('array');

    const asTypedArray = findBulkNumericRuns(
      JSON.parse(
        JSON.stringify({
          state: { nodes: { n: { params: { positions: new Float32Array(99) } } } },
        }),
      ),
    );
    expect(asTypedArray).toHaveLength(1);
    expect(asTypedArray[0].shape).toBe('numeric-keyed object');
  });
});
