// Global keyboard shortcuts. Mounted at App root so the listener is
// always alive (regardless of layout slot focus).
//
// Shortcut map (matches Blender's where it makes sense, extends with the
// UI-SPEC §6.2 model added in P6 W2 + W6):
//   1 / 2 / 3 / 4     — set mode = edit / run / animate / director (W2)
//   Q / W / E / R     — set activeTool = select / translate / rotate / scale (W2)
//   G / R / S         — alias: still switch gizmo mode for muscle memory
//                       (Blender idiom). 'R' overlaps with W2's scale —
//                       handled by routing both through setActiveTool so
//                       the canonical activeTool stays in sync.
//   A                 — select all (#226 Slice 3, Blender idiom). Add moved to
//                       Shift+A only (+ the + button).
//   Alt + A           — deselect all (#226 Slice 3)
//   B                 — arm box (marquee) select (#226 Slice 1)
//   Esc               — clear selection AND return mode → edit (W1)
//   Cmd/Ctrl + Z      — undo
//   Cmd/Ctrl + Shift + Z OR Cmd/Ctrl + Y — redo
//   Cmd/Ctrl + S      — save current project (preventDefault — browser save dialog)
//   Delete / Backspace  — Animate-mode: when timelineSelection.activeKeyframeId
//                       is set, remove THAT keyframe (W6 D-W6-2). Otherwise:
//                       remove primary selected node (existing).
//   Cmd/Ctrl + A      — select all (same full universe as bare A)
//   Cmd/Ctrl + I      — invert selection (#226 Slice 3)
//   Cmd/Ctrl + Shift + C — camera-from-view (snapshot orbit pose into a
//                       new PerspectiveCamera node)
//
// Animate-mode only (P6 W6):
//   Space             — play / pause toggle
//   K                 — insert a keyframe at timeStore.seconds into
//                       timelineSelection.activeChannelId, reading the
//                       channel's target.paramPath value from the live
//                       DAG. No-op if no active channel.
//   [                 — seek to previous keyframe on activeChannelId
//   ]                 — seek to next keyframe on activeChannelId
//
// Skip handling when an `<input>` / `<textarea>` / contenteditable is
// focused — the user is typing.
//
// V1 stays clean: every DAG-touching path goes through dispatchAtomic
// or the hydrate seam. The W6 K-insert + Delete-override compute the
// next keyframes array locally (mirroring keyframeMutator's sort +
// same-time-replace semantics) and emit a single setParam Op.

import { useEffect } from 'react';
import type { Op } from '../core/dag/types';
import { useDagStore } from '../core/dag/store';
import { useTimeStore } from './stores/timeStore';
import { useTimelineSelection } from '../timeline/timelineSelection';
import { saveCurrent } from './boot';
import { snapshotCameraFromOrbit } from './character/cameraFromView';
import { frameAll, frameSelected } from './character/framing';
import { useAddMenuStore } from './stores/addMenuStore';
import { useChromeStore } from './stores/chromeStore';
import { useEditorStore, type ActiveTool } from './stores/editorStore';
import { useSelectionStore } from './stores/selectionStore';
import { useRenameStore } from './stores/renameStore';
import { useBoxSelectStore } from './stores/boxSelectStore';
import { getViewportSelectableIds } from './selectableNodes';
import { buildDeleteNodesOps } from './sceneNodeActions';
import { useDrillStore } from './stores/drillStore';
import { useViewportStore } from './stores/viewportStore';
import { keyParamFromTransient } from './animate/autoKeyCommit';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';

interface KeyframeSample {
  time: number;
  value: unknown;
  easing: 'linear' | 'cubic';
}

const DEFAULT_EASING_BY_TYPE: Record<string, 'linear' | 'cubic'> = {
  KeyframeChannelNumber: 'linear',
  KeyframeChannelVec3: 'cubic',
  KeyframeChannelQuat: 'cubic',
  KeyframeChannelColor: 'cubic',
};

/** Pure helper — append-or-replace a keyframe at `time`. Mirrors
 *  keyframeMutator.build()'s sort + same-time-replace semantics so the
 *  K shortcut produces bit-identical results to an agent-issued
 *  keyframe Mutator at the same channel + time. */
function nextKeyframesAfterInsert(
  existing: ReadonlyArray<KeyframeSample>,
  time: number,
  value: unknown,
  easing: 'linear' | 'cubic',
): KeyframeSample[] {
  const filtered = existing.filter((k) => k.time !== time);
  return [...filtered, { time, value, easing }].sort((a, b) => a.time - b.time);
}

/** Build the setParam Op that K dispatches. Returns null when the
 *  insert is impossible (no active channel, channel not in DAG, target
 *  param not readable, etc) — caller treats as no-op. */
