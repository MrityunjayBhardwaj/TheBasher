// Node schema catalog — the node vocabulary, in the form a caller needs to WIRE it.
//
// #1007. The registry has always known every socket name, cardinality and param
// path; nothing ever handed them to an agent. Measured over 110 raw-op calls from
// four models: ZERO invented node types, and 23 of 64 connect calls died inventing
// a SOCKET — 18 distinct names, every one what a careful reader would expect
// (`Object.position`, `Object.material`, `Scene.objects`). `Object` declares one
// input, `data`. The failure was never coverage or node choice. It was names, and
// names are the one thing a payload fixes.
//
// ── WHY THIS IS A PROJECTION AND NOT A SECOND DESCRIPTION ────────────────────────
//
// `dag.inspect({scope:'types'})` already answered this question and could not be
// used for it: 120,813 B pretty-printed (the mutator picker, for scale, is 7,733 B
// and was itself cut down from ~26 KB for being ~22% of a turn budget), and lossy
// at 34 param paths across 13 node types. So the temptation is to write a second,
// smaller description by hand — which is how the engine and the agent's vocabulary
// drifted apart in the first place. This is DERIVED from the registry, and
// `dagInspect` reads it too, so the two cannot say different things.
//
// ── TOTAL, NOT BEST-EFFORT ───────────────────────────────────────────────────────
//
// The old summarizer handled eight zod constructors and returned `{type:'unknown'}`
// for everything else. Four unhandled ones were live — `ZodNullable` (which alone
// dropped a seven-field subtree six times over on four node types), `ZodEffects`,
// `ZodDiscriminatedUnion`, `ZodLiteral` — and a dropped subtree printed identically
// to a genuinely empty one. A reader could not tell "we could not describe this"
// from "there is nothing here".
//
// So a construct this file cannot read produces an `opaque` field that NAMES the
// constructor and is counted, rather than a silent `unknown`; and `nodeCatalog.gate`
// pins that count at zero over the live registry. The honest value keeps a partial
// answer available in production if a new construct ever slips through, and the gate
// is what makes "zero" a fact rather than a hope — a description failure should not
// become an availability failure, but it should also never pass unnoticed.

import type { NodeDefinition, NodeTypeId } from '../core/dag/types';
import { getNodeType, listNodeTypes } from '../core/dag/registry';

/** What a param leaf IS, in the vocabulary a caller writing `setParam` needs. */
export type ParamKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'literal'
  | 'tuple'
  | 'array'
  | 'record'
  | 'object'
  | 'union'
  | 'opaque';

export interface ParamField {
  /**
   * Dotted, and deliberately the SAME string `setParam`'s `paramPath` takes
   * (`ops.ts` → `getAtPath`/`setAtPath`). A payload whose paths need translating
   * before use is a payload that will be mistranslated.
   */
  path: string;
  kind: ParamKind;
  /** enum members, a literal's single value, or a discriminated union's variants. */
  values?: readonly (string | number | boolean)[];
  /** Tuple length — a Vec3 param is unusable without it. */
  arity?: number;
  /** Element kind, for `tuple` and `array`. */
  of?: ParamKind;
  /** `null` is a legal value here — worth stating, since it usually means "no map". */
  nullable?: true;
  /** ONLY on `opaque`: the zod constructor this file could not read. */
  zod?: string;
}

export interface SocketField {
  socket: string;
  /** One accepted type, or a set spelled `A|B` — an input ACCEPTS, an output HAS. */
  type: string;
  cardinality: 'single' | 'list';
}

export interface NodeSchema {
  type: NodeTypeId;
  inputs: SocketField[];
  outputs: SocketField[];
  params: ParamField[];
}

type ZodDef = Record<string, unknown> & { typeName?: string };

function defOf(schema: unknown): ZodDef | undefined {
  const d = (schema as { _def?: unknown } | undefined)?._def;
  return d && typeof d === 'object' ? (d as ZodDef) : undefined;
}

/**
 * Peel the wrappers that change a field's OPTIONALITY but not its shape, and
 * report whether `null` survived the peel. `ZodEffects` is peeled with them
 * because a refinement narrows which values are legal without changing what the
 * value IS — the five operators' `scope` is a refined string, and calling it
 * opaque would lose a field that is perfectly describable.
 */
