# Hetvābhāsa — Error Patterns

> Empty at project start. Patterns accumulate as bugs are diagnosed and fixed. Every fix that took >1 attempt OR revealed a non-obvious root cause MUST be cataloged here.

## Format

```
### H<N>: <short pattern name>

**Symptom:** what the user sees
**Trap:** the wrong fix (the one that "feels right" but doesn't address root cause)
**Root cause:** the actual mechanism
**Real fix:** what works
**Detection signal:** the early symptom that distinguishes this from look-alikes
**REF:** Ground Truth doc + file:line citations
**Origin:** session/date when first observed
```

## Predicted patterns (forward-looking, from THESIS.md §57)

These are not yet cataloged from real bugs — they are pre-mortem predictions. Promote to formal entries once observed.

- **Pure-flag lying** — node declares `pure: true` but reads `Math.random` or `Date.now`; cache corrupts; bugs look random.
- **Time-as-closure** — node captures time via `useFrame` closure instead of `Time` socket; render-frame-N ≠ viewport-at-time-T.
- **Op bypass** — direct `dagStore.setState` outside dispatcher; undo no-ops, agent control breaks at this node type.
- **Agent tool-call drift** — agent calls tool with valid-looking but wrong-shape params; zod rejects; agent loops trying same call.
- **OPFS quota silent fail** — save returns success but data truncated; reload loses last changes.
- **Capability leak** — code assumes desktop fs and breaks in web build (or vice versa); discovered at production time.
- **Triplex JSX-as-truth leak** — code expects Triplex's scene model; breaks because DAG is the truth, JSX is a view.

---

## Cataloged patterns

> None yet.
