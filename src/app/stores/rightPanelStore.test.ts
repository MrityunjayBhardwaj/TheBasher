import { beforeEach, describe, expect, it } from 'vitest';
import { useRightPanelStore } from './rightPanelStore';

describe('rightPanelStore (#1703)', () => {
  beforeEach(() => useRightPanelStore.setState({ tab: 'inspector' }));

  it('boots on the Inspector', () => {
    expect(useRightPanelStore.getState().tab).toBe('inspector');
  });

  it('switches to Lights and back', () => {
    useRightPanelStore.getState().setTab('lights');
    expect(useRightPanelStore.getState().tab).toBe('lights');
    useRightPanelStore.getState().setTab('inspector');
    expect(useRightPanelStore.getState().tab).toBe('inspector');
  });

  it('ignores an unknown tab', () => {
    useRightPanelStore.getState().setTab('lights');
    (useRightPanelStore.getState().setTab as (t: string) => void)('materials');
    expect(useRightPanelStore.getState().tab).toBe('lights');
  });
});