function unwrap(schema: unknown): { inner: unknown; nullable: boolean } {
  let cur = schema;
  let nullable = false;
  for (let i = 0; i < 12; i++) {
    const d = defOf(cur);
    if (!d) break;
    if (d.typeName === 'ZodNullable') {
      nullable = true;
      cur = d.innerType;
      continue;
    }
    if (d.typeName === 'ZodDefault' || d.typeName === 'ZodOptional') {
      cur = d.innerType;
      continue;
    }
    if (d.typeName === 'ZodEffects') {
      cur = d.schema;
      continue;
    }
    break;
  }
  return { inner: cur, nullable };
}

/** The kind of a leaf, without descending. Used for tuple/array ELEMENTS. */
function kindOf(schema: unknown): ParamKind {
  const { inner } = unwrap(schema);
  switch (defOf(inner)?.typeName) {
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
      return 'number';
    case 'ZodBoolean':
      return 'boolean';
    case 'ZodEnum':
      return 'enum';
    case 'ZodLiteral':
      return 'literal';
    case 'ZodTuple':
      return 'tuple';
    case 'ZodArray':
      return 'array';
    case 'ZodRecord':
      return 'record';
    case 'ZodObject':
      return 'object';
    case 'ZodDiscriminatedUnion':
    case 'ZodUnion':
      return 'union';
    default:
      return 'opaque';
  }
}

const MAX_DEPTH = 8;

function walk(schema: unknown, path: string, out: ParamField[], depth: number): void {
  if (depth > MAX_DEPTH) {
    out.push({ path, kind: 'opaque', zod: `depth>${MAX_DEPTH}` });
    return;
  }
  const { inner, nullable } = unwrap(schema);
  const d = defOf(inner);
  const tn = d?.typeName;
  const mark = <T extends ParamField>(f: T): T => (nullable ? { ...f, nullable: true } : f);

  switch (tn) {
    case 'ZodObject': {
      // A NULLABLE object gets an entry of its own as well as its children: the
      // whole slot can be set to null in one write (`material.maps.albedo`), and a
      // caller shown only the children would never learn that.
      if (nullable) out.push({ path, kind: 'object', nullable: true });
      const shape = ((d as { shape?: () => Record<string, unknown> }).shape?.() ?? {}) as Record<
        string,
        unknown
      >;
      for (const [key, field] of Object.entries(shape)) {
        walk(field, path ? `${path}.${key}` : key, out, depth + 1);
      }
      return;
    }
    case 'ZodString':
      out.push(mark({ path, kind: 'string' }));
      return;
    case 'ZodNumber':
      out.push(mark({ path, kind: 'number' }));
      return;
    case 'ZodBoolean':
      out.push(mark({ path, kind: 'boolean' }));
      return;
    case 'ZodEnum':
      out.push(mark({ path, kind: 'enum', values: d?.values as readonly string[] }));
      return;
    case 'ZodLiteral':
      out.push(mark({ path, kind: 'literal', values: [d?.value as string] }));
      return;
    case 'ZodTuple': {
      const items = (d?.items as unknown[] | undefined) ?? [];
      const kinds = new Set(items.map(kindOf));
      out.push(
        mark({
          path,
          kind: 'tuple',
          arity: items.length,
          // A mixed tuple has no single element kind; saying nothing is better
          // than naming the first one and implying the rest.
          ...(kinds.size === 1 ? { of: [...kinds][0] } : {}),
        }),
      );
      return;
    }
    case 'ZodArray':
      out.push(mark({ path, kind: 'array', of: kindOf(d?.type) }));
      return;
    case 'ZodRecord':
      out.push(mark({ path, kind: 'record' }));
      return;
    case 'ZodDiscriminatedUnion':
    case 'ZodUnion': {
      // Named, not descended. The variants are what a caller has to choose between;
      // expanding every branch's fields inline would multiply the payload for the
      // one param in the registry that is shaped this way (`Scene.envSource`).
      const opts = (d?.options as unknown) ?? [];
      const variants: (string | number | boolean)[] = [];
      const disc = d?.discriminator as string | undefined;
      const list = Array.isArray(opts) ? opts : [...(opts as Map<unknown, unknown>).keys()];
      for (const o of list) {
        if (typeof o === 'string' || typeof o === 'number' || typeof o === 'boolean') {
          variants.push(o);
          continue;
        }
        const shape = (
          defOf(o) as { shape?: () => Record<string, unknown> } | undefined
        )?.shape?.();
        const tag = disc ? shape?.[disc] : undefined;
        const lit = defOf(tag)?.value;
        if (typeof lit === 'string' || typeof lit === 'number' || typeof lit === 'boolean') {
          variants.push(lit);
        }
      }
      out.push(mark({ path, kind: 'union', ...(variants.length > 0 ? { values: variants } : {}) }));
      return;
    }
    default:
      out.push(mark({ path, kind: 'opaque', zod: tn ?? 'no-_def' }));
      return;
  }
}

