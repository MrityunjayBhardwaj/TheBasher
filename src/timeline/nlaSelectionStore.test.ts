// nlaSelectionStore — single-slot strip-XOR-track selection (epic #283
// Phase 5, inc 5A). One inspector, one subject: selecting a strip clears the
// track selection and vice versa.

import { describe, it, expect, beforeEach } from 'vitest';
import { useNlaSelectionStore } from './nlaSelectionStore';

beforeEach(() => {
  useNlaSelectionStore.getState().clear();
});

describe('useNlaSelectionStore — strip XOR track', () => {
  it('starts empty', () => {
    const s = useNlaSelectionStore.getState();
    expect(s.selectedStripId).toBeNull();
    expect(s.selectedTrackId).toBeNull();
  });

  it('selecting a strip clears the track selection', () => {
    useNlaSelectionStore.getState().selectTrack('t1');
    useNlaSelectionStore.getState().selectStrip('s1');
    const s = useNlaSelectionStore.getState();
    expect(s.selectedStripId).toBe('s1');
    expect(s.selectedTrackId).toBeNull();
  });

  it('selecting a track clears the strip selection', () => {
    useNlaSelectionStore.getState().selectStrip('s1');
    useNlaSelectionStore.getState().selectTrack('t1');
    const s = useNlaSelectionStore.getState();
    expect(s.selectedTrackId).toBe('t1');
    expect(s.selectedStripId).toBeNull();
  });

  it('clear() empties both slots (Esc)', () => {
    useNlaSelectionStore.getState().selectStrip('s1');
    useNlaSelectionStore.getState().clear();
    const s = useNlaSelectionStore.getState();
    expect(s.selectedStripId).toBeNull();
    expect(s.selectedTrackId).toBeNull();
  });
});
