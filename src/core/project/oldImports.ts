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
// REF: src/app/boot.ts (`hydrateLoadedProject`, the one door every loaded project goes through);
//      src/app/asset/exampleAssets.test.ts (no bundled example holds one); issue #1424.

/** Node types only an import saved on the old imported-file structure holds. */
export const OLD_IMPORT_NODE_TYPES: readonly string[] = ['GltfAsset', 'GltfData', 'GltfSkeleton'];

interface NodeLike {
  readonly type: string;
  readonly params?: unknown;
}

/** The file name of each old-structure import in `nodes`, once per file, in first-seen order. */
export function oldImportFiles(nodes: Readonly<Record<string, NodeLike>>): string[] {
  const files: string[] = [];
  for (const node of Object.values(nodes)) {
    if (!OLD_IMPORT_NODE_TYPES.includes(node.type)) continue;
    const ref = (node.params as { assetRef?: unknown } | undefined)?.assetRef;
    const file = typeof ref === 'string' && ref ? (ref.split('/').pop() ?? ref) : 'an unnamed file';
    if (!files.includes(file)) files.push(file);
  }
  return files;
}

/** Thrown for a project that holds an old-structure import. `files` names them. */
export class OldImportRefusal extends Error {
  readonly files: readonly string[];
  constructor(projectName: string, files: readonly string[]) {
    const list = files.map((f) => `"${f}"`).join(', ');
    super(
      `"${projectName}" cannot be opened: it holds ${files.length === 1 ? 'an import' : `${files.length} imports`} ` +
        `saved on the old imported-file structure (${list}), which this version no longer reads. ` +
        `Import ${files.length === 1 ? 'the file' : 'the files'} again in a new project; ` +
        `the edits made on ${files.length === 1 ? 'it' : 'them'} in this project are not carried over.`,
    );
    this.name = 'OldImportRefusal';
    this.files = files;
  }
}

/** Throws an {@link OldImportRefusal} when `project` holds an old-structure import. */
export function refuseOldImports(project: {
  readonly name: string;
  readonly state: { readonly nodes: Readonly<Record<string, NodeLike>> };
}): void {
  const files = oldImportFiles(project.state.nodes);
  if (files.length > 0) throw new OldImportRefusal(project.name, files);
}
