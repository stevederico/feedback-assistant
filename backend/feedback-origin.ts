/**
 * Per-project origin allowlist for the widget `/v1` API.
 *
 * Empty list = allow any origin (default for new projects).
 * Non-empty = request `Origin` must match an entry exactly (full origin URL)
 * or a `*.example.com` host pattern (apex + subdomains).
 */

/**
 * Parse a comma-separated allowlist string.
 *
 * @param csv - Raw `allowed_origins` column (or null)
 * @returns Non-empty list of entries, or `null` when empty (allow all)
 */
export function parseAllowedOrigins(csv: string | null | undefined): string[] | null {
  if (csv === null || csv === undefined) return null;
  const parts = csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length === 0 ? null : parts;
}

/**
 * Whether a request Origin may use a project with the given allowlist.
 *
 * @param origin - Request `Origin` header (full origin URL, e.g. https://app.example.com)
 * @param allowed - Result of {@link parseAllowedOrigins}; `null` means allow all
 */
export function isOriginAllowed(
  origin: string | null | undefined,
  allowed: string[] | null,
): boolean {
  if (allowed === null) return true;
  if (!origin || typeof origin !== 'string') return false;

  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }

  for (const entry of allowed) {
    if (entry.startsWith('*.')) {
      const base = entry.slice(2).toLowerCase();
      if (!base) continue;
      const host = hostname.toLowerCase();
      if (host === base || host.endsWith(`.${base}`)) return true;
      continue;
    }
    if (entry === origin) return true;
    // Bare hostname entry (no scheme) — match host only.
    if (!entry.includes('://') && entry.toLowerCase() === hostname.toLowerCase()) {
      return true;
    }
  }
  return false;
}
