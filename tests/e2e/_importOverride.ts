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
// #1451 — an import has no wrapper Group any more: its root stands in the scene itself. So the
// override goes between the scene and the root, on the scene's own `children` edge, and wraps the
// whole import whichever road it took. `importRoots` looks through the override to the root.
//
// REF: tests/e2e/_importedMesh.ts (`importRoots`), src/nodes/MaterialOverride.ts (the `target`
//      socket); issues #1072, #99.

import type { Page } from '@playwright/test';
import { importRoots, type ImportRoad } from './_importedMesh';

/** What was wrapped: the import root (now under the override), the scene holding it, and the road. */
export interface WrappedImport {
  readonly rootId: string;
  /** The node under the override — the root itself. */
  readonly contentId: string;
  readonly sceneId: string;
  readonly road: ImportRoad;
}

/**
 * Insert a `MaterialOverride` called `overrideId` between the scene and its ONE import root, in a
 * single atomic, through the op path the app uses. Throws when there is not exactly one import
 * root: a spec that stages more has to say which.
 */
export async function wrapImportInOverride(
  page: Page,
  overrideId: string,
  params: Record<string, unknown>,
): Promise<WrappedImport> {
  const roots = await importRoots(page);
  if (roots.length !== 1) throw new Error(`expected one import root, found ${roots.length}`);
  const [{ rootId, road }] = roots;
  const sceneId = await page.evaluate(
    ({ rootId, overrideId, params }) => {
      type Ref = { node: string; socket: string };
      const dag = (
        window as unknown as {
          __basher_dag: {
            getState: () => {
              state: {
                nodes: Record<string, { inputs: Record<string, unknown> }>;
                outputs: { scene?: { node: string } };
              };
              dispatchAtomic: (ops: unknown[], source: string, label: string) => void;
            };
          };
        }
      ).__basher_dag.getState();
      const scene = dag.state.outputs.scene!.node;
      const children = dag.state.nodes[scene].inputs.children as Ref[] | undefined;
      if (!children?.some((c) => c.node === rootId))
        throw new Error(`import root ${rootId} is not the scene's own child`);
      const content = rootId;
      dag.dispatchAtomic(
        [
          {
            type: 'disconnect',
            from: { node: content, socket: 'out' },
            to: { node: scene, socket: 'children' },
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
            to: { node: scene, socket: 'children' },
          },
        ],
        'user',
        `e2e wrap import in ${overrideId}`,
      );
      return scene;
    },
    { rootId, overrideId, params },
  );
  return { rootId, contentId: rootId, sceneId, road };
}

/**
 * Take the override back out: the scene holds the root directly again. The override node is left
 * in the graph, disconnected, exactly as the specs that predate this helper left it.
 */
export async function unwrapImportOverride(page: Page, wrapped: WrappedImport, overrideId: string) {
  await page.evaluate(
    ({ sceneId, contentId, overrideId }) => {
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
              to: { node: sceneId, socket: 'children' },
            },
            {
              type: 'disconnect',
              from: { node: contentId, socket: 'out' },
              to: { node: overrideId, socket: 'target' },
            },
            {
              type: 'connect',
              from: { node: contentId, socket: 'out' },
              to: { node: sceneId, socket: 'children' },
            },
          ],
          'user',
          `e2e unwrap ${overrideId}`,
        );
    },
    { sceneId: wrapped.sceneId, contentId: wrapped.contentId, overrideId },
  );
}
