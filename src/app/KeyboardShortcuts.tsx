// Global keyboard shortcuts. Mounted at App root so the listener is
// always alive (regardless of layout slot focus).
//
// Shortcut map (matches Blender's where it makes sense, extends with the
// UI-SPEC §6.2 model added in P6 W2):
//   1 / 2 / 3 / 4     — set mode = edit / run / animate / director (W2)
//   Q / W / E / R     — set activeTool = select / translate / rotate / scale (W2)
//   G / R / S         — alias: still switch gizmo mode for muscle memory
//                       (Blender idiom). 'R' overlaps with W2's scale —
//                       handled by routing both through setActiveTool so
//                       the canonical activeTool stays in sync.
//   A                 — open Add menu at viewport center (W2; alongside Shift+A)
//   Esc               — clear selection AND return mode → edit (W1)
//   Cmd/Ctrl + Z      — undo
//   Cmd/Ctrl + Shift + Z OR Cmd/Ctrl + Y — redo
//   Cmd/Ctrl + S      — save current project (preventDefault — browser save dialog)
//   Delete / Backspace  — remove primary selected node (V1: dispatchAtomic
//                       removeNode op; protected against outputs by op validator)
//   Cmd/Ctrl + A      — select all top-level scene children
//   Cmd/Ctrl + Shift + C — camera-from-view (snapshot orbit pose into a
//                       new PerspectiveCamera node)
//
// Skip handling when an `<input>` / `<textarea>` / contenteditable is
// focused — the user is typing.
//
// V1 stays clean: only the undo/redo/save/Cmd+A paths touch the DAG, all
// through the Op dispatcher or hydrate seam.

import { useEffect } from 'react';
import type { Op } from '../core/dag/types';
import { useDagStore } from '../core/dag/store';
import { saveCurrent } from './boot';
import { snapshotCameraFromOrbit } from './character/cameraFromView';
import { frameAll, frameSelected } from './character/framing';
import { useAddMenuStore } from './stores/addMenuStore';
import { useEditorStore, type ActiveTool } from './stores/editorStore';
import { useModeStore, type Mode } from './stores/modeStore';
import { useSelectionStore } from './stores/selectionStore';

// Mode keys 1/2/3/4 → operational mode (UI-SPEC §6.2). Indexed list keeps
// the binding declarative — adding a fifth mode is one entry, not a new
// switch case.
const MODE_KEYS: ReadonlyArray<{ key: string; mode: Mode }> = [
  { key: '1', mode: 'edit' },
  { key: '2', mode: 'run' },
  { key: '3', mode: 'animate' },
  { key: '4', mode: 'director' },
];

// Tool keys Q/W/E/R → activeTool (UI-SPEC §6.2). 'R' is shared with the
// G/R/S Blender alias for scale — both routes dispatch through the same
// setActiveTool so there's no canonical-state ambiguity.
const TOOL_KEYS: ReadonlyArray<{ key: string; tool: ActiveTool }> = [
  { key: 'q', tool: 'select' },
  { key: 'w', tool: 'translate' },
  { key: 'e', tool: 'rotate' },
  { key: 'r', tool: 'scale' },
];

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

function openAddMenuAtViewportCenter(): void {
  const slot = document.querySelector('[data-testid="viewport-slot"]') as HTMLElement | null;
  if (slot) {
    const r = slot.getBoundingClientRect();
    useAddMenuStore.getState().openAt(r.left + r.width / 2, r.top + r.height / 2);
    return;
  }
  useAddMenuStore.getState().openAt(window.innerWidth / 2, window.innerHeight / 2);
}

function getTopLevelChildIds(): string[] {
  const dag = useDagStore.getState().state;
  const sceneRef = dag.outputs.scene;
  if (!sceneRef) return [];
  const sceneNode = dag.nodes[sceneRef.node];
  if (!sceneNode) return [];
  const children = sceneNode.inputs.children;
  if (!Array.isArray(children)) return [];
  return children.map((c) => c.node);
}