function buildKeyframeInsertOp(): Op | null {
  const channelId = useTimelineSelection.getState().activeChannelId;
  if (!channelId) return null;
  const dagState = useDagStore.getState().state;
  const channel = dagState.nodes[channelId];
  if (!channel || !channel.type.startsWith('KeyframeChannel')) return null;

  const cParams = (channel.params ?? {}) as {
    target?: string;
    paramPath?: string;
    keyframes?: KeyframeSample[];
  };
  if (!cParams.target || !cParams.paramPath) return null;
  const target = dagState.nodes[cParams.target];
  if (!target) return null;
  const targetParams = (target.params ?? {}) as Record<string, unknown>;
  const value = targetParams[cParams.paramPath];
  if (value === undefined) return null;

  const time = useTimeStore.getState().seconds;
  const easing = DEFAULT_EASING_BY_TYPE[channel.type] ?? 'linear';
  const next = nextKeyframesAfterInsert(cParams.keyframes ?? [], time, value, easing);
  return {
    type: 'setParam',
    nodeId: channelId,
    paramPath: 'keyframes',
    value: next,
  };
}

/** Build the setParam Op that Delete dispatches when activeKeyframeId is
 *  set. Returns null when the ref is dangling (keyframe deleted elsewhere
 *  since the activeKeyframeId was set). */
function buildKeyframeDeleteOp(): Op | null {
  const ref = useTimelineSelection.getState().activeKeyframeId;
  if (!ref) return null;
  const dagState = useDagStore.getState().state;
  const channel = dagState.nodes[ref.channelId];
  if (!channel || !channel.type.startsWith('KeyframeChannel')) return null;
  const cParams = (channel.params ?? {}) as { keyframes?: KeyframeSample[] };
  const existing = cParams.keyframes ?? [];
  const next = existing.filter((k) => k.time !== ref.time);
  if (next.length === existing.length) return null; // ref was dangling
  return {
    type: 'setParam',
    nodeId: ref.channelId,
    paramPath: 'keyframes',
    value: next,
  };
}

/** [ / ] seek helpers. Returns the time of the previous/next keyframe
 *  on the active channel relative to current time, or null when there
 *  isn't one. */
function findAdjacentKeyframeTime(direction: 'prev' | 'next'): number | null {
  const channelId = useTimelineSelection.getState().activeChannelId;
  if (!channelId) return null;
  const channel = useDagStore.getState().state.nodes[channelId];
  if (!channel || !channel.type.startsWith('KeyframeChannel')) return null;
  const cParams = (channel.params ?? {}) as { keyframes?: KeyframeSample[] };
  const times = (cParams.keyframes ?? []).map((k) => k.time).sort((a, b) => a - b);
  if (times.length === 0) return null;
  const cur = useTimeStore.getState().seconds;
  if (direction === 'prev') {
    let candidate: number | null = null;
    for (const t of times) {
      if (t < cur) candidate = t;
      else break;
    }
    return candidate;
  }
  for (const t of times) if (t > cur) return t;
  return null;
}

export {
  nextKeyframesAfterInsert,
  buildKeyframeInsertOp,
  buildKeyframeDeleteOp,
  findAdjacentKeyframeTime,
};

