// rightPanelStore — which face the right panel shows (#1703): the Inspector (the selected node's
// params) or Lights (the Light Studio, moved here from the bottom drawer; design board "Lighting").
//
// Ephemeral, like chromeStore's presentMode: the app boots on the Inspector, which is what a
// click in the viewport expects to land on. V8 file-rooted: a UI projection, never the DAG.

import { create } from 'zustand';

export type RightPanelTab = 'inspector' | 'lights';

export interface RightPanelStore {
  tab: RightPanelTab;
  setTab: (tab: RightPanelTab) => void;
}

export const useRightPanelStore = create<RightPanelStore>((set) => ({
  tab: 'inspector',
  setTab(tab) {
    if (tab !== 'inspector' && tab !== 'lights') return;
    set({ tab });
  },
}));