function socketsOf(def: NodeDefinition): { inputs: SocketField[]; outputs: SocketField[] } {
  const inputs = Object.entries(def.inputs).map(([socket, d]) => ({
    socket,
    // `Array.isArray` does not narrow a READONLY tuple, and `AcceptedTypeSet` is one.
    type: Array.isArray(d.type) ? (d.type as readonly string[]).join('|') : (d.type as string),
    cardinality: d.cardinality,
  }));
  const outputs = Object.entries(def.outputs).map(([socket, d]) => ({
    socket,
    type: d.type,
    cardinality: d.cardinality,
  }));
  return { inputs, outputs };
}

/** One node type's wiring surface. */
export function nodeSchemaOf(type: NodeTypeId): NodeSchema | undefined {
  const def = getNodeType(type);
  if (!def) return undefined;
  const params: ParamField[] = [];
  walk(def.paramSchema, '', params, 0);
  return { type, ...socketsOf(def), params };
}

/** Every registered type, sorted — `listNodeTypes` already sorts. */
export function listNodeSchemas(): NodeSchema[] {
  return listNodeTypes()
    .map(nodeSchemaOf)
    .filter((s): s is NodeSchema => s !== undefined);
}

/** Every field this file could not read. The gate pins this at zero. */
export function opaqueFields(
  schemas: NodeSchema[] = listNodeSchemas(),
): Array<{ type: NodeTypeId; field: ParamField }> {
  return schemas.flatMap((s) =>
    s.params.filter((p) => p.kind === 'opaque').map((field) => ({ type: s.type, field })),
  );
}

function renderParam(p: ParamField): string {
  let s = `${p.path}:${p.kind}`;
  if (p.kind === 'tuple') s += `[${p.arity ?? '?'}${p.of ? ` ${p.of}` : ''}]`;
  else if (p.kind === 'array' && p.of) s += `[${p.of}]`;
  if (p.values && p.values.length > 0) s += `(${p.values.join('|')})`;
  if (p.nullable) s += '?';
  if (p.zod) s += `<${p.zod}>`;
  return s;
}

function renderSocket(s: SocketField): string {
  return `${s.socket}:${s.type}${s.cardinality === 'list' ? '[]' : ''}`;
}

/**
 * The prompt form — one line per node type, and no JSON.
 *
 * JSON costs roughly five times the bytes to say the same thing here, and the
 * whole reason this payload exists is that the JSON one was too big to send. The
 * legend is part of the payload because a notation the reader has to infer is a
 * second guessing game, which is the game we are trying to stop.
 */
export function renderNodeCatalog(schemas: NodeSchema[] = listNodeSchemas()): string {
  const legend = [
    '# Node types. One line each:  <Type> | in: <socket>:<Type> | out: <socket>:<Type> | params: <path>:<kind>',
    '#   []  after a socket type = list cardinality (accepts several connections)',
    '#   A|B after a socket name = accepts either type, unconverted',
    '#   (a|b|c) after a param   = the only legal values',
    '#   [3 number] after a tuple = fixed length and element kind',
    '#   ? after a param = may be null',
    '# Param paths are exactly the paths setParam takes. A path not listed here is not a param.',
  ].join('\n');
  const lines = schemas.map((s) => {
    const ins = s.inputs.map(renderSocket).join(' ') || '-';
    const outs = s.outputs.map(renderSocket).join(' ') || '-';
    const ps = s.params.map(renderParam).join(' ') || '-';
    return `${s.type} | in: ${ins} | out: ${outs} | params: ${ps}`;
  });
  return `${legend}\n${lines.join('\n')}`;
}
