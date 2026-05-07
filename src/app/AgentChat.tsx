// Agent chat UI — text input + message history + mode selector.
//
// Sits in the RightDrawer (pro mode) or as a floating panel (simple mode).
// The orchestrator handles the LLM turn and reads fresh DAG state on every
// round; this component just drives it with the user message + selection.
//
// REF: THESIS.md §15-17 (editor chrome), §21 (context strategy).

import { useState, useCallback, useRef } from 'react';
import { useAgentSessionStore, type AgentMode } from '../agent/session/store';
import { useSelectionStore } from './stores/selectionStore';
import { runAgentTurn } from '../agent/orchestrator';
import type { LLMConfig } from '../agent/transport/types';

const DEFAULT_BASE_URL = 'https://api.deepinfra.com/v1';
const DEFAULT_MODEL = 'google/gemma-4-31B-it';

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

    try {
      await runAgentTurn(config, {
        message: msg,
        mode: session.mode,
        signal: abort.signal,
        selectedNodeIds,
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 13 }}>
      {/* Mode selector */}
      <div style={{ display: 'flex', gap: 4, padding: '6px 8px', borderBottom: '1px solid #333' }}>
        <span style={{ color: '#888', marginRight: 4 }}>Mode:</span>
        {(['read-only', 'copilot', 'sandbox'] as AgentMode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              flex: 1,
              padding: '2px 6px',
              border: '1px solid #444',
              borderRadius: 3,
              cursor: 'pointer',
              fontSize: 11,
              background: session.mode === m ? '#2a4a6a' : '#1a1a1a',
              color: session.mode === m ? '#88ccff' : '#888',
            }}
          >
            {m}
          </button>
        ))}
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflow: 'auto', padding: 8 }} data-testid="agent-messages">
        {session.messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              marginBottom: 8,
              padding: '6px 8px',
              borderRadius: 4,
              background: msg.role === 'assistant' ? '#1a1a2e' : '#222',
              borderLeft: `3px solid ${msg.role === 'assistant' ? '#88aaff' : '#5af07a'}`,
            }}
          >
            <div style={{ fontSize: 11, color: '#666', marginBottom: 2 }}>
              {msg.role === 'assistant' ? 'Agent' : 'You'}
            </div>
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {msg.content || (session.isStreaming ? '...' : '')}
            </div>
          </div>
        ))}
        {session.error && (
          <div style={{ padding: '6px 8px', color: '#ff8888', fontSize: 12 }}>
            Error: {session.error}
          </div>
        )}
      </div>

      {/* Token usage */}
      {session.tokenUsage.total > 0 && (
        <div
          style={{ padding: '2px 8px', fontSize: 11, color: '#555', textAlign: 'right' }}
          data-testid="agent-tokens"
        >
          Tokens: {session.tokenUsage.total.toLocaleString()} (↑{session.tokenUsage.input} / ↓{session.tokenUsage.output})
        </div>
      )}

      {/* Input area */}
      <div style={{ borderTop: '1px solid #333', padding: 6 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={running ? 'Waiting for response...' : 'Ask the agent...'}
            disabled={running}
            rows={2}
            style={{
              flex: 1,
              background: '#111',
              border: '1px solid #333',
              borderRadius: 4,
              padding: '4px 6px',
              color: '#ccc',
              fontSize: 12,
              resize: 'none',
              fontFamily: 'inherit',
            }}
          />
          {running ? (
            <button
              onClick={handleCancel}
              style={{
                padding: '4px 10px',
                border: '1px solid #844',
                borderRadius: 4,
                cursor: 'pointer',
                background: '#2a1a1a',
                color: '#ff8888',
                fontSize: 12,
              }}
            >
              Cancel
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              style={{
                padding: '4px 10px',
                border: '1px solid #444',
                borderRadius: 4,
                cursor: input.trim() ? 'pointer' : 'default',
                background: input.trim() ? '#2d6a4f' : '#222',
                color: input.trim() ? '#fff' : '#666',
                fontSize: 12,
              }}
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
