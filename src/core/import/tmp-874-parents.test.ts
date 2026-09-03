import { describe, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import type { GltfSkinMetadata } from '../../nodes/types';
describe('parents', () => { it('dump', async () => {
  const glb = readFileSync(process.env.GLB!);
  const { json, bin } = parseGltfContainer(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer);
  const buffers = await resolveBuffers(json, bin);
  const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
  const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
  const t = projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);
  writeFileSync(process.env.OUT!, JSON.stringify(t.bones.map((b) => b.parent)));
}); });
