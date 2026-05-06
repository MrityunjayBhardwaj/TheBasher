// Global keyboard shortcuts. Mounted at App root so the listener is
// always alive (regardless of layout slot focus).
//
// Shortcut map (matches Blender's where it makes sense):
//   G / R / S         — switch gizmo mode (translate / rotate / scale)
//   Esc               — clear selection (no gizmo to "cancel" yet — drag
//                       interrupts via TransformControls' own UX)
//   Cmd/Ctrl + Z      — undo
//   Cmd/Ctrl + Shift + Z OR Cmd/Ctrl + Y — redo
//   Cmd/Ctrl + S      — save current project (preventDefault — browser save dialog)
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
import { useDagStore } from '../core/dag/store';
import { saveCurrent } from './boot';
import { snapshotCameraFromOrbit } from './character/cameraFromView';
import { frameAll, frameSelected } from './character/framing';
import { useAddMenuStore } from './stores/addMenuStore';
import { useEditorStore } from './stores/editorStore';
import { useGizmoStore } from './stores/gizmoStore';
import { useSelectionStore } from './stores/selectionStore';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
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
      if (!cmd && e.shiftKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        const slot = document.querySelector('[data-testid="viewport-slot"]') as HTMLElement | null;
        if (slot) {
          const r = slot.getBoundingClientRect();
          useAddMenuStore.getState().openAt(r.left + r.width / 2, r.top + r.height / 2);
        } else {
          useAddMenuStore.getState().openAt(window.innerWidth / 2, window.innerHeight / 2);
        }
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
      if (cmd || e.altKey) return;
      switch (e.key) {
        case 'g':
        case 'G':
          useGizmoStore.getState().setMode('translate');
          return;
        case 'r':
        case 'R':
          useGizmoStore.getState().setMode('rotate');
          return;
        case 's':
        case 'S':
          useGizmoStore.getState().setMode('scale');
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
          useSelectionStore.getState().clear();
          return;
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}
