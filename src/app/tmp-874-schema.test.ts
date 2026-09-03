import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SceneBundleSchema } from './sceneBundle';
describe('corrected bundle', () => {
  it('passes the schema the Open Scene path uses', () => {
    const raw = JSON.parse(readFileSync(process.env.FILE!, 'utf8'));
    const parsed = SceneBundleSchema.parse(raw);
    const nodes = (parsed as { state: { nodes: Record<string, unknown> } }).state.nodes;
    console.log(`OK — name=${(parsed as { name: string }).name} nodes=${Object.keys(nodes).length}`);
    expect(Object.keys(nodes).length).toBe(84);
  });
});
