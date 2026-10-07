// #1551 — a node cannot store another node's id without declaring it.
//
// Delete, duplicate and the agent's "what refers to this node" all read `NodeDefinition.idRefs`
// and nothing else, so an id-holding param that is not declared there is invisible to all three.
// A node id is a plain string, and no schema can say which strings are ids. So this gate lists
// every place every registered schema can store a string (`paramStringPaths`) and requires each
// one to be declared in `idRefs` or named in `idRefAcknowledged.ts` with what it holds instead.
//
// What it cannot see is printed, never assumed away: a schema it cannot read is a failure, and an
// object that keeps undeclared keys is a row that has to be acknowledged by name.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getNodeType, listNodeTypes, paramFieldsOf } from '../core/dag/registry';
import type { NodeDefinition } from '../core/dag/types';
import { idRefStringPath, paramStringPaths } from '../core/dag/paramStringPaths';
import { NOT_A_NODE_ID, OPENPBR_VALUE_MOUNTS, OPENPBR_VALUE_STRINGS } from './idRefAcknowledged';
import { openpbrMaterialSchema } from './materialSchema';
import { optionsValueKindOf } from './paramWidget';
import { registerAllNodes } from './registerAll';

registerAllNodes();

type CensusDef = Pick<NodeDefinition, 'type' | 'paramSchema' | 'idRefs'>;

interface Census {
  /** `Type.path` of every string-capable place that is neither declared nor acknowledged. */
  readonly unanswered: string[];
  /** Places the walker could not read; each is a failure on its own. */
  readonly unreadable: string[];
  /** Declared `idRefs` entries with no string at the path their `shape` says. */
  readonly declaredNowhere: string[];
  /** Every `Type.path` the walk produced, for the stale-acknowledgement check. */
  readonly seen: Set<string>;
}

function censusOf(
  defs: readonly CensusDef[],
  acknowledged: Readonly<Record<string, string>>,
): Census {
  const out: Census = { unanswered: [], unreadable: [], declaredNowhere: [], seen: new Set() };
  for (const def of defs) {
    const rows = paramStringPaths(def.paramSchema);
    const declared = new Set((def.idRefs ?? []).map(idRefStringPath));
    const strings = new Set(rows.filter((r) => r.kind === 'string').map((r) => r.path));
    for (const path of declared) {
      if (!strings.has(path)) out.declaredNowhere.push(`${def.type}.${path}`);
    }
    for (const row of rows) {
      const key = `${def.type}.${row.path}`;
      out.seen.add(key);
      if (row.kind === 'unreadable') {
        out.unreadable.push(`${key} (${row.detail})`);
        continue;
      }
      if (row.kind === 'string' && declared.has(row.path)) continue;
      if (!(key in acknowledged)) out.unanswered.push(`${key} [${row.kind}]`);
    }
  }
  return out;
}

const registered = (): CensusDef[] =>
  listNodeTypes().map((type) => {
    const def = getNodeType(type);
    if (!def) throw new Error(`listed but not registered: ${type}`);
    return def;
  });

describe('#1551 — the census itself can fail', () => {
  const fake = (paramSchema: z.ZodTypeAny, idRefs?: NodeDefinition['idRefs']): CensusDef => ({
    type: 'Fake',
    paramSchema,
    idRefs,
  });

  it('an undeclared string is unanswered, wherever it sits', () => {
    const schema = z.object({
      follows: z.string().default(''),
      maybe: z.string().min(1).optional(),
      nested: z.object({ node: z.string(), channel: z.enum(['tx', 'ty']) }).optional(),
      many: z.array(z.string()).default([]),
      byId: z.record(z.string(), z.number()).default({}),
      either: z.union([z.number(), z.object({ who: z.string() })]),
      refined: z.string().refine((v) => v !== 'x'),
      count: z.number().default(0),
      mode: z.enum(['a', 'b']).default('a'),
    });
    expect(censusOf([fake(schema)], {}).unanswered).toEqual([
      'Fake.follows [string]',
      'Fake.maybe [string]',
      'Fake.nested.node [string]',
      'Fake.many[] [string]',
      'Fake.byId{key} [string]',
      'Fake.either.who [string]',
      'Fake.refined [string]',
    ]);
  });

  it('declaring it, in each stored shape, answers it', () => {
    const schema = z.object({
      follows: z.string().default(''),
      nested: z.object({ node: z.string() }).optional(),
      whole: z.object({ node: z.string() }).optional(),
      many: z.array(z.string()).default([]),
    });
    const census = censusOf(
      [
        fake(schema, [
          { path: 'follows', shape: 'id', role: 'argument' },
          { path: 'nested.node', shape: 'nested', role: 'argument' },
          { path: 'whole', shape: 'ref', role: 'argument' },
          { path: 'many', shape: 'idList', role: 'argument' },
        ]),
      ],
      {},
    );
    expect(census.unanswered).toEqual([]);
    expect(census.declaredNowhere).toEqual([]);
  });

  it('acknowledging it answers it, and only for the exact type and path', () => {
    const schema = z.object({ label: z.string(), other: z.string() });
    expect(censusOf([fake(schema)], { 'Fake.label': 'a label' }).unanswered).toEqual([
      'Fake.other [string]',
    ]);
    expect(censusOf([fake(schema)], { 'Other.label': 'a label' }).unanswered).toHaveLength(2);
  });

  it('a declaration whose shape does not match what is stored is reported', () => {
    const schema = z.object({ many: z.array(z.string()), count: z.number() });
    const census = censusOf(
      [
        fake(schema, [
          { path: 'many', shape: 'id', role: 'argument' },
          { path: 'count', shape: 'id', role: 'argument' },
          { path: 'gone', shape: 'ref', role: 'argument' },
        ]),
      ],
      {},
    );
    expect(census.declaredNowhere).toEqual(['Fake.many', 'Fake.count', 'Fake.gone.node']);
  });

  it('what it cannot read is said, not skipped', () => {
    const census = censusOf(
      [
        fake(
          z.object({
            anything: z.any(),
            open: z.object({ a: z.number() }).passthrough(),
            fn: z.function(),
          }),
        ),
      ],
      {},
    );
    expect(census.unanswered).toEqual(['Fake.anything [opaque]', 'Fake.open.* [open]']);
    expect(census.unreadable).toEqual(['Fake.fn (ZodFunction)']);
  });
});

