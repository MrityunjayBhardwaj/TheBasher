// Project images — the image files a project owns (#1050).
//
// An imported texture is part of what was imported, so it lives with the project, the way an
// imported mesh does (#1049). Unlike the mesh it is NOT inline in the project file: every autosave
// rewrites that file, and measured in Chromium a 101 MB project file took 4–5 s to write, where a
// real model's images alone reach 76 MB. So the bytes sit in a folder beside the project file,
// written once at import, and the material refers to them by key.
//
// A key is `<sha256>.<ext>`, relative to the project. Nothing outside this module spells the
// folder, so a project copied under a new id — duplicated, or opened from a `.basher` bundle —
// needs its files moved and never its refs rewritten.
//
// The bytes are the file's own PNG/JPEG encoding, never decoded pixels: raw RGBA measured 1.7× to
// 125× larger on real models. Those two are the image types core glTF allows; anything else is the
// reader's to refuse before it reaches here.
//
// REF: issue #1050 (decision comment 2026-09-14); src/core/project/io.ts (duplicate/delete carry
//      the folder); src/app/asset/bakedTextureStore.ts (`refToPath` resolves a project ref);
//      src/app/sceneBundle.ts (export/import carry it).

import type { StorageCapability } from '../storage/StorageCapability';

const EXTENSION_OF_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

const KEY = /^[0-9a-f]{64}\.(png|jpg)$/;

/** True for a key this store could have written — and nothing that could leave the folder. */
export function isProjectImageKey(key: string): boolean {
  return KEY.test(key);
}

/** The extension a project stores an image of this MIME type under, or null when it stores none. */
export function projectImageExtension(mime: string): string | null {
  return EXTENSION_OF_MIME[mime] ?? null;
}

export function projectImagesDir(projectId: string): string {
  return `projects/${projectId}/images`;
}

export function projectImagePath(projectId: string, key: string): string {
  if (!isProjectImageKey(key)) throw new Error(`projectImages: not an image key: ${key}`);
  return `${projectImagesDir(projectId)}/${key}`;
}

/**
 * Store an image's encoded bytes in a project and return its key. Idempotent: the same bytes are
 * one file however many materials use them.
 */
export async function writeProjectImage(
  storage: StorageCapability,
  projectId: string,
  bytes: Uint8Array,
  mime: string,
): Promise<string> {
  const extension = projectImageExtension(mime);
  if (extension === null) throw new Error(`projectImages: a project does not store ${mime}`);
  // A detached copy: `digest` and the storage write both want bytes nobody else can change.
  const own = new Uint8Array(bytes.byteLength);
  own.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', own));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  const key = `${hex}.${extension}`;
  const path = projectImagePath(projectId, key);
  if (!(await storage.exists(path))) await storage.write(path, own);
  return key;
}

/** Every image key a project holds. A project that never stored one has no folder. */
export async function listProjectImages(
  storage: StorageCapability,
  projectId: string,
): Promise<string[]> {
  let children: string[];
  try {
    children = await storage.list(projectImagesDir(projectId));
  } catch {
    return [];
  }
  return children.filter(isProjectImageKey);
}

/** Give `toId` every image `fromId` holds. */
export async function copyProjectImages(
  storage: StorageCapability,
  fromId: string,
  toId: string,
): Promise<void> {
  for (const key of await listProjectImages(storage, fromId)) {
    const target = projectImagePath(toId, key);
    if (await storage.exists(target)) continue;
    await storage.write(target, await storage.read(projectImagePath(fromId, key)));
  }
}

export async function deleteProjectImages(
  storage: StorageCapability,
  projectId: string,
): Promise<void> {
  for (const key of await listProjectImages(storage, projectId)) {
    await storage.delete(projectImagePath(projectId, key));
  }
}