export function KeyboardShortcuts() {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // V16 — Esc must reach the universal-escape handler even when
      // focus is in a typing surface (AgentChat textarea, Inspector
      // numeric input, etc.). Blur the focused element first so the
      // user's next typing keystroke doesn't continue editing, then
      // fall through to the Escape case in the main switch.
      // (Other shortcuts respect the typing-guard below — Delete/
      // Backspace must NOT bubble out of a textarea, otherwise the
      // user can't delete characters from the chat input.)
      if (e.key === 'Escape' && isTypingTarget(e.target)) {
        if (e.target instanceof HTMLElement) e.target.blur();
        useModeStore.getState().setMode('edit');
        useSelectionStore.getState().clear();
        return;
      }
      if (isTypingTarget(e.target)) return;
      const cmd = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl + Shift + C — camera-from-view (check BEFORE generic
      // Cmd-prefixed handlers so the mod combination wins).
      if (cmd && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        void snapshotCameraFromOrbit();
        return;
      }

      // Shift + A — Add menu (Blender's idiom). Opens at viewport
      // center so Shift+A from anywhere on the page surfaces the menu
      // somewhere predictable.
      // P6 W2 — bare 'A' (no mod, no shift) also opens the Add menu per
      // UI-SPEC §6.2. Both bindings funnel through openAddMenuAtViewportCenter.
      if (!cmd && e.shiftKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        openAddMenuAtViewportCenter();
        return;
      }

      // Cmd/Ctrl + Z — undo
      if (cmd && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        useDagStore.getState().undo();
        return;
      }
      // Cmd/Ctrl + Shift + Z, or Cmd/Ctrl + Y — redo
      if (
        (cmd && e.shiftKey && (e.key === 'z' || e.key === 'Z')) ||
        (cmd && (e.key === 'y' || e.key === 'Y'))
      ) {
        e.preventDefault();
        useDagStore.getState().redo();
        return;
      }
      // Cmd/Ctrl + S — save
      if (cmd && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        void saveCurrent();
        return;
      }
      // Cmd/Ctrl + A — select all top-level scene children
      if (cmd && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        useSelectionStore.getState().selectAll(getTopLevelChildIds());
        return;
      }

      // Single-key shortcuts (only when no mod is held).
      if (cmd || e.altKey || e.shiftKey) return;

      // Mode keys 1/2/3/4 (P6 W2 — UI-SPEC §6.2). Match before the
      // Blender-alias block so the binding is canonical, not a fallthrough.
      const modeMatch = MODE_KEYS.find((m) => m.key === e.key);
      if (modeMatch) {
        useModeStore.getState().setMode(modeMatch.mode);
        return;
      }

      // Tool keys Q/W/E/R (P6 W2). Lowercase the input so capslock-on
      // users get the same behavior. The G/R/S aliases below stay alive
      // for Blender muscle memory; both routes funnel through
      // setActiveTool, which propagates to gizmoStore.mode for
      // translate/rotate/scale (the spec gates tool keys on mode ∈
      // {edit, animate}; we apply the gate here so animate can use them
      // without leaving keyframe context).
      const editorMode = useModeStore.getState().mode;
      const toolKeysAllowed = editorMode === 'edit' || editorMode === 'animate';
      if (toolKeysAllowed) {
        const toolMatch = TOOL_KEYS.find((t) => t.key === e.key.toLowerCase());
        if (toolMatch) {
          useEditorStore.getState().setActiveTool(toolMatch.tool);
          return;
        }
      }

      switch (e.key) {
        // G / R / S aliases — Blender idiom. Route through setActiveTool
        // so the canonical activeTool stays in sync (no parallel control
        // path with W's translate).
        case 'g':
        case 'G':
          if (toolKeysAllowed) useEditorStore.getState().setActiveTool('translate');
          return;
        case 's':
        case 'S':
          if (toolKeysAllowed) useEditorStore.getState().setActiveTool('scale');
          return;
        // 'r' / 'R' is already handled by the TOOL_KEYS path above
        // (rotate). The Blender alias for rotate is the same key, so
        // there's no conflict — the canonical W2 binding wins.
        case 'a':
        case 'A':
          // Bare 'A' opens the Add menu (UI-SPEC §6.2). Shift+A is
          // handled earlier; this branch is the no-modifier case.
          openAddMenuAtViewportCenter();
          return;
        case 'Delete':
        case 'Backspace':
          // Remove all selected nodes (Blender's X/Delete). V1 clean:
          // dispatchAtomic disconnect + removeNode ops. The removeNode
          // validator rejects deletion if any other node still consumes
          // an output — so we find and disconnect all consumers first.
          // Single undo entry reverts the whole delete.
          {
            const dag = useDagStore.getState();
            const sel = useSelectionStore.getState();
            const ids = [...sel.selectedNodeIds];
            if (ids.length === 0) return;
            const dagState = dag.state;
            const ops: Op[] = [];
            for (const nodeId of ids) {
              // Find every consumer that references this node in any input.
              for (const [consumerId, consumer] of Object.entries(dagState.nodes)) {
                if (ids.includes(consumerId)) continue; // being deleted too — skip
                for (const [socketName, binding] of Object.entries(consumer.inputs)) {
                  const refs = Array.isArray(binding) ? binding : [binding];
                  for (const ref of refs) {
                    if (ref.node === nodeId) {
                      ops.push({
                        type: 'disconnect',
                        from: { node: nodeId, socket: ref.socket },
                        to: { node: consumerId, socket: socketName },
                      });
                    }
                  }
                }
              }
              ops.push({ type: 'removeNode', nodeId });
            }
            if (ops.length === 0) return;
            dag.dispatchAtomic(ops, 'user', `delete ${ids.length} node(s)`);
            sel.clear();
            e.preventDefault();
          }
          return;
        case 'f':
        case 'F':
          // Frame the primary selection (Blender's F). No-op when nothing
          // selected.
          frameSelected();
          return;
        case 'Home':
          frameAll();
          return;
        case 'Tab':
          // Toggle 3D Viewport ↔ UV Editor (Blender's Tab idiom). Skip
          // when the user is typing — already handled by isTypingTarget
          // earlier in this function. preventDefault so the browser
          // doesn't tab-focus into chrome.
          e.preventDefault();
          useEditorStore.getState().toggleSpace();
          return;
        case 'Escape':
          // UI-SPEC §6.2 / acceptance #4: Esc universally returns mode → edit
          // and clears selection. The mode reset happens before the selection
          // clear so any subscribers reading both see a coherent post-Esc state.
          useModeStore.getState().setMode('edit');
          useSelectionStore.getState().clear();
          return;
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}
