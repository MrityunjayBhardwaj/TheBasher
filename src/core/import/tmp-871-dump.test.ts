import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { BONE_NAME_MAP_PRESETS } from './boneNameMaps';
describe('dump', () => {
  it('name map', () => {
    const p = BONE_NAME_MAP_PRESETS.find((x) => x.id === 'somaToMixamo')!;
    writeFileSync(process.env.OUT!, JSON.stringify(p.map, null, 1));
    console.log('pairs', Object.keys(p.map).length);
  });
});
