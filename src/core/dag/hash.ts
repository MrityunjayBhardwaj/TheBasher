// Deterministic content hash (FNV-1a 32-bit) over a stable JSON string.
//
// V0.5 uses pure JS — fast enough for the default DAG (4 nodes) and well below
// the 16ms per-edit budget for typical projects (THESIS.md §53). xxhash-wasm
// can replace this if profiling demands it; the API stays the same.
//
// Stability requires sorting object keys recursively so { a:1, b:2 } and
// { b:2, a:1 } produce the same hash. Arrays preserve order.
//
// REF: THESIS.md §10, §51 (caching correctness).

export type ContentHash = string;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(',')}}`;
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function hashString(s: string): ContentHash {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV-1a multiplication via Math.imul.
    h = Math.imul(h, FNV_PRIME);
  }
  // Force unsigned 32-bit and pad to 8 hex chars.
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function hashValue(value: unknown): ContentHash {
  return hashString(stableStringify(value));
}
