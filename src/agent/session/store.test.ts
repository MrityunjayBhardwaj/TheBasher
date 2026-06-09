// Agent session store — default mode contract.
//
// The chat is a single text bar ("just say the word…") with no mode selector,
// so the agent must default to an ACTING mode, not read-only. copilot routes
// every mutation through the Diff approval (orchestrator), so "say the word →
// it proposes → you approve". The read-only / sandbox levels still exist for
// programmatic use; only the SELECTOR left the UI.

import { describe, expect, it, beforeEach } from 'vitest';
import { useAgentSessionStore } from './store';

describe('agent session store — default mode', () => {
  beforeEach(() => {
    useAgentSessionStore.getState().reset();
  });

  it('defaults to copilot (acts on a request, not read-only)', () => {
    // Revert the INITIAL_SESSION default to 'read-only' → the agent can only
    // inspect and the "just say the word" bar is a lie → this fails.
    expect(useAgentSessionStore.getState().session.mode).toBe('copilot');
  });

  it('still exposes the other autonomy levels via setMode (capability intact)', () => {
    useAgentSessionStore.getState().setMode('read-only');
    expect(useAgentSessionStore.getState().session.mode).toBe('read-only');
    useAgentSessionStore.getState().setMode('sandbox');
    expect(useAgentSessionStore.getState().session.mode).toBe('sandbox');
  });
});
