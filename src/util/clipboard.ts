/**
 * Copy text to the clipboard (no-ops when empty or Clipboard API unavailable).
 *
 * @param text - Text to write to the clipboard
 */
export function copyToClipboard(text: string | null | undefined): void {
  if (!text) return;
  void navigator.clipboard?.writeText(text);
}
