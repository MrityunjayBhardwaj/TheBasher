// #1130 — a refused Apply click reaches the director; an accepted one says nothing extra.

import { beforeEach, describe, expect, it } from 'vitest';
import { useNotificationStore } from '../stores/notificationStore';
import { applyTransformFromUi } from './applyTransformAction';

const toasts = () => useNotificationStore.getState().toasts;

beforeEach(() => {
  useNotificationStore.getState().clear();
});

describe('#1130 — applyTransformFromUi', () => {
  it('shows a refusal as a warning carrying the dispatch reason, word for word', async () => {
    const reason = 'Apply: "n_box" assigns 2 materials across its faces (material_index).';
    const result = await applyTransformFromUi('n_box', 'all', async () => ({ ok: false, reason }));
    expect(result).toEqual({ ok: false, reason });
    expect(toasts()).toEqual([expect.objectContaining({ severity: 'warn', message: reason })]);
  });

  it('shows nothing for an Apply that happened', async () => {
    const result = await applyTransformFromUi('n_box', 'scale', async () => ({
      ok: true,
      bakedId: 'n_box',
    }));
    expect(result.ok).toBe(true);
    expect(toasts()).toEqual([]);
  });

  it('turns a throw into an error on screen instead of an unhandled rejection', async () => {
    const result = await applyTransformFromUi('n_box', 'all', async () => {
      throw new Error('storage quota exceeded');
    });
    expect(result).toEqual({ ok: false, reason: 'Apply failed: storage quota exceeded' });
    expect(toasts()).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: 'Apply failed: storage quota exceeded',
      }),
    ]);
  });

  it('passes the node and the mask through untouched', async () => {
    const seen: unknown[] = [];
    await applyTransformFromUi('n_sphere', 'rotation', async (id, mask) => {
      seen.push([id, mask]);
      return { ok: true, bakedId: id };
    });
    expect(seen).toEqual([['n_sphere', 'rotation']]);
  });
});
