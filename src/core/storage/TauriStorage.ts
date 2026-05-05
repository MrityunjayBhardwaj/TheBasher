// Tauri-backed storage. Stub only in v0.5 — implemented in v0.6.
//
// The class exists so feature-detection sites (capability factory) can name
// it without ifdefs. Calling any method throws an explicit "v0.6" error.
//
// REF: THESIS.md §33, vyapti V6.

import type { StorageCapability, StorageQuota } from './StorageCapability';

export class TauriStorage implements StorageCapability {
  readonly id = 'tauri';
  readonly kind = 'tauri-fs' as const;

  async isAvailable(): Promise<boolean> {
    return false;
  }

  private notYet(): never {
    throw new Error('TauriStorage: ships in v0.6');
  }

  async write(_path: string, _bytes: Uint8Array): Promise<void> {
    this.notYet();
  }
  async read(_path: string): Promise<Uint8Array> {
    this.notYet();
  }
  async exists(_path: string): Promise<boolean> {
    this.notYet();
  }
  async delete(_path: string): Promise<void> {
    this.notYet();
  }
  async list(_dirPath: string): Promise<string[]> {
    this.notYet();
  }
  async quota(): Promise<StorageQuota | null> {
    this.notYet();
  }
}
