// `cacheCensus` — every production call to a function that takes an evaluator cache, and what
// that call hands it (#1386).
//
// ── WHY THE CHECKER AND NOT A GREP ─────────────────────────────────────────────────────
//
// Whether a pure node costs once per graph change or once per frame is decided by the CALLER:
// the resolvers take `cache?` optionally, so a call that omits it typechecks and reads as
// correct (#1314 — one such call made an example run at 6 fps). A name- or grep-based census
// misses what matters here: a call through an alias, an options bag that spreads a caller's
// options, a cache that is `undefined` on some paths. So every call is resolved to its
// declaration by the TypeScript checker, and the argument is classified by its TYPE:
//
//   pass     — the argument is definitely an `EvaluatorCache`.
//   forward  — it may be `undefined`, inside a function that itself takes a cache (the caller's
//              own optional `cache` handed on). Not a gap: the gap, if any, is wherever the
//              chain starts, and that start is its own row.
//   orphan   — it may be `undefined`, but nothing around the call took a cache: a local that
//              is `undefined` on some path. That IS a start, so it counts as an origin.
//   none     — no cache reaches the callee (argument absent, `undefined`, or a bag without one).
//   fresh    — a cache made inline (`createEvaluatorCache()` or any call returning one), which
//              dies with the call.
//
// `orphan`, `none` and `fresh` are ORIGIN sites: the places a walk starts with nothing held. The
// gate
// (`src/core/dag/evaluatorCache.gate.test.ts`) pins them, each with a reason.
//
// Lives in `tools/` for the reason `sourceFiles.ts` gives: node types, typechecked, and
// registers no tests when imported.
//
// REF: src/core/dag/evaluator.ts (`EvaluatorCache`, `createEvaluatorCache`, `EvaluateOptions`);
//      tools/gates/sourceFiles.ts (the production file set); issues #1314 #1318 #1386.

import { join, relative } from 'node:path';
import ts from 'typescript';
import { sourceFiles } from './sourceFiles';

const ROOT = join(__dirname, '../..');

export type CacheArg = 'pass' | 'forward' | 'orphan' | 'none' | 'fresh';

/** A function that takes a cache, and where it takes it. */
export interface CacheTaker {
  name: string;
  file: string;
  /** Parameter index. */
  index: number;
  /** `positional`: the parameter IS the cache. `bag`: the parameter is an object with `cache`. */
  shape: 'positional' | 'bag';
}

export interface CacheCall {
  file: string;
  /** Nearest named enclosing function, method, class or variable (`<module>` at top level). */
  enclosing: string;
  callee: string;
  line: number;
  arg: CacheArg;
}

export interface CacheCensus {
  takers: CacheTaker[];
  calls: CacheCall[];
}

/** Production files the census reads: `sourceFiles()` minus local `tmp-*` scratch files. */
function productionFiles(): string[] {
  return sourceFiles()
    .map(([rel]) => rel)
    .filter((rel) => !/(^|\/)tmp-[^/]*$/.test(rel))
    .map((rel) => join(ROOT, rel));
}

function compilerOptions(): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(ROOT, 'tsconfig.app.json'),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  );
  if (!parsed) throw new Error('cacheCensus: could not read tsconfig.app.json');
  return { ...parsed.options, noEmit: true };
}

/**
 * Run the census. `extra` adds in-memory files (absolute path → text) to the program; the
 * gate's controls use it to prove a new call is seen without writing into `src/`.
 */
