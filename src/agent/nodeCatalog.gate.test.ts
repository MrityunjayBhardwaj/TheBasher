// #1007 — the node schema payload, gated against the LIVE registry.
//
// Every row here is about the payload being TRUE of the engine, not about the
// walker's internals. The registry is the subject; a node type added tomorrow is
// inside the subject, which is the point.

import { describe, it, expect, beforeAll } from 'vitest';
import { __resetRegistryForTests } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import { getNodeType, listNodeTypes } from '../core/dag/registry';
import { applyOp } from '../core/dag/ops';
import { emptyDagState } from '../core/dag/state';
import { dagInspectTool } from './tools/dagInspect';
import type { DagState } from '../core/dag/state';
import type { ParamField } from './nodeCatalog';
import {
  listNodeSchemas,
  nodeSchemaOf,
  opaqueFields,
  renderNodeCatalog,
  type NodeSchema,
} from './nodeCatalog';

let schemas: NodeSchema[];

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
  schemas = listNodeSchemas();
});

describe('node schema payload (#1007)', () => {
  it('covers every registered type, and nothing it invented', () => {
    expect(schemas.map((s) => s.type)).toEqual(listNodeTypes());
    expect(schemas.length).toBeGreaterThan(50);
  });

  // THE ROW THIS FILE EXISTS FOR. `{type:'unknown'}` was the old summarizer's way
  // of losing 34 param paths without saying so; `opaque` says so, and this pins the
  // count at zero. A new zod construct in any node's schema reds HERE, naming the
  // node and the constructor, instead of quietly widening the blind spot.
  it('describes every param of every node — zero opaque fields', () => {
    const opaque = opaqueFields(schemas);
    expect(
      opaque.map((o) => `${o.type}.${o.field.path} <${o.field.zod}>`),
      'a zod construct the catalog cannot read — teach nodeCatalog.ts to read it',
    ).toEqual([]);
  });

  // The four constructs the shipped summarizer dropped, each asserted on the REAL
  // node that carries it — so the row fails if that node's schema changes shape,
  // which is exactly when the claim needs re-checking.
  it('reads the four constructs that used to be dropped', () => {
    const p = (t: string, path: string) => nodeSchemaOf(t)!.params.find((f) => f.path === path);

    // ZodNullable under a ZodDefault — dropped a seven-field subtree, six slots over
    const albedoHash = p('BoxData', 'material.maps.albedo.hash');
    expect(albedoHash?.kind).toBe('string');
    // …and the slot itself is still settable to null in one write
    const albedo = p('BoxData', 'material.maps.albedo');
    expect(albedo).toEqual({ path: 'material.maps.albedo', kind: 'object', nullable: true });

    // ZodEffects — a refined string is a string, not an opaque
    expect(p('ArrayModifier', 'scope')?.kind).toBe('string');

    // ZodDiscriminatedUnion — named with its variants, deliberately not expanded
    const env = p('Scene', 'envSource');
    expect(env?.kind).toBe('union');
    expect(env?.values?.length).toBeGreaterThan(1);

    // ZodLiteral — carries the one legal value
    const kind = p('BakedData', 'geometry.descriptor.kind');
    expect(kind?.kind).toBe('literal');
    expect(kind?.values).toHaveLength(1);
  });

  it('carries the sockets the raw-op road kept inventing', () => {
    // The measured failure: 18 invented socket names across four models, on a node
    // that declares exactly one input.
    const obj = nodeSchemaOf('Object')!;
    // #1056 — still exactly one input; it now accepts a Skeleton as well, and the catalogue
    // names both types so a model is told the skeleton is a legal thing to wire there.
    expect(obj.inputs).toEqual([
      { socket: 'data', type: 'ObjectData|Skeleton', cardinality: 'single' },
    ]);
    expect(obj.outputs).toEqual([{ socket: 'out', type: 'SceneObject', cardinality: 'single' }]);
    // and `position` IS real — as a PARAM, which is the distinction nobody was given
    expect(obj.params.find((f) => f.path === 'position')).toEqual({
      path: 'position',
      kind: 'tuple',
      arity: 3,
      of: 'number',
    });
  });

  it('states list cardinality, which decides whether a second connect is legal', () => {
    const scatter = nodeSchemaOf('Scatter')!;
    expect(scatter.inputs).toEqual([
      { socket: 'assets', type: 'SceneObject', cardinality: 'list' },
    ]);
  });

  it('agrees with the registry on every socket, for every type', () => {
    for (const s of schemas) {
      const def = getNodeType(s.type)!;
      expect(s.inputs.map((i) => i.socket)).toEqual(Object.keys(def.inputs));
      expect(s.outputs.map((o) => o.socket)).toEqual(Object.keys(def.outputs));
      for (const i of s.inputs) {
        const d = def.inputs[i.socket];
        expect(i.cardinality).toBe(d.cardinality);
        expect(i.type).toBe(
          Array.isArray(d.type) ? (d.type as readonly string[]).join('|') : d.type,
        );
      }
    }
  });

  // Every param path the catalog prints must be a path the ENGINE accepts. Checked
  // by sending the REAL `setParam` op through `applyOp` — not by re-reading the zod
  // shape, which would only ask the walker whether it agrees with itself.
  //
  // Two ways a path can be wrong, and they fail differently: a bad ROOT key is
  // caught and reported as a `stripped-write` (#423), while a bad key NESTED under
  // a good root survives the report and is dropped in silence. Both count here.
  it('every param path it prints survives a real setParam', () => {
    const stripped: string[] = [];
    const dropped: string[] = [];
    let examined = 0;
    let skippedValue = 0;

    for (const s of schemas) {
      let state: DagState;
      try {
        state = applyOp(emptyDagState(), {
          type: 'addNode',
          nodeId: 'n',
          nodeType: s.type,
          params: {},
        }).next;
      } catch {
        continue; // schema needs required params — the path claim is untested here
      }
      for (const f of s.params) {
        const value = sampleValue(f);
        if (value === SKIP) continue;
        examined++;
        let res;
        try {
          res = applyOp(state, { type: 'setParam', nodeId: 'n', paramPath: f.path, value });
        } catch {
          skippedValue++; // the VALUE was refused, which says nothing about the PATH
          continue;
        }
        if (res.reportable?.badge === 'stripped-write') {
          stripped.push(`${s.type}.${f.path}`);
          continue;
        }
        if (readPath(res.next.nodes.n.params, f.path) === undefined && value !== undefined) {
          dropped.push(`${s.type}.${f.path}`);
        }
      }
    }

    // Print the denominator beside the zero — a row that examined nothing passes too.
    console.log(
      `[#1007] setParam round-trip: examined=${examined} stripped=${stripped.length} ` +
        `silentlyDropped=${dropped.length} valueRefused=${skippedValue}`,
    );
    expect(examined).toBeGreaterThan(400);
    expect(stripped).toEqual([]);
    expect(dropped).toEqual([]);
  });

  // The no-drift row. `dag.inspect({scope:'types'})` used to carry its OWN summarizer
  // three files away from the registry, which is how it came to be wrong at 34 paths
  // without anyone noticing. It now returns this projection verbatim; if the two ever
  // diverge again, they diverge here first.
  it('is what dag.inspect({scope:types}) returns, verbatim', () => {
    const result = dagInspectTool.handler({ scope: 'types' }, {
      dagState: emptyDagState(),
    } as Parameters<typeof dagInspectTool.handler>[1]);
    // `handler` may return a promise for other tools; this one is synchronous, and
    // narrowing here keeps the assertion typed rather than reaching through `any`.
    const sync = result as { text: string; ops: unknown[] };
    expect(sync.text).toBe(renderNodeCatalog());
    expect(sync.ops).toHaveLength(0);
  });

  it('renders a payload small enough to send, with its own legend', () => {
    const text = renderNodeCatalog(schemas);
    expect(text).toContain('Object | in: data:ObjectData');
    expect(text).toContain('Param paths are exactly the paths setParam takes');
    // The whole reason this file exists: dag.inspect's JSON is 120,813 B.
    //
    // 25,000 since #1149, down from 40,000 — and the number is a budget with slack again, not a
    // line the next material field pushes. It was 40,059 B against a 40,000 B ceiling the day
    // #1140 added three fields, because five node types each printed the whole material tree and
    // every field in it cost ~90 B five times over. The tree is printed once now (21,573 B total),
    // so a material field costs its own bytes and no more.
    expect(text.length).toBeLessThan(25_000);
    console.log(`[#1007] renderNodeCatalog = ${text.length} B over ${schemas.length} types`);
  });

  // #1149 — the payload prints a repeated subtree once and refers to it by name. The rows below
  // are about the ONE property that makes that safe: a reader must still end up with exactly the
  // param paths the registry has, and not one fewer. The saving is real but it is not the subject;
  // a smaller payload that lost a path would be a worse payload.
  describe('shared param blocks (#1149)', () => {
    /**
     * Read the payload the way its legend tells a reader to: expand every `x:<name>` against the
     * `<name> = …` block, and hand back the full param paths per node type.
     */
    /**
     * Split a rendered field list. Not `split(' ')`: a tuple prints its arity and element kind as
     * `[3 number]`, so a space inside brackets belongs to the field it is in.
     */
    function fieldsOf(list: string): string[] {
      return list === '-' ? [] : (list.match(/(?:[^\s[]|\[[^\]]*\])+/g) ?? []);
    }

    function pathsFromText(text: string): Map<string, string[]> {
      const blocks = new Map<string, string[]>();
      const byType = new Map<string, string[]>();
      for (const line of text.split('\n')) {
        const block = /^<(\w+)> = (.*)$/.exec(line);
        if (block) {
          blocks.set(
            block[1],
            fieldsOf(block[2]).map((f) => f.split(':')[0]),
          );
          continue;
        }
        const row = /^(\w+) \| in: .* \| out: .* \| params: (.*)$/.exec(line);
        if (!row) continue;
        const fields = fieldsOf(row[2]);
        byType.set(
          row[1],
          fields.flatMap((f) => {
            const ref = /^(\w+):<(\w+)>$/.exec(f);
            if (!ref) return [f.split(':')[0]];
            const body = blocks.get(ref[2]);
            expect(body, `the line refers to <${ref[2]}>, which must exist`).toBeDefined();
            return body!.map((p) => `${ref[1]}.${p}`);
          }),
        );
      }
      return byType;
    }

    it('a reader who expands the blocks gets exactly the registry’s paths, for every type', () => {
      const fromText = pathsFromText(renderNodeCatalog(schemas));
      // The denominator beside the comparison: a walk that read nothing agrees with everything.
      expect(fromText.size).toBe(schemas.length);
      for (const s of schemas) {
        expect(fromText.get(s.type), s.type).toEqual(s.params.map((p) => p.path));
      }
    });

    it('the material tree is printed once and shared by every type that embeds it', () => {
      const text = renderNodeCatalog(schemas);
      expect(text.match(/^<material> = /gm)).toHaveLength(1);
      for (const type of ['BoxData', 'SphereData', 'PolyMeshData', 'GltfData', 'Material']) {
        expect(text, type).toContain(`${type} | `);
        const line = text.split('\n').find((l) => l.startsWith(`${type} | `))!;
        expect(line, type).toContain('material:<material>');
      }
    });

    it('a different tree under the same prefix prints in full — BakedData keeps its own', () => {
      // `BakedData.material` is the baked snapshot, not the OpenPBR IR. It prints in full because
      // it is the only one of its shape in the registry, so it is never a candidate — the name
      // clash below is the OTHER reason a tree can be passed over, and it needs its own row.
      const line = renderNodeCatalog(schemas)
        .split('\n')
        .find((l) => l.startsWith('BakedData | '))!;
      expect(line).not.toContain('material:<material>');
      expect(line).toContain('material.materialClass:');
    });

    it('two different shared trees cannot both be called <material>', () => {
      // Not reachable from the live registry today: it needs two DISTINCT trees under one prefix,
      // each shared by two or more types. It is reachable the day a second material shape is
      // embedded twice, and then an ambiguous payload — one name, two meanings — is the kind of
      // wrongness a reader cannot detect. So the state is minted by hand here, and this row goes
      // red the day the guard is removed.
      const leaf = (path: string): ParamField => ({ path, kind: 'number' });
      const wide = (n: number) =>
        Array.from({ length: n }, (_, i) => leaf(`material.wide${i}.value`));
      const type = (name: string, params: ParamField[]): NodeSchema => ({
        type: name as NodeSchema['type'],
        inputs: [],
        outputs: [],
        params,
      });
      const a = wide(40);
      const b = wide(40).map((p) => leaf(p.path.replace('wide', 'other')));
      const text = renderNodeCatalog([type('A1', a), type('A2', a), type('B1', b), type('B2', b)]);
      expect(text.match(/^<material> = /gm), 'exactly one block may hold the name').toHaveLength(1);
      // The one that missed out is printed in full, not dropped and not silently renamed.
      const printedInFull = ['B1', 'B2', 'A1', 'A2'].filter((t) =>
        text.split('\n').some((l) => l.startsWith(`${t} | `) && l.includes('material.')),
      );
      expect(printedInFull).toHaveLength(2);
    });

    it('a repeat too small to name stays inline', () => {
      // `sourceTransform` repeats on three types at 128 B — 256 B saved, under the threshold, and
      // a block a reader has to hold in mind is not worth 256 B.
      const line = renderNodeCatalog(schemas)
        .split('\n')
        .find((l) => l.startsWith('ParamDriver | '))!;
      expect(line).toContain('sourceTransform.');
      expect(line).not.toContain('sourceTransform:<');
    });
  });
});

/** Sentinel: this kind has no value we can construct without inventing one. */
const SKIP = Symbol('skip');

/**
 * The blandest legal value for a field, used only to see whether the PATH lands.
 * A value the schema refuses is skipped rather than counted — this row is about
 * paths, and conflating the two would let a tightened `min()` read as a bad path.
 */
function sampleValue(f: ParamField): unknown {
  if (f.nullable) return null;
  switch (f.kind) {
    case 'string':
      return 'x';
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'enum':
    case 'literal':
      return f.values?.[0];
    case 'tuple':
      return Array.from({ length: f.arity ?? 0 }, () => (f.of === 'string' ? 'x' : 0));
    case 'array':
      return [];
    case 'record':
      return {};
    default:
      return SKIP;
  }
}

function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
