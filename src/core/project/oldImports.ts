// #1424 — a project holding an import saved on the old imported-file structure is refused.
//
// That structure (a `GltfAsset` drawing a copy of the file, a `GltfData` per mesh child, a
// `GltfSkeleton` per skin) has had no renderer since #1053 and no importer since #1421. Until
// #1424 every load converted such an import to native nodes; the converter is retired, so nothing
// can draw one or carry its edits forward. Opening the project anyway would show a scene with its
// imports missing and no way to get them back, so the project is refused whole, by name, and the
// message says what to do (user decision, 2026-10-02).
//
// The three node types stay registered so a project holding them still parses: that is what lets
// the refusal name the project and its files, and lets Home keep listing it so it can be deleted.
//
// #1243 — a type that only ever sat BESIDE an old import is retired outright (`RETIRED_NODE_TYPES`).
// Node migration passes it through untouched rather than failing on an unknown type, so a project
// holding one still reaches this refusal and is named; one holding it alone is refused too.
//
// REF: src/app/boot.ts (`hydrateLoadedProject`, the one door every loaded project goes through);
//      src/app/asset/exampleAssets.test.ts (no bundled example holds one); issue #1424.

/** Node types only an import saved on the old imported-file structure holds. */
export const OLD_IMPORT_NODE_TYPES: readonly string[] = ['GltfAsset', 'GltfData', 'GltfSkeleton'];

/**
 * #1243 — node types retired from the registry that only ever existed beside an old-structure
 * import, so a project holding one is refused, never read. `PoseOverride` was the clone road's
 * hand-pose: its only author anchored it on a retarget over a `GltfSkeleton`, and a native
 * character is hand-posed through a pose layer (#1244).
 */
export const RETIRED_NODE_TYPES: readonly string[] = ['PoseOverride'];

interface NodeLike {
  readonly type: string;
  readonly params?: unknown;
  readonly inputs?: unknown;
}

/** The file `node` names in its own `assetRef`, if any. */
function ownFile(node: NodeLike): string | undefined {
  const ref = (node.params as { assetRef?: unknown } | undefined)?.assetRef;
  return typeof ref === 'string' && ref ? (ref.split('/').pop() ?? ref) : undefined;
}

/**
 * #1458 — the file an old-structure node belongs to. A `GltfSkeleton` names no file of its own: it
 * reads its file through its `asset` edge, from the `GltfAsset` that names it. A node whose edges
 * reach no named old-structure node belongs to no file anyone can name.
 */
function fileOf(nodes: Readonly<Record<string, NodeLike>>, start: NodeLike): string | undefined {
  const seen = new Set<NodeLike>();
  for (let node: NodeLike | undefined = start; node && !seen.has(node); ) {
    seen.add(node);
    if (!OLD_IMPORT_NODE_TYPES.includes(node.type)) return undefined;
    const own = ownFile(node);
    if (own) return own;
    const edge: unknown = (node.inputs as { asset?: { node?: unknown } } | undefined)?.asset?.node;
    node = typeof edge === 'string' ? nodes[edge] : undefined;
  }
  return undefined;
}

/** The file name of each old-structure import in `nodes`, once per file, in first-seen order. */
export function oldImportFiles(nodes: Readonly<Record<string, NodeLike>>): string[] {
  const files: string[] = [];
  for (const node of Object.values(nodes)) {
    if (!OLD_IMPORT_NODE_TYPES.includes(node.type)) continue;
    const file = fileOf(nodes, node) ?? 'an unnamed file';
    if (!files.includes(file)) files.push(file);
  }
  return files;
}

/** The retired node types `nodes` holds, once each, in first-seen order. */
export function retiredNodeTypes(nodes: Readonly<Record<string, NodeLike>>): string[] {
  const types: string[] = [];
  for (const node of Object.values(nodes)) {
    if (RETIRED_NODE_TYPES.includes(node.type) && !types.includes(node.type)) types.push(node.type);
  }
  return types;
}

/** Thrown for a project that holds an old-structure import. `files` names them; `retired` names
 *  the retired node types it holds, which on their own are the reason when there is no file. */
export class OldImportRefusal extends Error {
  readonly files: readonly string[];
  readonly retired: readonly string[];
  constructor(projectName: string, files: readonly string[], retired: readonly string[] = []) {
    const list = files.map((f) => `"${f}"`).join(', ');
    super(
      files.length > 0
        ? `"${projectName}" cannot be opened: it holds ${files.length === 1 ? 'an import' : `${files.length} imports`} ` +
            `saved on the old imported-file structure (${list}), which this version no longer reads. ` +
            `Import ${files.length === 1 ? 'the file' : 'the files'} again in a new project; ` +
            `the edits made on ${files.length === 1 ? 'it' : 'them'} in this project are not carried over.`
        : `"${projectName}" cannot be opened: it holds ${retired.map((t) => `a ${t} node`).join(' and ')} ` +
            `from the old imported-file structure, which this version no longer reads.`,
    );
    this.name = 'OldImportRefusal';
    this.files = files;
    this.retired = retired;
  }
}

/** Throws an {@link OldImportRefusal} when `project` holds an old-structure import or a node type
 *  retired with that structure. */
export function refuseOldImports(project: {
  readonly name: string;
  readonly state: { readonly nodes: Readonly<Record<string, NodeLike>> };
}): void {
  const files = oldImportFiles(project.state.nodes);
  const retired = retiredNodeTypes(project.state.nodes);
  if (files.length > 0 || retired.length > 0) {
    throw new OldImportRefusal(project.name, files, retired);
  }
}
