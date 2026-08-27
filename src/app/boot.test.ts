// #255 — the beforeunload guard's pure decision: block the unload (native
// "unsaved changes" prompt) iff the project is dirty, never when clean.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beforeUnloadIfDirty, getMotionCapability, resetMotionCapability } from './boot';
import { useSettingsStore } from './stores/settingsStore';
import { aBlockedRecord } from '../core/licensing/blockedModelForTests';

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

// The motion-generation capability's session wiring. Mirrors getComfyCapability's
// contract — a single instance per session, one probe under concurrent first
// callers, and a reset when the configured URL changes.
describe('getMotionCapability', () => {
  beforeEach(() => {
    resetMotionCapability();
    useSettingsStore.setState({ motionGenUrl: 'http://127.0.0.1:1' });
  });
  afterEach(() => resetMotionCapability());

  it('falls back to the stub when no service answers', async () => {
    // An unreachable service is the ORDINARY case for this track — no such
    // server exists yet — so the pick must never throw or leave a caller
    // without a generator.
    const cap = await getMotionCapability();
    expect(cap.kind).toBe('stub');
  });

  it('caches one instance across the session', async () => {
    const [a, b] = [await getMotionCapability(), await getMotionCapability()];
    expect(a).toBe(b);
  });

  it('two concurrent first callers share ONE probe, not two', async () => {
    // The promise guard, constructed: awaiting both at once must not race two
    // HTTP probes and mint two capabilities.
    const [a, b] = await Promise.all([getMotionCapability(), getMotionCapability()]);
    expect(a).toBe(b);
  });

  it('resetMotionCapability re-probes, so a changed URL is not pinned by the cache', async () => {
    const first = await getMotionCapability();
    resetMotionCapability();
    const second = await getMotionCapability();
    expect(second).not.toBe(first);
  });

  it('the capability refuses a BLOCKED checkpoint at the moment of use', async () => {
    // The run-time half of the licence gate, finally reachable from a real path:
    // the id comes from the settings store, which a build-time scan of source
    // text cannot see. The settings surface refuses to STORE a blocked id; this
    // is the check that would still fire if one arrived by any other route.
    const cap = await getMotionCapability();
    await expect(
      cap.generate({ prompt: 'a figure walks', model: aBlockedRecord().id }),
    ).rejects.toThrow(/BLOCKED/);
  });

  it('generates through the checkpoint the settings store actually holds', async () => {
    const cap = await getMotionCapability();
    const { motionGenModel } = useSettingsStore.getState();
    const result = await cap.generate({ prompt: 'a figure walks', model: motionGenModel });
    // The default is org-qualified, which is precisely the form that resolved to
    // nothing before the licence record learned to answer to it.
    expect(motionGenModel).toContain('/');
    expect(result.bvh).toContain('HIERARCHY');
  });
});
