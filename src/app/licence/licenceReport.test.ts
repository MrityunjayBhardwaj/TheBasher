// #1722 — the one list a commercial export reads. A non-commercial model is listed with the asset
// it made and the model's name; a project of permissive parts lists nothing; an unknown licence is
// listed as unknown, never allowed.

import {
  STYLIZED_REALISM_META,
  STYLIZED_REALISM_WORKFLOW,
} from '../../core/comfy/builtinWorkflows';
import { describe, expect, it } from 'vitest';
import type { DagState } from '../../core/dag/state';
import type { Node } from '../../core/dag/types';
import { aBlockedRecord } from '../../core/licensing/blockedModelForTests';
import { MODEL_RECORDS } from '../../core/licensing/allowedModels';
import { BASHER_MIT_LICENCE, type Licence } from '../../core/licensing/licence';
import { SD15_TEXT2IMG } from '../../core/comfy/starterGraphs';
import { importedAssetRefs, licenceReport } from './licenceReport';

function stateOf(...nodes: Node[]): DagState {
  const map: Record<string, Node> = {};
  for (const n of nodes) map[n.id] = n;
  return { nodes: map, outputs: {} };
}
const node = (
  id: string,
  type: string,
  params: Record<string, unknown>,
  inputs: Node['inputs'] = {},
): Node => ({ id, type, version: 1, params, inputs });

/** A motion generator and the clip it fills, the clip named `clipName`. */
function generatedMotion(model: string, clipName: string): Node[] {
  return [
    node('mg', 'MotionGenerate', { prompt: 'a walk', seed: 1, model }),
    node('clip', 'AnimationClip', { name: clipName }, { source: { node: 'mg', socket: 'out' } }),
  ];
}

const none = () => undefined;

/** The first record with a given verdict, derived — never a spelled id (the audit scans source). */
const recordWith = (verdict: string) => MODEL_RECORDS.find((r) => r.verdict === verdict)!;

describe('licenceReport', () => {
  it('lists a non-commercial model with the asset it made and the model name', () => {
    const blocked = aBlockedRecord();
    const checkpoint = blocked.name.split(',')[0]!.trim();
    const report = licenceReport(stateOf(...generatedMotion(checkpoint, 'Hero walk')), none);
    expect(report.notCleared).toHaveLength(1);
    const [part] = report.notCleared;
    expect(part!.asset).toBe('Hero walk');
    expect(part!.model).toBe(checkpoint);
    expect(part!.licence.commercial).toBe('no');
    expect(part!.licence.kind).toBe('non-commercial');
    expect(part!.licence.name).toBe(blocked.licence);
  });

  it('lists nothing when every part is free to use', () => {
    const allowed = recordWith('ALLOWED_WITH_CONDITIONS');
    const checkpoint = allowed.name.split(',')[0]!.trim();
    const report = licenceReport(
      stateOf(
        ...generatedMotion(checkpoint, 'Walk'),
        node('g', 'GltfAsset', { assetRef: 'assets/cube.gltf' }),
        node('d', 'GltfData', { assetRef: 'assets/cube.gltf' }),
      ),
      none,
    );
    expect(report.notCleared).toEqual([]);
    // The cube is listed ONCE though two nodes reference it, and credits the credit it owes.
    expect(report.parts.map((p) => p.asset)).toEqual(['Walk', 'Cube']);
    expect(report.parts[0]!.licence.credit).toBe(allowed.attribution);
  });

  it('lists an unrecorded checkpoint as unknown, never as allowed', () => {
    const report = licenceReport(
      stateOf(...generatedMotion('someone/never-recorded-v9', 'Mystery run')),
      none,
    );
    expect(report.notCleared).toHaveLength(1);
    expect(report.notCleared[0]!.licence.commercial).toBe('unknown');
    expect(report.notCleared[0]!.model).toBe('someone/never-recorded-v9');
  });

  it('lists an outside import as unknown unless a record beside it says otherwise', () => {
    const ref = 'user-imports/robot/robot.glb';
    const state = stateOf(node('g', 'GltfAsset', { assetRef: ref }));
    expect(importedAssetRefs(state)).toEqual([ref]);
    const unknown = licenceReport(state, none);
    expect(unknown.notCleared.map((p) => [p.asset, p.licence.commercial])).toEqual([
      ['robot', 'unknown'],
    ]);
    const recorded = licenceReport(state, (r) => (r === ref ? BASHER_MIT_LICENCE : undefined));
    expect(recorded.notCleared).toEqual([]);
  });

  it('lists a hosted generation service as unknown — its output terms depend on a plan Basher cannot see', () => {
    const report = licenceReport(
      stateOf(
        node('m', 'ModelGenerate', { provider: 'tripo-model-generation', prompt: 'a robot' }),
      ),
      none,
    );
    expect(report.notCleared).toHaveLength(1);
    expect(report.notCleared[0]!.licence.kind).toBe('provider-terms');
    expect(report.notCleared[0]!.licence.commercial).toBe('unknown');
    // The offline placeholder calls nothing and owes nothing.
    const stub = licenceReport(
      stateOf(node('m', 'ModelGenerate', { provider: 'stub-modelgen', prompt: 'a robot' })),
      none,
    );
    expect(stub.notCleared).toEqual([]);
  });

  it('names every model file a ComfyUI workflow file loads, the migrated preset’s included', () => {
    const imported = licenceReport(
      stateOf(
        node('c', 'ComfyUIWorkflow', {
          graph: { apiJson: SD15_TEXT2IMG, meta: { name: 'Toon pass' } },
        }),
      ),
      none,
    );
    expect(imported.parts.map((p) => [p.asset, p.model])).toEqual([
      ['Toon pass', 'v1-5-pruned-emaonly.safetensors'],
    ]);
    // #1715 — the old preset is a workflow file now; its models are read off the file.
    const preset = licenceReport(
      stateOf(
        node('c', 'ComfyUIWorkflow', {
          graph: { apiJson: STYLIZED_REALISM_WORKFLOW, meta: STYLIZED_REALISM_META },
        }),
      ),
      none,
    );
    expect(preset.parts.map((p) => p.model)).toEqual([
      'sd_xl_base_1.0.safetensors',
      'control_depth_xl.safetensors',
      'control_normal_xl.safetensors',
    ]);
    // None of them is recorded, so each is listed — unknown, never allowed.
    expect(preset.notCleared).toHaveLength(3);
    // A node with no file picked yet loads no model.
    expect(
      licenceReport(stateOf(node('c', 'ComfyUIWorkflow', { graph: null })), none).parts,
    ).toEqual([]);
  });

  it('lists an imported media clip and an imported environment map by their own names', () => {
    const credit: Licence = { ...BASHER_MIT_LICENCE };
    const report = licenceReport(
      stateOf(
        node('clip', 'MediaClip', { name: 'Intro plate', src: 'media/abc.png' }),
        node('scene', 'Scene', {
          envSource: { kind: 'file', assetRef: 'user-imports/sky/sky.hdr', name: 'Sky' },
        }),
      ),
      (r) => (r === 'user-imports/sky/sky.hdr' ? credit : undefined),
    );
    expect(report.parts.map((p) => [p.asset, p.licence.commercial])).toEqual([
      ['Intro plate', 'unknown'],
      ['Sky', 'yes'],
    ]);
  });
});
