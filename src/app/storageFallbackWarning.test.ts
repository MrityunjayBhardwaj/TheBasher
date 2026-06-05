import { describe, expect, it } from 'vitest';
import { storageFallbackWarning } from './boot';

describe('storageFallbackWarning (#148)', () => {
  it('warns (sticky) when storage fell back to memory', () => {
    const w = storageFallbackWarning('memory');
    expect(w).not.toBeNull();
    expect(w!.severity).toBe('warn');
    expect(w!.durationMs).toBe(0); // sticky — must not auto-dismiss
    expect(w!.message.toLowerCase()).toContain("won't be saved");
  });

  it('is silent for durable backends', () => {
    expect(storageFallbackWarning('opfs')).toBeNull();
    expect(storageFallbackWarning('indexeddb')).toBeNull();
    expect(storageFallbackWarning('tauri-fs')).toBeNull();
  });
});
