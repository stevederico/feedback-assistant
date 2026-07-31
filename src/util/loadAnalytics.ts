/**
 * Load dottie-analytics tracker from build-time env (OSS-safe).
 *
 * Never hardcode write_key in this public repo — Railway/Docker must set:
 *   VITE_ANALYTICS_SRC=https://api.dottie.ai/script.js
 *   VITE_ANALYTICS_ID=<site write_key>
 * Optional:
 *   VITE_ANALYTICS_DOMAINS=feedback.dottie.ai
 *
 * No-op when vars are unset (local OSS clones / dev without analytics).
 */

/** Inject the tracker script when env is configured. Call once at app boot. */
export function loadAnalytics(): void {
  if (typeof document === 'undefined') return;

  const id = import.meta.env.VITE_ANALYTICS_ID;
  const src = import.meta.env.VITE_ANALYTICS_SRC;
  if (typeof id !== 'string' || !id.trim() || typeof src !== 'string' || !src.trim()) {
    return;
  }

  // Avoid double-inject on HMR
  if (document.querySelector(`script[data-website-id="${id}"]`)) return;

  const s = document.createElement('script');
  s.defer = true;
  s.src = src.trim();
  s.dataset.websiteId = id.trim();
  const domains = import.meta.env.VITE_ANALYTICS_DOMAINS;
  if (typeof domains === 'string' && domains.trim()) {
    s.dataset.domains = domains.trim();
  }
  document.head.appendChild(s);
}
