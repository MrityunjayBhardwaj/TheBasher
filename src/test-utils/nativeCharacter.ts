// The graph shape a native character import leaves (#393, #1213), for tests that need "a character
// in the scene" rather than a real import: a Skeleton, the armature Object standing it, a mesh Object
// whose Armature modifier deforms by that armature, and the import's root Group over both.
//
// It is exactly what `characterTargets` recognises as a character — a rig that deforms a mesh — and
// what the retarget mutator poses (the armature Object's `pose` edge), so a bind, a placement and a
// tie-break all find it the way they find a real import. It carries no geometry: tests that need a
// DRAWN character import a real file through `buildNativeGltfImportOps` instead.
//
// REF: src/app/asset/bindMotionToCharacter.ts (`characterTargets`); src/core/import/nativeGltfImport.ts
//      (the real import this mirrors); issues #1213, #1053.

import type { Op } from '../core/dag/types';

export interface NativeCharacterIds {
  readonly skeletonId: string;
  readonly armatureId: string;
  readonly modifierId: string;
  readonly meshId: string;
  readonly groupId: string;
}

/** The node ids a character built with `prefix` gets. */
export function nativeCharacterIds(prefix: string): NativeCharacterIds {
  return {
    skeletonId: `${prefix}_skel`,
    armatureId: `${prefix}_armature`,
    modifierId: `${prefix}_armature_mod`,
    meshId: `${prefix}_mesh`,
    groupId: `${prefix}_group`,
  };
}

/**
 * Ops that add a native character. Bones are a chain in the order given (each parented to the
 * first). With `sceneId`, the root Group hangs under that scene, as an import's does.
 */
export function nativeCharacterOps(opts: {
  readonly prefix: string;
  readonly bones: readonly string[];
  readonly sceneId?: string;
  readonly groupPosition?: readonly [number, number, number];
  readonly name?: string;
}): { ops: Op[]; ids: NativeCharacterIds } {
  const ids = nativeCharacterIds(opts.prefix);
  const name = opts.name ?? opts.prefix;
  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: ids.skeletonId,
      nodeType: 'Skeleton',
      params: {
        bones: opts.bones.map((b, i) => ({
          name: b,
          parent: i === 0 ? -1 : 0,
          position: [0, i === 0 ? 0 : 1, 0],
          rotation: [0, 0, 0],
        })),
      },
    },
    { type: 'addNode', nodeId: ids.armatureId, nodeType: 'Object', params: {} },
    { type: 'setMeta', nodeId: ids.armatureId, name },
    {
      type: 'connect',
      from: { node: ids.skeletonId, socket: 'out' },
      to: { node: ids.armatureId, socket: 'data' },
    },
    { type: 'addNode', nodeId: ids.modifierId, nodeType: 'ArmatureModifier', params: {} },
    {
      type: 'connect',
      from: { node: ids.armatureId, socket: 'out' },
      to: { node: ids.modifierId, socket: 'armature' },
    },
    { type: 'addNode', nodeId: ids.meshId, nodeType: 'Object', params: {} },
    {
      type: 'connect',
      from: { node: ids.modifierId, socket: 'out' },
      to: { node: ids.meshId, socket: 'data' },
    },
    {
      type: 'addNode',
      nodeId: ids.groupId,
      nodeType: 'Group',
      params: {
        position: [...(opts.groupPosition ?? [0, 0, 0])],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        pivot: [0, 0, 0],
      },
    },
    {
      type: 'connect',
      from: { node: ids.armatureId, socket: 'out' },
      to: { node: ids.groupId, socket: 'children' },
    },
    {
      type: 'connect',
      from: { node: ids.meshId, socket: 'out' },
      to: { node: ids.groupId, socket: 'children' },
    },
  ];
  if (opts.sceneId) {
    ops.push({
      type: 'connect',
      from: { node: ids.groupId, socket: 'out' },
      to: { node: opts.sceneId, socket: 'children' },
    });
  }
  return { ops, ids };
}
