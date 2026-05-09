// Agent chat UI — text input + message history + mode selector.
//
// Sits in the RightDrawer (pro mode) or as a floating panel (simple mode).
// The orchestrator handles the LLM turn and reads fresh DAG state on every
// round; this component just drives it with the user message + selection.
//
// Styling matches the rest of the editor chrome: mono font, fg/muted/border
// theme tokens, accent green for active states. No shadcn — the project
// uses plain Tailwind with the palette in `tailwind.config.ts`.
//
// REF: THESIS.md §15-17 (editor chrome), §21 (context strategy).

import { useState, useCallback, useRef } from 'react';
import { useAgentSessionStore, type AgentMode } from '../agent/session/store';
import { useSelectionStore } from './stores/selectionStore';
import { runAgentTurn } from '../agent/orchestrator';
import type { LLMConfig } from '../agent/transport/types';
import { getComfyCapability, getStorage } from './boot';

const DEFAULT_BASE_URL = 'https://api.deepinfra.com/v1';
const DEFAULT_MODEL = 'google/gemma-4-31B-it';

const MODES: AgentMode[] = ['read-only', 'copilot', 'sandbox'];

function getLLMConfig(): LLMConfig {
  const env = import.meta.env;
  const winOverrides = window as unknown as Record<string, string | undefined>;
  return {
    apiKey: winOverrides['__BASHER_LLM_KEY'] ?? env.VITE_BASHER_LLM_KEY ?? '',
    baseUrl: winOverrides['__BASHER_LLM_BASE_URL'] ?? env.VITE_BASHER_LLM_BASE_URL ?? DEFAULT_BASE_URL,
    model: winOverrides['__BASHER_LLM_MODEL'] ?? env.VITE_BASHER_LLM_MODEL ?? DEFAULT_MODEL,
    temperature: 0.7,
    maxTokens: 4096,
    maxTurnTokens: 30_000,
  };
}

export function AgentChat() {
  const session = useAgentSessionStore((s) => s.session);
  const setMode = useAgentSessionStore((s) => s.setMode);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const handleSend = useCallback(async () => {
    const msg = input.trim();
    if (!msg || running) return;
    setInput('');
    setRunning(true);

    const selectedNodeIds = useSelectionStore.getState().selectedNodeIds;
    const config = getLLMConfig();

    if (!config.apiKey) {
      useAgentSessionStore.getState().setError(
        'No LLM API key configured. Set VITE_BASHER_LLM_KEY in .env or window.__BASHER_LLM_KEY.',
      );
      setRunning(false);
      return;
    }

    const abort = new AbortController();
    abortRef.current = abort;

    // Resolve capabilities fresh per turn (the underlying getters are
    // module-level singletons — same instance across the session, but
    // never captured at component mount where they'd be premature).
    const [comfyCapability, storage] = await Promise.all([
      getComfyCapability(),
      getStorage(),
    ]);

    try {
      await runAgentTurn(config, {
        message: msg,
        mode: session.mode,
        signal: abort.signal,
        selectedNodeIds,
        comfyCapability,
        storage,
      });
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [input, running, session.mode]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col font-mono text-xs text-fg" data-testid="agent-chat">
      {/* Mode selector */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <span className="mr-1 text-[10px] uppercase tracking-wide text-fg/50">Mode</span>
        {MODES.map((m) => {
          const active = session.mode === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              data-testid={`agent-mode-${m}`}
              className={[
                'flex-1 rounded border px-2 py-0.5 text-[10px]',
                active
                  ? 'border-accent bg-muted text-accent'
                  : 'border-border bg-muted text-fg/60 hover:border-accent/60 hover:text-fg/90',
              ].join(' ')}
            >
              {m}
            </button>
          );
        })}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto px-2 py-2" data-testid="agent-messages">
        {session.messages.length === 0 && !session.error ? (
          <div className="px-1 py-3 text-[11px] text-fg/40">
            Ask the agent to inspect, plan, or modify the scene. Selected nodes
            are surfaced in the agent's context.
          </div>
        ) : null}
        {session.messages.map((msg) => {
          const isAgent = msg.role === 'assistant';
          return (
            <div
              key={msg.id}
              className={[
                'mb-1.5 rounded border-l-2 px-2 py-1',
                isAgent ? 'border-accent/70 bg-muted/60' : 'border-fg/30 bg-muted/30',
              ].join(' ')}
            >
              <div className="mb-0.5 text-[9px] uppercase tracking-wide text-fg/40">
                {isAgent ? 'agent' : 'you'}
              </div>
              <div className="whitespace-pre-wrap break-words text-[11px] text-fg/85">
                {msg.content || (session.isStreaming ? '…' : '')}
              </div>
            </div>
          );
        })}
        {session.error ? (
          <div className="mt-1 rounded border border-red-500/40 bg-red-500/5 px-2 py-1 text-[11px] text-red-300">
            {session.error}
          </div>
        ) : null}
      </div>

      {/* Token usage footer */}
      {session.tokenUsage.total > 0 ? (
        <div
          className="border-t border-border px-2 py-0.5 text-right text-[10px] text-fg/40"
          data-testid="agent-tokens"
        >
          Tokens: {session.tokenUsage.total.toLocaleString()}
          <span className="ml-1 text-fg/30">
            (↑{session.tokenUsage.input.toLocaleString()} ↓{session.tokenUsage.output.toLocaleString()})
          </span>
        </div>
      ) : null}

      {/* Input area */}
      <div className="border-t border-border p-2">
        <div className="flex items-stretch gap-1.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={running ? 'waiting for response…' : 'ask the agent…'}
            disabled={running}
            rows={2}
            data-testid="agent-input"
            className="flex-1 resize-none rounded border border-border bg-muted px-2 py-1 font-mono text-[11px] text-fg placeholder:text-fg/30 focus:border-accent focus:outline-none disabled:opacity-50"
          />
          {running ? (
            <button
              type="button"
              onClick={handleCancel}
              data-testid="agent-cancel"
              className="rounded border border-red-500/40 bg-muted px-2 text-[11px] text-red-300 hover:border-red-400 hover:text-red-200"
            >
              cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={!input.trim()}
              data-testid="agent-send"
              className="rounded border border-border bg-muted px-3 text-[11px] text-fg/80 hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-border disabled:hover:text-fg/80"
            >
              send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
