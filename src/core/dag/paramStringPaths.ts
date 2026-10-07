// paramStringPaths — every place in a param schema where an arbitrary string can be stored (#1551).
//
// A node id is a string, and a zod schema cannot say "this string is another node's id". So the
// only way to find an id-holding param the author forgot to declare (`NodeDefinition.idRefs`) is to
// list EVERY string-capable path and require each one to be either declared or acknowledged as
// something else. This module is that list; the gate that reads it is
// `src/nodes/idRefCensus.gate.test.ts`.
//
// It is total on purpose. A schema kind this walker does not know is REPORTED as a row of kind
// 'unreadable', never skipped: "could not look" must not read as "holds no id".
//
// Path spelling: `a.b` a field of an object, `a[]` an element of an array or tuple, `a{}` a value of
// a record, `a{key}` a key of a record (a record can be keyed by node id).
//
// REF: src/core/dag/types.ts (`NodeDefinition.idRefs`); src/core/dag/idRefSweep.ts.

import { z } from 'zod';

export type ParamStringKind =
  /** A free string: `z.string()`, with or without refinements. */
  | 'string'
  /** `z.any()` / `z.unknown()`: anything can be stored here, a node id included. */
  | 'opaque'
  /** An object that keeps undeclared keys (`.passthrough()` / `.catchall()`). */
  | 'open'
  /** A schema kind the walker has no rule for, or nesting past the depth cap. */
  | 'unreadable';

export interface ParamStringRow {
  readonly path: string;
  readonly kind: ParamStringKind;
  /** For 'unreadable': what stopped the walk. */
  readonly detail?: string;
}

const MAX_DEPTH = 16;

/** Kinds that can only ever hold one of a closed set of values, so never an arbitrary id. */
const CLOSED = [
  z.ZodNumber,
  z.ZodBoolean,
  z.ZodEnum,
  z.ZodNativeEnum,
  z.ZodLiteral,
  z.ZodNull,
  z.ZodUndefined,
  z.ZodBigInt,
  z.ZodDate,
  z.ZodNaN,
  z.ZodVoid,
  z.ZodNever,
] as const;

function walk(schema: unknown, path: string, depth: number, out: ParamStringRow[]): void {
  if (depth > MAX_DEPTH) {
    out.push({ path, kind: 'unreadable', detail: `nested deeper than ${MAX_DEPTH}` });
    return;
  }
  const next = depth + 1;
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodReadonly
  ) {
    return walk(schema.unwrap(), path, next, out);
  }
  if (schema instanceof z.ZodDefault) return walk(schema.removeDefault(), path, next, out);
  if (schema instanceof z.ZodCatch) return walk(schema.removeCatch(), path, next, out);
  if (schema instanceof z.ZodBranded) return walk(schema.unwrap(), path, next, out);
  if (schema instanceof z.ZodEffects) return walk(schema.innerType(), path, next, out);
  if (schema instanceof z.ZodLazy) return walk(schema.schema, path, next, out);
  if (schema instanceof z.ZodPipeline) return walk(schema._def.in, path, next, out);
  if (schema instanceof z.ZodString) {
    out.push({ path, kind: 'string' });
    return;
  }
  if (schema instanceof z.ZodAny || schema instanceof z.ZodUnknown) {
    out.push({ path, kind: 'opaque' });
    return;
  }
  if (CLOSED.some((kind) => schema instanceof kind)) return;
  if (schema instanceof z.ZodArray) return walk(schema.element, `${path}[]`, next, out);
  if (schema instanceof z.ZodSet) return walk(schema._def.valueType, `${path}[]`, next, out);
  if (schema instanceof z.ZodTuple) {
    for (const item of schema.items as readonly unknown[]) walk(item, `${path}[]`, next, out);
    const rest: unknown = schema._def.rest;
    if (rest) walk(rest, `${path}[]`, next, out);
    return;
  }
  if (schema instanceof z.ZodRecord || schema instanceof z.ZodMap) {
    walk(schema.keySchema, `${path}{key}`, next, out);
    walk(schema.valueSchema, `${path}{}`, next, out);
    return;
  }
  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    for (const option of schema.options as readonly unknown[]) walk(option, path, next, out);
    return;
  }
  if (schema instanceof z.ZodIntersection) {
    walk(schema._def.left, path, next, out);
    walk(schema._def.right, path, next, out);
    return;
  }
  if (schema instanceof z.ZodObject) {
    const def = schema._def as { unknownKeys: string; catchall: unknown };
    if (def.unknownKeys === 'passthrough' || !(def.catchall instanceof z.ZodNever)) {
      out.push({ path: path ? `${path}.*` : '*', kind: 'open' });
    }
    for (const [key, field] of Object.entries(schema.shape as Record<string, unknown>)) {
      walk(field, path ? `${path}.${key}` : key, next, out);
    }
    return;
  }
  const name = (schema as { constructor?: { name?: string } } | null)?.constructor?.name;
  out.push({ path, kind: 'unreadable', detail: name ?? typeof schema });
}

/**
 * Every path in `schema` that can store an arbitrary string, with what kind of place it is.
 * Two branches of a union reaching the same path with the same kind are one row.
 */
export function paramStringPaths(schema: unknown): ParamStringRow[] {
  const rows: ParamStringRow[] = [];
  walk(schema, '', 0, rows);
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.path}|${row.kind}|${row.detail ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The string path an `idRefs` entry stores its id(s) at, in this module's spelling: where the
 * walker must find a 'string' row for the declaration to be real.
 */
export function idRefStringPath(ref: { path: string; shape: string }): string {
  if (ref.shape === 'ref') return `${ref.path}.node`;
  if (ref.shape === 'idList') return `${ref.path}[]`;
  return ref.path;
}
