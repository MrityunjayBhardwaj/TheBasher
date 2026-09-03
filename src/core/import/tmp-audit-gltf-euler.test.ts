// AUDIT — does the glTF embedded-animation road carry the #867 defect?
// Same instrument: interpolated travel between two keys vs the endpoint
// distance. A ratio far from 1 means the sampler walks the long way.
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Euler, Quaternion } from 'three';
import { buildGltfImportOps } from './gltfImportChain';

const DEG = Math.PI / 180;
const q = (degs: readonly number[]) =>
  new Quaternion().setFromEuler(new Euler(degs[0] * DEG, degs[1] * DEG, degs[2] * DEG, 'XYZ'));
const lerp = (a: readonly number[], b: readonly number[], u: number) =>
  a.map((v, i) => v + (b[i] - v) * u);

describe('AUDIT — glTF embedded clips', () => {
  it('counts discontinuities in imported TransformClip rotation tracks', async () => {
    const file = process.env.ASSET!;
    const buf = readFileSync(resolve(process.cwd(), file));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const res = await buildGltfImportOps({ buffer: ab, assetRef: file } as never, { nodes: {}, outputs: {} } as never);
    const ops = (res as { ops?: unknown[] }).ops ?? (res as unknown as unknown[]);
    const clips = (ops as Array<{ nodeType?: string; params?: Record<string, unknown> }>)
      .filter((o) => o.nodeType === 'TransformClip');
    console.log(`${file}: TransformClip nodes = ${clips.length}`);

    let checked = 0, bad = 0, worstRatio = 0, worstDesc = '';
    for (const c of clips) {
      // GROUP BY targetNodeId first — the sampler does (TransformClip.groupByTarget),
      // and a flat scan would compare keys belonging to DIFFERENT bones.
      const flat = c.params!.keyframes as Array<{ targetNodeId: string; time: number; rotation: number[] }>;
      const tracks: Record<string, Array<{ time: number; rotation: number[] }>> = {};
      for (const k of flat ?? []) (tracks[k.targetNodeId] ??= []).push(k);
      for (const [name, rawKeys] of Object.entries(tracks)) {
        if (!Array.isArray(rawKeys)) continue;
        const keys = [...rawKeys].filter((k) => k?.rotation).sort((a, b) => a.time - b.time);
        for (let i = 1; i < keys.length; i++) {
          checked++;
          const a = keys[i - 1].rotation, b = keys[i].rotation;
          const endpoints = 2 * Math.acos(Math.min(1, Math.abs(q(a).dot(q(b))))) * (180 / Math.PI);
          let travelled = 0; let prev = q(a);
          for (let s = 1; s <= 24; s++) {
            const cur = q(lerp(a, b, s / 24));
            travelled += 2 * Math.acos(Math.min(1, Math.abs(prev.dot(cur)))) * (180 / Math.PI);
            prev = cur;
          }
          const ratio = endpoints > 1e-6 ? travelled / endpoints : (travelled > 1 ? Infinity : 1);
          if (travelled - endpoints > 30) {
            bad++;
            if (ratio > worstRatio) { worstRatio = ratio; worstDesc = `${name} key${i} endpoints=${endpoints.toFixed(1)}° travelled=${travelled.toFixed(1)}°`; }
          }
        }
      }
    }
    console.log(`  intervals checked = ${checked}`);
    console.log(`  DISCONTINUITIES (travel exceeds endpoints by >30°) = ${bad}`);
    if (bad) console.log(`  worst: ${worstDesc}`);
  });
});
