// #255 — the beforeunload guard's pure decision: block the unload (native
// "unsaved changes" prompt) iff the project is dirty, never when clean.
import { describe, expect, it, vi } from 'vitest';
import { beforeUnloadIfDirty } from './boot';

describe('beforeUnloadIfDirty', () => {
  it('blocks the unload when dirty (preventDefault + returnValue set)', () => {
    const e = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    const blocked = beforeUnloadIfDirty(e, true);
    expect(blocked).toBe(true);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(e.returnValue).toBe(''); // Chrome requires returnValue set to prompt
  });

  it('does nothing when clean — the user is not nagged with nothing to lose', () => {
    const e = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    const blocked = beforeUnloadIfDirty(e, false);
    expect(blocked).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(e.returnValue).toBeUndefined();
  });
});
