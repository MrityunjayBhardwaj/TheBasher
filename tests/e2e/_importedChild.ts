// The e2e tier's ONE answer to "which node is the imported glTF child called X?" (#389).
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────
//
// Twenty-eight specs each hand-rolled the same predicate inside their own
// `page.evaluate`: `nodes.find((n) => n.type === 'GltfChild' && n.params.childName === …)`,
// then reached into `n.params.materials` for the captured table. That is twenty-eight
// copies of one piece of knowledge, in the tier that is NOT typechecked (#472) and so
// cannot be told by the compiler when the knowledge goes stale.
//
// It went stale. #389 split the fused `GltfChild` into an ordinary `Object` (the pose)
// plus a `GltfData` (what the child IS), so the answer stopped being "read this node's
// params" and became "follow this Object's `data` input and read THAT node's params" —
// and the captured table stopped being `materials` and became the `material` +
// `materialSlots` pair. All twenty-eight broke at once, each in its own copy, and none
// of them loudly: a `.find()` that matches nothing returns `undefined`, so the failure
// surfaces several assertions later as `expected 0, received undefined`.
//
// Twenty-five of those now call this module. The other three asked a pure CENSUS question
// — "how many children did the import mint?" — which counts `GltfData` nodes directly and
// needs no hop, so routing them through here would have been ceremony. If that count ever
// needs the PAIR rather than the data half, `importedChildCount` below is where it belongs.
//
// ── WHY IT CALLS THE PRODUCT'S MODULE RATHER THAN RE-SPELLING THE HOP ────────────────
//
// `src/app/importedChild.ts` already owns this question for the thirteen production
// call sites. Re-spelling it here would be the fourteenth copy — the very thing that
// module was created to end — and it would be the copy nothing typechecks. So this
// asks the product, inside the page, exactly as the conformance matrix's baked row
// calls the real `dispatchApplyTransform` rather than synthesising a bake.
//
// That trade is sound because these are FIXTURE LOOKUPS, not subjects under test. A
// spec asserting something ABOUT the hop must not use this helper — it would be
// comparing the product with itself. No such spec exists today: every caller uses the
// lookup to reach a child it then asserts something else about.
//
// REF: src/app/importedChild.ts (the rule); src/core/import/gltfImportChain.ts (what
//      the import mints); issue #389.

import type { Page } from '@playwright/test';

/** One imported child, as the e2e tier needs to address it. */
export interface ImportedChildRow {
  /** The `Object` half — the id every clip target, channel and selection already uses. */
  readonly objectId: string;
  /** The `GltfData` half — where `assetRef`, `childName` and the captured material live. */
  readonly dataId: string;
  readonly childName: string;
  readonly assetRef: string;
  /**
   * The captured material table, flattened by the ONE rule (`materialSlots ?? [material]`).
   *
   * This is what the retired `params.materials` array held, and it is deliberately the
   * FLATTENED form rather than the raw pair: every one of the converted specs wanted
   * "slot i's captured material", which is what this is. A spec that needs to know how
   * the pair is SPELLED (single vs. multi-primitive) is asserting about the storage
   * shape and should read `dataId`'s params directly.
   */
  readonly slots: readonly unknown[];
}

/**
 * Every imported child currently in the DAG, optionally narrowed to one asset.
 *
 * Ordered by DAG node id so a spec that indexes into the result gets a stable answer
 * across runs — `Object.keys` order is insertion order here, which the import chain
 * fixes by glTF node index, but the specs that count children should not have to know
 * that. Specs that need a SPECIFIC child address it by name.
 */
export async function importedChildren(page: Page, assetRef?: string): Promise<ImportedChildRow[]> {
  return page.evaluate(async (ref) => {
    const mod = await import('/src/app/importedChild.ts');
    const w = window as unknown as {
      __basher_dag: { getState: () => { state: { nodes: Record<string, unknown> } } };
    };
    const nodes = w.__basher_dag.getState().state.nodes as Parameters<
      typeof mod.importedChildOf
    >[0];
    const out: ImportedChildRow[] = [];
    for (const id of Object.keys(nodes)) {
      const child = mod.importedChildOf(nodes, id);
      if (!child) continue;
      if (ref !== undefined && child.assetRef !== ref) continue;
      const dataId = mod.importedChildDataId(nodes, id)!;
      // No type argument: the module arrives through a runtime specifier Vite resolves
      // and TypeScript does not, so `importedChildMaterials` is untyped here and a
      // `<unknown>` on it is an error rather than a no-op. The cast is on the way out.
      const mats = mod.importedChildMaterials(nodes, id) as {
        slots: readonly unknown[];
      } | null;
      out.push({
        objectId: id,
        dataId,
        childName: child.childName,
        assetRef: child.assetRef,
        slots: mats ? mats.slots : [],
      });
    }
    return out;
  }, assetRef) as Promise<ImportedChildRow[]>;
}

/**
 * The imported child called `childName`, or `null`.
 *
 * ⚠️ FIRST MATCH, inheriting `findImportedChild`'s documented ambiguity: two assets can
 * both contain a child called `Cube`. A spec that stages more than one asset MUST pass
 * `assetRef`. The parameter is optional only because most specs stage exactly one.
 */
export async function importedChild(
  page: Page,
  childName: string,
  assetRef?: string,
): Promise<ImportedChildRow | null> {
  const all = await importedChildren(page, assetRef);
  return all.find((c) => c.childName === childName) ?? null;
}

/**
 * The first imported child that carries a captured material, or `null`.
 *
 * This is the shape the ingest-capture specs want: they import a one-mesh fixture and ask
 * what slot 0 captured. Under the fused kind they each spelled it
 * `nodes.find((n) => n.type === 'GltfChild' && Array.isArray(n.params.materials))` — the
 * `Array.isArray` being how they skipped bones and empties, which carry no material.
 *
 * ⚠️ The skip is the load-bearing half, not the find. A glTF's `json.nodes` includes bones
 * and empties, and `GltfData.material` is `null` for those by design (nullable, never
 * absent — a bone says "none" out loud). Dropping the filter would return whichever node
 * the import happened to mint first and read `undefined` off it, which is the same
 * `expected X, received null` these specs already fail with when the lookup misses.
 */
export async function firstMaterialChild(
  page: Page,
  assetRef?: string,
): Promise<ImportedChildRow | null> {
  const all = await importedChildren(page, assetRef);
  return all.find((c) => c.slots[0] != null) ?? null;
}

/**
 * How many imported children the DAG holds — the shape the census specs want.
 *
 * A named function rather than `(await importedChildren(page)).length` at each call site,
 * because that is the expression three specs got wrong in the same way once already: a
 * count taken before the import settles reads 0, which is indistinguishable from "the
 * import produced nothing". Callers should poll this, never read it once.
 */
export async function importedChildCount(page: Page, assetRef?: string): Promise<number> {
  return (await importedChildren(page, assetRef)).length;
}