export function runCacheCensus(extra: Record<string, string> = {}): CacheCensus {
  const roots = [...productionFiles(), ...Object.keys(extra)];
  const options = compilerOptions();
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (f) => extra[f] ?? readFile(f);
  host.fileExists = (f) => f in extra || fileExists(f);
  host.getSourceFile = (f, lang, onError, create) =>
    f in extra
      ? ts.createSourceFile(f, extra[f], lang, true)
      : getSourceFile(f, lang, onError, create);
  const program = ts.createProgram(roots, options, host);
  const checker = program.getTypeChecker();
  const rootSet = new Set(roots);
  const sources = program.getSourceFiles().filter((sf) => rootSet.has(sf.fileName));
  const rel = (sf: ts.SourceFile) => relative(ROOT, sf.fileName);

  const isCache = (type: ts.Type): boolean => {
    const sym = type.aliasSymbol ?? type.getSymbol();
    if (!sym || sym.getName() !== 'EvaluatorCache') return false;
    return (sym.declarations ?? []).some((d) =>
      d.getSourceFile().fileName.endsWith('/src/core/dag/evaluator.ts'),
    );
  };
  const nonNullable = (type: ts.Type) => checker.getNonNullableType(type);
  const mayBeUndefined = (type: ts.Type) =>
    type.isUnion()
      ? type.types.some((t) => t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void))
      : !!(type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any));
  const cacheProp = (type: ts.Type): ts.Symbol | undefined => {
    const t = nonNullable(type);
    if (t.isUnion()) return undefined;
    return t.getProperty('cache');
  };

  // ── 1. Who takes a cache ──────────────────────────────────────────────────────────────
  const takers = new Map<ts.Node, CacheTaker>();
  const nameOf = (fn: ts.SignatureDeclaration): string => {
    if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
    const p = fn.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
    return '<anonymous>';
  };
  for (const sf of sources) {
    const visit = (node: ts.Node) => {
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node)) &&
        nameOf(node) !== '<anonymous>'
      ) {
        node.parameters.forEach((param, index) => {
          if (takers.has(node)) return;
          const type = checker.getTypeAtLocation(param);
          if (isCache(nonNullable(type))) {
            takers.set(node, { name: nameOf(node), file: rel(sf), index, shape: 'positional' });
            return;
          }
          const prop = cacheProp(type);
          if (prop && isCache(nonNullable(checker.getTypeOfSymbolAtLocation(prop, param)))) {
            takers.set(node, { name: nameOf(node), file: rel(sf), index, shape: 'bag' });
          }
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // ── 2. Every call to one, and what it hands over ──────────────────────────────────────
  const isFreshCache = (expr: ts.Expression): boolean => {
    const e = ts.skipPartiallyEmittedExpressions(expr);
    return ts.isCallExpression(e) && isCache(nonNullable(checker.getTypeAtLocation(e)));
  };
  const classifyValue = (expr: ts.Expression | undefined, type: ts.Type | undefined): CacheArg => {
    if (!expr || !type) return 'none';
    if (isFreshCache(expr)) return 'fresh';
    if (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return 'none';
    if (!isCache(nonNullable(type))) return 'none';
    return mayBeUndefined(type) ? 'forward' : 'pass';
  };
  const classifyBag = (arg: ts.Expression | undefined): CacheArg => {
    if (!arg) return 'none';
    if (ts.isObjectLiteralExpression(arg)) {
      const own = arg.properties.find(
        (p) => p.name && ts.isIdentifier(p.name) && p.name.text === 'cache',
      );
      if (own && ts.isPropertyAssignment(own) && isFreshCache(own.initializer)) return 'fresh';
      if (own && ts.isPropertyAssignment(own))
        return classifyValue(own.initializer, checker.getTypeAtLocation(own.initializer));
      if (own && ts.isShorthandPropertyAssignment(own))
        return classifyValue(own.name, checker.getTypeAtLocation(own.name));
    }
    const prop = cacheProp(checker.getTypeAtLocation(arg));
    if (!prop) return 'none';
    const propType = checker.getTypeOfSymbolAtLocation(prop, arg);
    if (!isCache(nonNullable(propType))) return 'none';
    const optional = !!(prop.flags & ts.SymbolFlags.Optional) || mayBeUndefined(propType);
    return optional ? 'forward' : 'pass';
  };
  /** True when some function around `node` is itself a cache taker (so it has one to hand on). */
  const insideTaker = (node: ts.Node): boolean => {
    for (let n = node.parent; n; n = n.parent) if (takers.has(n)) return true;
    return false;
  };
  const enclosingName = (node: ts.Node): string => {
    for (let n = node.parent; n; n = n.parent) {
      if (
        (ts.isFunctionDeclaration(n) ||
          ts.isMethodDeclaration(n) ||
          ts.isArrowFunction(n) ||
          ts.isFunctionExpression(n)) &&
        nameOf(n) !== '<anonymous>'
      )
        return nameOf(n);
      if (ts.isClassDeclaration(n) && n.name) return n.name.text;
    }
    return '<module>';
  };

  const calls: CacheCall[] = [];
  for (const sf of sources) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const decl = checker.getResolvedSignature(node)?.getDeclaration();
        const taker = decl ? takers.get(decl) : undefined;
        if (taker) {
          const argExpr = node.arguments[taker.index];
          const raw =
            taker.shape === 'positional'
              ? classifyValue(argExpr, argExpr && checker.getTypeAtLocation(argExpr))
              : classifyBag(argExpr);
          const arg = raw === 'forward' && !insideTaker(node) ? 'orphan' : raw;
          calls.push({
            file: rel(sf),
            enclosing: enclosingName(node),
            callee: taker.name,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            arg,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return { takers: [...takers.values()], calls };
}

/** Origin sites — `orphan`, `none` and `fresh` — grouped as `file · enclosing → callee` with a count. */
export function originSites(census: CacheCensus): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of census.calls) {
    if (c.arg === 'pass' || c.arg === 'forward') continue;
    const key = `${c.file} · ${c.enclosing} → ${c.callee}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}
