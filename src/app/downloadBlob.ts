// downloadBlob — trigger a browser download of a Blob under a filename. Shared
// by the still render (#168) and the animation render (#189) so the
// object-URL lifecycle (revoke after the click) lives in ONE place.

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has consumed the URL.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