describe('#1551 — every string a registered node can store is an id reference or is not', () => {
  const census = censusOf(registered(), NOT_A_NODE_ID);

  it('reads every registered schema', () => {
    expect(listNodeTypes().length).toBeGreaterThan(80);
    expect(census.unreadable).toEqual([]);
  });

  it('every string-capable param is declared in idRefs or acknowledged as something else', () => {
    // A new row here is a question, not a chore: can this string be another node's id? If so,
    // declare it in the type's `idRefs` with a deliberate `role`. If not, add it to
    // `idRefAcknowledged.ts` with what it holds.
    expect(census.unanswered).toEqual([]);
  });

  it('every declared idRef stores a string where its shape says', () => {
    expect(census.declaredNowhere).toEqual([]);
  });

  it('no acknowledgement outlives the param it names', () => {
    expect(Object.keys(NOT_A_NODE_ID).filter((key) => !census.seen.has(key))).toEqual([]);
  });

  it('nothing is both declared and acknowledged', () => {
    const both = registered().flatMap((def) =>
      (def.idRefs ?? [])
        .map((ref) => `${def.type}.${idRefStringPath(ref)}`)
        .filter((key) => key in NOT_A_NODE_ID),
    );
    expect(both).toEqual([]);
  });

  it('a param whose picker says it holds a node id is declared as one', () => {
    // The same fact is declared a second time, for the inspector: `optionsParam(…, 'nodeId')`
    // (#1065). The two must agree, so an id the picker knows about cannot be acknowledged
    // away here as a label.
    const pickedIds = registered().flatMap((def) =>
      Object.entries(paramFieldsOf(def) ?? {})
        .filter(([, field]) => optionsValueKindOf(field) === 'nodeId')
        .map(([key]) => ({ def, key })),
    );
    expect(pickedIds.length).toBeGreaterThan(8);
    const undeclared = pickedIds
      .filter(({ def, key }) => !(def.idRefs ?? []).some((ref) => ref.path === key))
      .map(({ def, key }) => `${def.type}.${key}`);
    expect(undeclared).toEqual([]);
  });

  it('the shared material list is the material schema, and each mount stores one', () => {
    const relative = paramStringPaths(openpbrMaterialSchema()).map((row) => row.path);
    expect(Object.keys(OPENPBR_VALUE_STRINGS).sort()).toEqual([...relative].sort());
    for (const mount of OPENPBR_VALUE_MOUNTS) {
      for (const rel of relative) expect(census.seen.has(`${mount}.${rel}`)).toBe(true);
    }
  });

  it('the declared id references are the ones counted (printed so a change is seen)', () => {
    const declared = registered()
      .flatMap((def) => (def.idRefs ?? []).map((ref) => `${def.type}.${ref.path}:${ref.role}`))
      .sort();
    expect(declared).toMatchInlineSnapshot(`
      [
        "FollowPath.curve:argument",
        "FollowPath.target:subject",
        "KeyframeChannelColor.target:subject",
        "KeyframeChannelImage.target:subject",
        "KeyframeChannelNumber.target:subject",
        "KeyframeChannelQuat.target:subject",
        "KeyframeChannelText.target:subject",
        "KeyframeChannelVec2.target:subject",
        "KeyframeChannelVec3.target:subject",
        "Lag.sourceTransform.node:argument",
        "ParamDriver.sourceSpare.node:argument",
        "ParamDriver.sourceTransform.node:argument",
        "ParamDriver.sourceTransformVec:argument",
        "ParamDriver.target:subject",
        "SampleGeometry.at:argument",
        "SampleGeometry.sourceGeometry:argument",
        "Scene.activeCollection:argument",
        "Solver.sourceTransform.node:argument",
        "Solver.sourceTransformVec:argument",
        "Strip.action:argument",
        "Strip.target:subject",
        "Track.strips:argument",
        "TrackTo.aimNode:argument",
        "TrackTo.target:subject",
      ]
    `);
  });
});
