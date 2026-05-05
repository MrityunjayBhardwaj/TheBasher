import { describe, expect, it } from 'vitest';
import { MemoryStorage } from './MemoryStorage';
import { TauriStorage } from './TauriStorage';

describe('MemoryStorage', () => {
  it('round-trips bytes', async () => {
    const s = new MemoryStorage();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await s.write('a/b/c.bin', bytes);
    const read = await s.read('a/b/c.bin');
    expect(Array.from(read)).toEqual([1, 2, 3, 4, 5]);
  });

  it('exists is false before write, true after, false after delete', async () => {
    const s = new MemoryStorage();
    expect(await s.exists('x.txt')).toBe(false);
    await s.write('x.txt', new Uint8Array([0]));
    expect(await s.exists('x.txt')).toBe(true);
    await s.delete('x.txt');
    expect(await s.exists('x.txt')).toBe(false);
  });

  it('list returns immediate children only', async () => {
    const s = new MemoryStorage();
    await s.write('projects/a/project.json', new Uint8Array([1]));
    await s.write('projects/b/project.json', new Uint8Array([2]));
    await s.write('projects/c/extra/inner.txt', new Uint8Array([3]));
    const top = await s.list('projects');
    expect(top.sort()).toEqual(['a', 'b', 'c']);
  });

  it('delete is idempotent', async () => {
    const s = new MemoryStorage();
    await s.delete('missing.txt'); // no throw
    expect(await s.exists('missing.txt')).toBe(false);
  });
});

describe('TauriStorage', () => {
  it('reports unavailable in v0.5', async () => {
    expect(await new TauriStorage().isAvailable()).toBe(false);
  });

  it('throws "v0.6" on every method', async () => {
    const s = new TauriStorage();
    await expect(s.read('x')).rejects.toThrow(/v0\.6/);
    await expect(s.write('x', new Uint8Array())).rejects.toThrow(/v0\.6/);
    await expect(s.exists('x')).rejects.toThrow(/v0\.6/);
    await expect(s.delete('x')).rejects.toThrow(/v0\.6/);
    await expect(s.list('x')).rejects.toThrow(/v0\.6/);
    await expect(s.quota()).rejects.toThrow(/v0\.6/);
  });
});
