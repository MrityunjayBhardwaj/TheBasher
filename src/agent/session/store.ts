// Agent session store — conversation state, token tracking, mode management.
//
// Each conversation sits in memory for the current browser session;
// cross-session persistence ships post-P2.5 when the UX stabilizes.
//
// REF: THESIS.md §21-24.

import { create } from 'zustand';

export type AgentMode = 'read-only' | 'copilot' | 'sandbox';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCallIds?: string[];
  timestamp: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

export interface SessionState {
  id: string;
  messages: Message[];
  mode: AgentMode;
  tokenUsage: TokenUsage;
  isStreaming: boolean;
  error: string | null;
}

export interface AgentSessionStore {
  session: SessionState;
  setMode: (mode: AgentMode) => void;
  addMessage: (msg: Omit<Message, 'id' | 'timestamp'>) => void;
  updateLastAssistantMessage: (content: string) => void;
  appendToLastAssistant: (text: string) => void;
  setStreaming: (v: boolean) => void;
  setError: (err: string | null) => void;
  addTokenUsage: (input: number, output: number) => void;
  reset: () => void;
}

let msgCounter = 0;

function newId(): string {
  return `msg_${(++msgCounter).toString(36)}_${Date.now().toString(36)}`;
}

const INITIAL_SESSION: SessionState = {
  id: `session_${Date.now().toString(36)}`,
  messages: [],
  // Default to copilot: the single-text-bar chat ("just say the word…") means
  // the agent ACTS on a request, not just inspects. copilot routes every
  // mutation through the Diff/DiffBar approval (orchestrator), so "say the word
  // → it proposes the change → you approve" — the agent never silently mutates.
  // The read-only / sandbox autonomy levels still exist on the store for
  // programmatic use; the mode SELECTOR was removed from the chat UI.
  mode: 'copilot',
  tokenUsage: { input: 0, output: 0, total: 0 },
  isStreaming: false,
  error: null,
};

export const useAgentSessionStore = create<AgentSessionStore>((set) => ({
  session: { ...INITIAL_SESSION },
  setMode: (mode) => set((s) => ({ session: { ...s.session, mode } })),
  setStreaming: (v) => set((s) => ({ session: { ...s.session, isStreaming: v } })),
  setError: (err) => set((s) => ({ session: { ...s.session, error: err } })),
  addTokenUsage: (input, output) =>
    set((s) => ({
      session: {
        ...s.session,
        tokenUsage: {
          input: s.session.tokenUsage.input + input,
          output: s.session.tokenUsage.output + output,
          total: s.session.tokenUsage.total + input + output,
        },
      },
    })),
  addMessage: (msg) => {
    const m: Message = { ...msg, id: newId(), timestamp: Date.now() };
    set((s) => ({ session: { ...s.session, messages: [...s.session.messages, m] } }));
  },
  updateLastAssistantMessage: (content) =>
    set((s) => {
      const msgs = [...s.session.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, content };
      }
      return { session: { ...s.session, messages: msgs } };
    }),
  appendToLastAssistant: (text) =>
    set((s) => {
      const msgs = [...s.session.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, content: last.content + text };
      }
      return { session: { ...s.session, messages: msgs } };
    }),
  reset: () => set({ session: { ...INITIAL_SESSION, id: `session_${Date.now().toString(36)}` } }),
}));

export function summarizeDag(
  nodes: Record<string, { type: string }>,
  outputs: Record<string, unknown>,
): string {
  const typeCounts = new Map<string, number>();
  for (const n of Object.values(nodes)) {
    typeCounts.set(n.type, (typeCounts.get(n.type) ?? 0) + 1);
  }
  const typeSummary = [...typeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `${t}×${c}`)
    .join(', ');
  const outputList = Object.keys(outputs).join(', ');
  return `Nodes: ${Object.keys(nodes).length} total (${typeSummary})\nOutputs: ${outputList}`;
}
