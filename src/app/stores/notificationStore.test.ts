import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_DURATION, MAX_TOASTS, useNotificationStore } from './notificationStore';

function reset() {
  useNotificationStore.setState({ toasts: [], nextId: 1 });
}

afterEach(reset);

describe('notificationStore', () => {
  it('notify appends a toast and returns its id', () => {
    const id = useNotificationStore.getState().notify({ severity: 'success', message: 'done' });
    const { toasts } = useNotificationStore.getState();
    expect(id).toBe(1);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ id: 1, severity: 'success', message: 'done' });
  });

  it('defaults severity to info and duration to the per-severity default', () => {
    useNotificationStore.getState().notify({ message: 'hi' });
    const t = useNotificationStore.getState().toasts[0];
    expect(t.severity).toBe('info');
    expect(t.durationMs).toBe(DEFAULT_DURATION.info);
  });

  it('honours an explicit durationMs (including 0 = sticky)', () => {
    useNotificationStore.getState().notify({ severity: 'warn', message: 'sticky', durationMs: 0 });
    expect(useNotificationStore.getState().toasts[0].durationMs).toBe(0);
  });

  it('ids are monotonic across notifications', () => {
    const a = useNotificationStore.getState().notify({ message: 'a' });
    const b = useNotificationStore.getState().notify({ message: 'b' });
    expect([a, b]).toEqual([1, 2]);
  });

  it('is idempotent on (severity, message): a still-visible duplicate is not stacked', () => {
    const a = useNotificationStore.getState().notify({ severity: 'error', message: 'boom' });
    const b = useNotificationStore.getState().notify({ severity: 'error', message: 'boom' });
    expect(a).toBe(b);
    expect(useNotificationStore.getState().toasts).toHaveLength(1);
  });

  it('same message at a different severity is a distinct toast', () => {
    useNotificationStore.getState().notify({ severity: 'info', message: 'x' });
    useNotificationStore.getState().notify({ severity: 'error', message: 'x' });
    expect(useNotificationStore.getState().toasts).toHaveLength(2);
  });

  it('caps the visible stack at MAX_TOASTS, dropping the oldest', () => {
    for (let i = 0; i < MAX_TOASTS + 3; i++) {
      useNotificationStore.getState().notify({ message: `m${i}` });
    }
    const { toasts } = useNotificationStore.getState();
    expect(toasts).toHaveLength(MAX_TOASTS);
    // Oldest (m0..m2) fell off; newest survives.
    expect(toasts[toasts.length - 1].message).toBe(`m${MAX_TOASTS + 2}`);
    expect(toasts.some((t) => t.message === 'm0')).toBe(false);
  });

  it('dismiss removes one toast by id and is a no-op for an unknown id', () => {
    const a = useNotificationStore.getState().notify({ message: 'a' });
    useNotificationStore.getState().notify({ message: 'b' });
    const before = useNotificationStore.getState().toasts;
    useNotificationStore.getState().dismiss(999); // unknown → no churn
    expect(useNotificationStore.getState().toasts).toBe(before);
    useNotificationStore.getState().dismiss(a);
    expect(useNotificationStore.getState().toasts.map((t) => t.message)).toEqual(['b']);
  });

  it('clear empties the stack and is a no-op when already empty', () => {
    useNotificationStore.getState().notify({ message: 'a' });
    useNotificationStore.getState().clear();
    expect(useNotificationStore.getState().toasts).toHaveLength(0);
    const empty = useNotificationStore.getState().toasts;
    useNotificationStore.getState().clear(); // no-op → same identity
    expect(useNotificationStore.getState().toasts).toBe(empty);
  });
});
