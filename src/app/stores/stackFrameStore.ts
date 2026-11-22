// Which stack the inspector's stack frame shows (#1957): Modifiers, Constraints or Materials.
//
// UI-only, like the drawer's tab (`timelineDockStore`): one localStorage key, read once at boot
// and narrowed (an unknown value falls back to the default), written on every change through the
// safe wrappers, so a disabled or full storage never throws. Nothing here touches the graph.

import { create } from 'zustand';
import { STACK_KINDS, type StackKind } from '../stackFrameModel';

const STORAGE_KEY = 'basher.stackFrame.v1';
const DEFAULT_STACK: StackKind = 'modifiers';

function safeGetItem(key: string): string | null {
  try {
    if (typeof localStorage?.getItem !== 'function') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    if (typeof localStorage?.setItem !== 'function') return;
    localStorage.setItem(key, value);
  } catch {
    /* ignore — storage quota / disabled / SSR */
  }
}

const isStackKind = (v: unknown): v is StackKind =>
  typeof v === 'string' && (STACK_KINDS as readonly string[]).includes(v);

function readPersisted(): StackKind {
  const raw = safeGetItem(STORAGE_KEY);
  if (!raw) return DEFAULT_STACK;
  try {
    const parsed = JSON.parse(raw) as { stack?: unknown };
    return isStackKind(parsed.stack) ? parsed.stack : DEFAULT_STACK;
  } catch {
    return DEFAULT_STACK;
  }
}

/** A tab the object cannot take, picked on that object (#1960). Not persisted: it shows the note
 *  saying why the stack stays empty, and is no pick to come back to. */
export interface StackFramePeek {
  readonly object: string;
  readonly stack: StackKind;
}

export interface StackFrameStore {
  stack: StackKind;
  peek: StackFramePeek | null;
  /** Pick a stack the object can take. Clears any peek. */
  setStack: (stack: StackKind) => void;
  /** Pick a stack `object` cannot take, to read why. The stored pick is left as it was. */
  setPeek: (peek: StackFramePeek | null) => void;
}

export const useStackFrameStore = create<StackFrameStore>((set) => ({
  stack: readPersisted(),
  peek: null,
  setStack(stack) {
    if (!isStackKind(stack)) return;
    set({ stack, peek: null });
    safeSetItem(STORAGE_KEY, JSON.stringify({ stack }));
  },
  setPeek(peek) {
    if (peek !== null && !isStackKind(peek.stack)) return;
    set({ peek });
  },
}));
