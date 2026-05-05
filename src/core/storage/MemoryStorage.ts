// In-memory StorageCapability. Tests + Node-side scripts only — never
// shipped to a user-facing surface (no persistence).
//
// Mirrors OPFS semantics enough that round-trip tests pass without a real
// browser: same path normalization, idempotent delete, listed directories
// include every file whose path begins with `${dirPath}/`.

import type { StorageCapability, StorageQuota } from './StorageCapability';

export class MemoryStorage implements StorageCapability {
  readonly id = 'memory';
  readonly kind = 'memory' as const;
  private files = new Map<string, Uint8Array>();

  async isAvailable(): Promise<boolean> {
    return true;
  }

  private normalize(path: string): string {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) throw new Error('MemoryStorage: empty path');
    return parts.join('/');
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const norm = this.normalize(path);
    this.files.set(norm, new Uint8Array(bytes));
  }

  async read(path: string): Promise<Uint8Array> {
    const norm = this.normalize(path);
    const buf = this.files.get(norm);
    if (!buf) throw new Error(`MemoryStorage: not found: ${norm}`);
    return new Uint8Array(buf);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(this.normalize(path));
  }

  async delete(path: string): Promise<void> {
    this.files.delete(this.normalize(path));
  }

  async list(dirPath: string): Promise<string[]> {
    const prefix = dirPath.split('/').filter(Boolean).join('/');
    const out = new Set<string>();
    for (const key of this.files.keys()) {
      if (prefix === '' || key === prefix || key.startsWith(`${prefix}/`)) {
        const relative = prefix === '' ? key : key.slice(prefix.length + 1);
        const head = relative.split('/')[0];
        if (head) out.add(head);
      }
    }
    return [...out];
  }

  async quota(): Promise<StorageQuota | null> {
    return null;
  }
}
