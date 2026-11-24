// Every part of a project and the licence it carries (#1722) — ONE pure function that the export
// warning, and any agent road that exports, both ask. UI == agent: there is no second list.
//
//     licenceReport(state, importLicence) → { parts, notCleared }
//
// WHAT COUNTS AS A PART — every node that brings in something somebody else made:
//   - a `MotionGenerate`: the checkpoint it runs (`params.model`), named by the clip it fills;
//   - a `ModelGenerate`: the provider that answers (`params.provider`);
//   - a `ComfyUIWorkflow`: every model file its imported graph loads, or its preset's when it has
//     no imported graph;
//   - an asset a node references by path — a glTF (`GltfAsset`/`GltfData` `assetRef`), a media
//     clip (`MediaClip.src`), an environment map (the Scene's `envSource.assetRef`).
//
// WHERE AN ASSET'S LICENCE COMES FROM: a bundled sample's from the catalog (static); anything else
// from `importLicence`, which the caller fills from the records stored beside the asset in the
// store (a kept generation's `generation.json`) — async reads this pure function must not make.
// A path neither answers is an import from outside: UNKNOWN, never allowed.
//
// 🔴 THE LIST IS THE WHOLE PROJECT, not only what the current export draws. Narrowing it to "what
// this render reaches" would need the render's own reachability, and a part dropped by a wrong
// reachability rule is a non-commercial part exported without a word. Over-listing costs a
// director one extra line to read; under-listing costs them a licence breach.
//
// KNOWN GAP: a BVH/FBX motion import leaves no reference in the project (`persistsRefAs: null`,
// importFormats.ts), so an imported motion cannot be listed here until it does.
//
// REF: src/core/licensing/licence.ts (the vocabulary); src/app/asset/catalog.ts (sample licences);
//      src/app/licence/assetLicences.ts (the async half); issue #1722.

import type { DagState } from '../../core/dag/state';
import type { Node } from '../../core/dag/types';
import {
  commercialAllowed,
  licenceOfModel,
  licenceOfProvider,
  providerLabel,
  UNKNOWN_IMPORT_LICENCE,
  type Licence,
} from '../../core/licensing/licence';
import { comfyModelNames } from '../../core/comfy/comfyModels';
import { ASSET_CATALOG } from '../asset/catalog';
import { USER_IMPORTS_ROOT } from '../asset/importCommon';
import { nodeDisplayName } from '../sceneTreeWalk';

/** What brought the part in, as the warning says it. */
export type LicencePartSource =
  | 'motion-generator'
  | 'model-generator'
  | 'comfyui-workflow'
  | 'sample'
  | 'import';

export const PART_SOURCE_LABEL: Record<LicencePartSource, string> = {
  'motion-generator': 'Motion generator',
  'model-generator': 'Model generator',
  'comfyui-workflow': 'ComfyUI workflow',
  sample: 'Sample',
  import: 'Imported',
};

export interface LicencePart {
  /** The node that brings it in. */
  readonly nodeId: string;
  /** What the director calls it — the clip, the asset, the workflow. */
  readonly asset: string;
  readonly source: LicencePartSource;
  /** The checkpoint, provider or file whose terms apply; null for a plain asset. */
  readonly model: string | null;
  /** The asset's storage path, for a part that is a file; null for a generator. */
  readonly path: string | null;
  readonly licence: Licence;
}

export interface LicenceReport {
  /** Every part, in node order. */
  readonly parts: readonly LicencePart[];
  /** The parts a commercial export must list: commercial use is `no` or `unknown`. */
  readonly notCleared: readonly LicencePart[];
}

/** The licence of an asset outside the bundled samples, when a record beside it says. */
export type ImportLicenceLookup = (assetRef: string) => Licence | undefined;

const SAMPLE_BY_PATH = new Map(ASSET_CATALOG.map((c) => [c.path, c]));

/** `user-imports/<folder>/...` → `<folder>`; any other path → its file name. */
function assetLabel(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === USER_IMPORTS_ROOT && parts[1]) return parts[1];
  return parts[parts.length - 1] ?? path;
}

function assetPart(
  nodeId: string,
  path: string,
  importLicence: ImportLicenceLookup,
  name?: string,
): LicencePart {
  const sample = SAMPLE_BY_PATH.get(path);
  if (sample) {
    return {
      nodeId,
      asset: sample.name,
      source: 'sample',
      model: null,
      path,
      licence: sample.licence,
    };
  }
  return {
    nodeId,
    asset: name?.trim() || assetLabel(path),
    source: 'import',
    model: null,
    path,
    licence: importLicence(path) ?? UNKNOWN_IMPORT_LICENCE,
  };
}

