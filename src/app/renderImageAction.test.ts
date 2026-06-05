import { describe, expect, it } from 'vitest';
import { renderResultToToast } from './renderImageAction';

describe('renderResultToToast (#170)', () => {
  it('maps a successful render to a success toast naming the resolution', () => {
    const t = renderResultToToast({ ok: true, width: 1920, height: 1080 });
    expect(t.severity).toBe('success');
    expect(t.message).toContain('1920×1080');
  });

  it('maps a failed render to an error toast (no longer a silent no-op)', () => {
    const t = renderResultToToast({ ok: false, reason: 'viewport-not-ready' });
    expect(t.severity).toBe('error');
    expect(t.message.toLowerCase()).toContain('viewport');
    // Errors linger so the user can read them.
    expect(t.durationMs).toBeGreaterThan(0);
  });
});
