// The e2e tier's ONE way to put a `MaterialOverride` over an import, and take it off again (#1072).
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────
//
// Six specs (p7.13, p124, p130, p131, p136, p198) each hand-rolled the same four ops: disconnect
// the import's content from its root `Group`, add the override, wire the content into the
// override's `target` and the override back into the Group. Each copy found "the content" as
// `nodes.find(type === 'GltfAsset')`, so when textured files started arriving as native geometry
// all six broke at once, each in its own copy (`Invalid op … from.node undefined`).
//
// The content is simply whatever the import root's `children` socket holds: a `GltfAsset` on the
// clone road, an `Object` over `PolyMeshData` on the native one. Reading it off the root's own
// edge answers both without asking which road the file took.
//
// REF: tests/e2e/_importedMesh.ts (`importRoots`), src/nodes/MaterialOverride.ts (the `target`
//      socket); issues #1072, #99.

import type { Page } from '@playwright/test';
import { importRoots, type ImportRoad } from './_importedMesh';

/** What was wrapped: the import root, the node now under the override, and the road. */
export interface WrappedImport {
  readonly rootId: string;
  readonly contentId: string;
  readonly road: ImportRoad;
}

/**
 * Insert a `MaterialOverride` called `overrideId` between the scene's ONE import root and its one
 * child, in a single atomic, through the op path the app uses. Throws when there is not exactly one
 * import with exactly one child: a spec that stages more has to say which.
 */
export async function wrapImportInOverride(
  page: Page,
  overrideId: string,
  params: Record<string, unknown>,
): Promise<WrappedImport> {
  const roots = await importRoots(page);
  if (roots.length !== 1) throw new Error(`expected one import root, found ${roots.length}`);
  const [{ rootId, road }] = roots;
  const contentId = await page.evaluate(
    ({ rootId, overrideId, params }) => {
      type Ref = { node: string; socket: string };
      const dag = (
        window as unknown as {
          __basher_dag: {
            getState: () => {
              state: { nodes: Record<string, { inputs: Record<string, unknown> }> };
              dispatchAtomic: (ops: unknown[], source: string, label: string) => void;
            };
          };
        }
      ).__basher_dag.getState();
      const children = dag.state.nodes[rootId]?.inputs.children as Ref[] | undefined;
      if (!Array.isArray(children) || children.length !== 1)
        throw new Error(`import root ${rootId} has ${children?.length ?? 0} children, expected 1`);
      const content = children[0].node;
      dag.dispatchAtomic(
        [
          {
            type: 'disconnect',
            from: { node: content, socket: 'out' },
            to: { node: rootId, socket: 'children' },
          },
          { type: 'addNode', nodeId: overrideId, nodeType: 'MaterialOverride', params },
          {
            type: 'connect',
            from: { node: content, socket: 'out' },
            to: { node: overrideId, socket: 'target' },
          },
          {
            type: 'connect',
            from: { node: overrideId, socket: 'out' },
            to: { node: rootId, socket: 'children' },
          },
        ],
        'user',
        `e2e wrap import in ${overrideId}`,
      );
      return content;
    },
    { rootId, overrideId, params },
  );
  return { rootId, contentId, road };
}

/**
 * Take the override back out: the root holds the content directly again. The override node is left
 * in the graph, disconnected, exactly as the specs that predate this helper left it.
 */
export async function unwrapImportOverride(page: Page, wrapped: WrappedImport, overrideId: string) {
  await page.evaluate(
    ({ rootId, contentId, overrideId }) => {
      (
        window as unknown as {
          __basher_dag: {
            getState: () => {
              dispatchAtomic: (ops: unknown[], source: string, label: string) => void;
            };
          };
        }
      ).__basher_dag
        .getState()
        .dispatchAtomic(
          [
            {
              type: 'disconnect',
              from: { node: overrideId, socket: 'out' },
              to: { node: rootId, socket: 'children' },
            },
            {
              type: 'disconnect',
              from: { node: contentId, socket: 'out' },
              to: { node: overrideId, socket: 'target' },
            },
            {
              type: 'connect',
              from: { node: contentId, socket: 'out' },
              to: { node: rootId, socket: 'children' },
            },
          ],
          'user',
          `e2e unwrap ${overrideId}`,
        );
    },
    { rootId: wrapped.rootId, contentId: wrapped.contentId, overrideId },
  );
}