/** The name of the clip a motion generator fills (the clip owns it, #1124), else the node's. */
function motionAssetName(state: DagState, producerId: string): string {
  for (const node of Object.values(state.nodes)) {
    const source = node.inputs.source;
    const fed = Array.isArray(source)
      ? source.some((r) => r.node === producerId)
      : source?.node === producerId;
    if (node.type === 'AnimationClip' && fed) {
      return nodeDisplayName(state.nodes, node.id);
    }
  }
  return nodeDisplayName(state.nodes, producerId);
}

function partsOfNode(
  state: DagState,
  node: Node,
  importLicence: ImportLicenceLookup,
): LicencePart[] {
  const params = (node.params ?? {}) as Record<string, unknown>;
  switch (node.type) {
    case 'MotionGenerate': {
      const model = typeof params.model === 'string' ? params.model : '';
      return [
        {
          nodeId: node.id,
          asset: motionAssetName(state, node.id),
          source: 'motion-generator',
          model,
          path: null,
          licence: licenceOfModel(model),
        },
      ];
    }
    case 'ModelGenerate': {
      const provider = typeof params.provider === 'string' ? params.provider : '';
      return [
        {
          nodeId: node.id,
          asset: nodeDisplayName(state.nodes, node.id),
          source: 'model-generator',
          model: providerLabel(provider),
          path: null,
          licence: licenceOfProvider(provider),
        },
      ];
    }
    case 'ComfyUIWorkflow': {
      const graph = params.graph as { apiJson?: unknown; meta?: { name?: unknown } } | null;
      // #1715 — every workflow node holds its file (the presets migrated to theirs at v31), so
      // the models are always read off the file.
      const models = graph?.apiJson ? comfyModelNames(graph.apiJson) : [];
      const named = typeof graph?.meta?.name === 'string' ? graph.meta.name : '';
      const asset = named.trim() || nodeDisplayName(state.nodes, node.id);
      return models.map((model) => ({
        nodeId: node.id,
        asset,
        source: 'comfyui-workflow' as const,
        model,
        path: null,
        licence: licenceOfModel(model),
      }));
    }
    case 'GltfAsset':
    case 'GltfData': {
      const ref = params.assetRef;
      return typeof ref === 'string' && ref ? [assetPart(node.id, ref, importLicence)] : [];
    }
    case 'MediaClip': {
      const src = params.src;
      const name = typeof params.name === 'string' ? params.name : undefined;
      return typeof src === 'string' && src ? [assetPart(node.id, src, importLicence, name)] : [];
    }
    case 'Scene': {
      const env = params.envSource as { kind?: unknown; assetRef?: unknown; name?: unknown };
      if (env?.kind !== 'file' || typeof env.assetRef !== 'string' || !env.assetRef) return [];
      const name = typeof env.name === 'string' ? env.name : undefined;
      return [assetPart(node.id, env.assetRef, importLicence, name)];
    }
    default:
      return [];
  }
}

/**
 * Every licensed part of the project, and the ones a commercial export must list first.
 *
 * One asset referenced by two nodes (a `GltfAsset` and its `GltfData`) is listed once: the
 * warning names assets, and the same file twice reads as two problems.
 */
export function licenceReport(state: DagState, importLicence: ImportLicenceLookup): LicenceReport {
  const parts: LicencePart[] = [];
  const seenAssets = new Set<string>();
  for (const node of Object.values(state.nodes)) {
    for (const part of partsOfNode(state, node, importLicence)) {
      if (part.path !== null) {
        if (seenAssets.has(part.path)) continue;
        seenAssets.add(part.path);
      }
      parts.push(part);
    }
  }
  return { parts, notCleared: parts.filter((p) => !commercialAllowed(p.licence)) };
}

/** The asset paths whose licence only a record in the store can answer — what the async half
 *  reads before calling `licenceReport`. Bundled samples are excluded: the catalog answers them. */
export function importedAssetRefs(state: DagState): string[] {
  const refs = new Set<string>();
  for (const node of Object.values(state.nodes)) {
    for (const part of partsOfNode(state, node, () => undefined)) {
      if (part.source === 'import' && part.path !== null) refs.add(part.path);
    }
  }
  return [...refs];
}
