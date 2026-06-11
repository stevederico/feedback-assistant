import { toast } from 'sonner';

/**
 * Copy text to the clipboard, surfacing success/failure via a toast.
 *
 * Uses the async Clipboard API (no-ops with an error toast where unavailable,
 * e.g. non-secure contexts). Shared by the project/embed-snippet views.
 *
 * @param text - Text to write to the clipboard (no-op when falsy)
 */
export function copyToClipboard(text: string | null | undefined): void {
  if (!text) return;
  navigator.clipboard?.writeText(text).then(
    () => toast.success('Copied to clipboard'),
    () => toast.error('Could not copy'),
  );
}
