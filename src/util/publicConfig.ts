/**
 * Public site identity overrides for OSS-friendly deploys.
 *
 * Defaults live in `src/constants.json` (generic placeholders). Production
 * hosts set Railway (or Docker) env vars at **build** time so Vite can bake
 * them into the SPA and SEO plugins:
 *
 * - `COMPANY_WEBSITE` — host or URL (e.g. `feedback.example.com`)
 * - `COMPANY_EMAIL` — support address
 * - Fallbacks: `VITE_COMPANY_WEBSITE` / `VITE_COMPANY_EMAIL`, then host of `FRONTEND_URL`
 *
 * Requires `envPrefix` to include `COMPANY_` in vite.config (see that file).
 */

/** Minimal constants fields this module may override. */
export interface PublicConfigFields {
  companyWebsite: string;
  companyEmail: string;
}

/**
 * Normalize a host or absolute URL to a bare host (no scheme, no path).
 *
 * @param raw - Host like `example.com` or URL like `https://example.com/app`
 * @returns Hostname suitable for constants.companyWebsite
 */
export function hostFromEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  try {
    if (trimmed.includes('://')) {
      return new URL(trimmed).host;
    }
  } catch {
    /* treat as host-like string */
  }
  return trimmed.replace(/^\/\//, '').replace(/\/.*$/, '');
}

/**
 * Read a non-empty env string from Vite `import.meta.env` and/or `process.env`.
 *
 * @param names - Candidate variable names in priority order
 * @returns Trimmed value, or undefined when unset
 */
function readEnv(...names: string[]): string | undefined {
  // import.meta.env exists under Vite; under node:test it may be undefined.
  const meta =
    typeof import.meta !== 'undefined' && import.meta.env && typeof import.meta.env === 'object'
      ? (import.meta.env as Record<string, string | boolean | undefined>)
      : null;
  if (meta) {
    for (const name of names) {
      const fromMeta = meta[name];
      if (typeof fromMeta === 'string' && fromMeta.trim()) {
        return fromMeta.trim();
      }
    }
  }
  if (typeof process !== 'undefined' && process.env) {
    for (const name of names) {
      const fromProcess = process.env[name];
      if (typeof fromProcess === 'string' && fromProcess.trim()) {
        return fromProcess.trim();
      }
    }
  }
  return undefined;
}

/**
 * Apply deploy-time env overrides onto constants public identity fields.
 *
 * @param base - Constants object (typically from constants.json)
 * @returns Shallow copy with companyWebsite / companyEmail possibly replaced
 */
export function applyPublicConfigOverrides<T extends PublicConfigFields>(base: T): T {
  const websiteRaw =
    readEnv('COMPANY_WEBSITE', 'VITE_COMPANY_WEBSITE') ??
    readEnv('FRONTEND_URL', 'VITE_FRONTEND_URL');
  const emailRaw = readEnv('COMPANY_EMAIL', 'VITE_COMPANY_EMAIL');

  return {
    ...base,
    companyWebsite: websiteRaw ? hostFromEnvValue(websiteRaw) : base.companyWebsite,
    companyEmail: emailRaw ?? base.companyEmail,
  };
}