// Esc dismisses the topmost transient overlay, in priority order (v0.6 #4 —
// the operational mode enum is gone, so Esc no longer resets a mode; it reads
// existing ephemeral flags as a priority ladder, no new store). Keys 1/2/3/4
// are now unbound (the old MODE_KEYS).
function dismissTopmostTransient(): void {
  // 0. #226 — an armed box-select is the topmost transient: Esc cancels it
  // (without changing the selection) before any deeper Esc behavior.
  if (useBoxSelectStore.getState().active) {
    useBoxSelectStore.getState().cancel();
    return;
  }
  const chrome = useChromeStore.getState();
  if (chrome.presentMode) {
    // 1. Leave the fullscreen present/director-cut first.
    chrome.setPresentMode(false);
    return;
  }
  if (useAddMenuStore.getState().open) {
    // 2a. Close an open Add menu.
    useAddMenuStore.getState().close();
    return;
  }
  // 2b. UX #7 — pop OUT one drill level (leaf → … → asset) before clearing.
  // When the user has double-click-drilled into a dense glTF hierarchy, Esc
  // walks back up a level at a time (mirrors the drill-in), selecting the
  // parent. Only when already at the top (popOut returns null) do we fall
  // through to the selection clear.
  const popped = useDrillStore.getState().popOut();
  if (popped) {
    useSelectionStore.getState().select(popped);
    return;
  }
  // 3. Floor: clear the selection (the pre-existing Esc behavior). We do NOT
  // auto-close the docked timeline drawer — dismissing a docked surface on Esc
  // would surprise; the ladder only dismisses OVERLAY transients.
  useSelectionStore.getState().clear();
}

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
        dismissTopmostTransient();
        return;
      }
      // Cmd/Ctrl + S — save. Handled BEFORE the typing-target guard so it
      // works even while an Inspector field / chat textarea is focused — a
      // universal save (the browser's own Cmd+S behaves this way, and the
      // now-removed chrome save button saved regardless of focus). Without
      // this, editing a value and hitting Cmd+S would silently save nothing.
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        void saveCurrent();
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
      // (Cmd/Ctrl + S — save — is handled above the typing-target guard so it
      // fires even while a field is focused.)
      // Cmd/Ctrl + A — select all (#226 Slice 3: Blender also binds this to bare
      // `A`, handled in the switch below). The universe is the full selectable
      // set — children + lights + camera (getViewportSelectableIds), matching
      // box-select and Blender's "A selects everything".
      if (cmd && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        useSelectionStore
          .getState()
          .selectAll(getViewportSelectableIds(useDagStore.getState().state));
        return;
      }
      // Ctrl/Cmd + I — invert selection over the same full universe (#226 Slice 3).
      if (cmd && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault();
        useSelectionStore.getState().invert(getViewportSelectableIds(useDagStore.getState().state));
        return;
      }

      // Alt + A — deselect all (#226 Slice 3, Blender idiom). Checked BEFORE the
      // single-key guard below (which returns on any modifier). e.code (not e.key)
      // because Option/Alt remaps the character on macOS (Alt+A → 'å').
      if (!cmd && e.altKey && !e.shiftKey && e.code === 'KeyA') {
        e.preventDefault();
        useSelectionStore.getState().clear();
        return;
      }

      // Single-key shortcuts (only when no mod is held).
      if (cmd || e.altKey || e.shiftKey) return;

      // F2 — rename the active node (Blender's idiom). Opens the inline editor
      // in the OUTLINER row of the primary selection. No-op when nothing is
      // selected. The typing-guard above already returned if a field is focused,
      // so F2 can't fire while a rename editor is open.
      if (e.key === 'F2') {
        const primary = useSelectionStore.getState().primaryNodeId;
        if (primary) {
          e.preventDefault();
          useRenameStore.getState().begin(primary, 'outliner');
        }
        return;
      }

      // B — arm box (marquee) select (#226, Blender's idiom). The crosshair
      // overlay then captures a drag; release selects the enclosed objects.
      // Bare key (LMB-drag stays orbit, Basher's primary orbit gesture).
      if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        useBoxSelectStore.getState().begin();
        return;
      }

      // Whether the timeline drawer is revealed — the keyframe-editing context
      // that replaces the deleted `animate` mode (v0.6 #4). Keyframe ops (K/I/
      // [/]) and the Delete-keyframe override gate on this; Space transport and
      // the tool keys do NOT (they are generic and mode-free).
      const timelineDrawerOpen = useViewportStore.getState().timelineDrawerOpen;

      // Tool keys Q/W/E/R (P6 W2). Lowercase the input so capslock-on users get
      // the same behavior. The G/R/S aliases below stay alive for Blender muscle
      // memory; both routes funnel through setActiveTool, which propagates to
      // gizmoStore.mode for translate/rotate/scale. v0.6 #4: the operational
      // mode enum is gone — tool keys are allowed whenever the user is NOT
      // typing in a field (the isTypingTarget guard earlier already returned for
      // typing surfaces, so reaching here means not-typing). Keys 1/2/3/4 are
      // unbound (the old MODE_KEYS).
      const toolMatch = TOOL_KEYS.find((t) => t.key === e.key.toLowerCase());
      if (toolMatch) {
        useEditorStore.getState().setActiveTool(toolMatch.tool);
        return;
      }

      // Space — play/pause transport. Generic and ALWAYS-ON (v0.6 #4: the
      // `animate` mode that used to gate it is gone; Play is a discrete
      // transport per D-06, the same one the floating-toolbar ▶ drives).
      // preventDefault so the browser doesn't scroll when viewport-focused.
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        useTimeStore.getState().toggle();
        return;
      }

      // Keyframe ops (K/I/[/]) — gated on the timeline drawer being revealed,
      // the keyframe-editing context that replaces the deleted `animate` mode.
      // The K/I logic additionally self-guards on an active channel / selection.
      // Matched BEFORE the legacy switch so K doesn't fall through to anything
      // unintended.
      if (timelineDrawerOpen) {
        // K / I: insert keyframe(s) at the current time. Context-sensitive
        // (Blender-faithful):
        //   - DOPESHEET context (an active timeline channel) → insert on that
        //     channel, reading the target's live param value (P6 W6 — unchanged).
        //   - VIEWPORT context (no active channel, an object selected) → #149 E2:
        //     key the selected object's WHOLE transform (position/rotation/scale)
        //     from the held transients via the SHARED keyParamFromTransient fork
        //     (the same the diamond uses — NOT buildKeyframeInsertOp). I is bound
        //     alongside K (it was free) — Blender's Insert-Keyframe idiom.
        if (e.key === 'k' || e.key === 'K' || e.key === 'i' || e.key === 'I') {
          const activeChannel = useTimelineSelection.getState().activeChannelId;
          if (activeChannel) {
            const op = buildKeyframeInsertOp();
            if (op) {
              useDagStore.getState().dispatchAtomic([op], 'user', 'insert keyframe');
            }
            return;
          }
          const selectedId = useSelectionStore.getState().primaryNodeId;
          if (selectedId) {
            const state = useDagStore.getState().state;
            const seconds = useTimeStore.getState().seconds;
            const frame = useTimeStore.getState().frame;
            const evalT = resolveEvaluatedTransform(state, selectedId, {
              time: { frame, seconds, normalized: 0 },
            });
            const params = (state.nodes[selectedId]?.params ?? {}) as Record<string, unknown>;
            // The displayed pose per band: the evaluated value (which already
            // overlays any transient) when available, else the authored param.
            // keyParamFromTransient additionally prefers the transient, so a held
            // edit is captured; an un-edited band keys the current pose (LocRotScale).
            const bands: Array<['position' | 'rotation' | 'scale', unknown]> = [
              ['position', evalT?.position ?? params.position],
              ['rotation', evalT?.rotation ?? params.rotation],
              ['scale', evalT?.scale ?? params.scale],
            ];
            for (const [band, v] of bands) {
              if (v === undefined || v === null) continue; // band absent → skip
              keyParamFromTransient(selectedId, band, v);
            }
          }
          return;
        }
        // [ / ] — seek to previous / next keyframe on active channel.
        if (e.key === '[') {
          const t = findAdjacentKeyframeTime('prev');
          if (t !== null) useTimeStore.getState().setTime(t);
          return;
        }
        if (e.key === ']') {
          const t = findAdjacentKeyframeTime('next');
          if (t !== null) useTimeStore.getState().setTime(t);
          return;
        }
      }

      switch (e.key) {
        // G / R / S aliases — Blender idiom. Route through setActiveTool
        // so the canonical activeTool stays in sync (no parallel control
        // path with W's translate).
        case 'g':
        case 'G':
          useEditorStore.getState().setActiveTool('translate');
          return;
        case 's':
        case 'S':
          useEditorStore.getState().setActiveTool('scale');
          return;
        // 'r' / 'R' is already handled by the TOOL_KEYS path above
        // (rotate). The Blender alias for rotate is the same key, so
        // there's no conflict — the canonical W2 binding wins.
        case 'a':
        case 'A':
          // #226 Slice 3 — bare 'A' is Select-All (Blender's idiom). Add moved to
          // Shift+A only (handled earlier) + the + button. Same full universe as
          // Cmd/Ctrl+A above.
          useSelectionStore
            .getState()
            .selectAll(getViewportSelectableIds(useDagStore.getState().state));
          return;
        case 'Delete':
        case 'Backspace':
          // P6 W6 — keyframe-delete override (D-W6-2). When the timeline drawer
          // is revealed AND a specific keyframe is selected (Dopesheet diamond
          // click sets timelineSelection.activeKeyframeId), Delete removes THAT
          // keyframe via setParam on the channel's keyframes array. Falls
          // through to node-delete only when no keyframe is selected. v0.6 #4:
          // gated on the timeline being open (was the `animate` mode).
          if (timelineDrawerOpen) {
            const kfOp = buildKeyframeDeleteOp();
            if (kfOp) {
              useDagStore.getState().dispatchAtomic([kfOp], 'user', 'delete keyframe');
              useTimelineSelection.getState().setActiveKeyframe(null);
              e.preventDefault();
              return;
            }
          }
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
            // Shared op-builder (#227) — the SAME disconnect-consumers + removeNode
            // path the outliner context menu uses, so the two can't drift.
            const ops = buildDeleteNodesOps(dag.state, ids);
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
        case '0':
          // #165: toggle "look through active camera" (Blender Numpad 0).
          // e.key is '0' for both the number row and the numpad, so laptop
          // users (no numpad) get it too. isTypingTarget already guarded above.
          useViewportStore.getState().toggleLookThroughCamera();
          return;
        case 'm':
        case 'M':
          // Toggle editor-view projection perspective ↔ orthographic (Spline's
          // M shortcut; Blender uses Numpad 5). Editor-session only (V8/V34) —
          // EditorViewCamera swaps the one always-default editor camera.
          useViewportStore.getState().toggleCameraProjection();
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
          // UI-SPEC §6.2 / acceptance #4: Esc dismisses the topmost transient.
          // v0.6 #4: the mode enum is gone, so there is no mode to reset — the
          // ladder leaves present → closes a popover → else clears selection.
          dismissTopmostTransient();
          return;
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}
