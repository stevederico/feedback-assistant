/**
 * Load dottie-analytics tracker from build-time env (OSS-safe).
 *
 * Never hardcode write_key in this public repo — Railway/Docker must set:
 *   VITE_ANALYTICS_ID=<site write_key>
 * Optional:
 *   VITE_ANALYTICS_SRC  (defaults to https://api.dottie.ai/script.js)
 *   VITE_ANALYTICS_DOMAINS=feedback.dottie.ai
 *
 * No-op when VITE_ANALYTICS_ID is unset (local OSS clones / dev without analytics).
 */

/** Public tracker host — not a secret; only the write_key is. */
const DEFAULT_ANALYTICS_SRC = 'https://api.dottie.ai/script.js';

/** Inject the tracker script when env is configured. Call once at app boot. */
export function loadAnalytics(): void {
  if (typeof document === 'undefined') return;

  const id = import.meta.env.VITE_ANALYTICS_ID;
  if (typeof id !== 'string' || !id.trim()) return;

  const srcRaw = import.meta.env.VITE_ANALYTICS_SRC;
  const src =
    typeof srcRaw === 'string' && srcRaw.trim() ? srcRaw.trim() : DEFAULT_ANALYTICS_SRC;

  // Avoid double-inject on HMR
  const websiteId = id.trim();
  if ([...document.querySelectorAll('script[data-website-id]')].some(
    (el) => el instanceof HTMLScriptElement && el.dataset.websiteId === websiteId,
  )) return;

  const s = document.createElement('script');
  s.defer = true;
  s.src = src;
  s.dataset.websiteId = websiteId;
  const domains = import.meta.env.VITE_ANALYTICS_DOMAINS;
  if (typeof domains === 'string' && domains.trim()) {
    s.dataset.domains = domains.trim();
  }
  document.head.appendChild(s);
}
