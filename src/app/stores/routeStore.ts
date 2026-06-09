// Route store (v0.6 #4 W4, D-W4-ROUTE) — which top-level view is showing:
// the pre-editor HOME launcher, or the EDITOR. This is the owner of the
// home-vs-editor decision; boot sets it once (first run / stale resume → home,
// resumable project → editor) and the HOME's open handlers + the editor's
// back-to-home affordance flip it thereafter.
//
// EPHEMERAL and NON-PERSISTED — a route is not creative data (V34-clean, same
// class as chromeStore.presentMode: no DAG dispatch passes through it). A
// reload must NOT restore a stale route; boot re-derives it from the persisted
// `lastProjectId` every time (the resume contract is the source of truth, not
// the last view). So there is no localStorage read/write here.
//
// V8 file-rooted: src/app/stores/ alongside the other UI-projection stores.

import { create } from 'zustand';

export type RouteView = 'home' | 'editor';

export interface RouteStore {
  view: RouteView;
  goHome: () => void;
  openEditor: () => void;
  setView: (view: RouteView) => void;
}

// Default 'editor' is never actually rendered before boot resolves it (App
// shows the booting splash until bootState==='ready', and boot calls goHome()
// / openEditor() before resolving). It is just a safe non-null seed.
export const useRouteStore = create<RouteStore>((set) => ({
  view: 'editor',
  goHome: () => set({ view: 'home' }),
  openEditor: () => set({ view: 'editor' }),
  setView: (view) => set({ view }),
}));
