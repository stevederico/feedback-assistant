import packageJson from '../../package.json';

/** Options for {@link embedSnippet}. */
export interface EmbedSnippetOptions {
  /**
   * When true (or when `version` is set), emit a version-pinned immutable URL
   * instead of auto-updating `/widget.js`. Optional SRI via `integrity`.
   */
  pin?: boolean;
  /** Widget version to pin (defaults to app version). Implies pin. */
  version?: string;
  /** SRI hash for pinned embeds only, e.g. "sha384-..." (omitted when falsy). */
  integrity?: string | null;
}

/**
 * Build the `<script>` embed snippet a customer pastes into their site.
 *
 * **Default (auto-update):** `src` is `/widget.js` — always the latest deploy
 * (short cache). No SRI, because the bytes change over time.
 *
 * **Pinned:** pass `{ pin: true }` or `{ version, integrity }` for an immutable
 * `/widget/vX.Y.Z.js` URL (optional integrity + crossorigin).
 *
 * `data-api` always points at this host's `/v1`.
 *
 * @param publicKey - Project public key (pk_*)
 * @param opts - Optional pin / version / integrity overrides
 * @returns The embed snippet HTML
 */
export function embedSnippet(
  publicKey: string,
  opts: EmbedSnippetOptions | null = {},
): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const pin = opts?.pin === true || Boolean(opts?.version);
  if (pin) {
    const version = opts?.version || packageJson.version;
    const integrityAttr = opts?.integrity
      ? `\n  integrity="${opts.integrity}"\n  crossorigin="anonymous"`
      : '';
    return `<script
  src="${origin}/widget/v${version}.js"
  data-project="${publicKey}"
  data-api="${origin}/v1"${integrityAttr}
  defer
></script>`;
  }
  return `<script
  src="${origin}/widget.js"
  data-project="${publicKey}"
  data-api="${origin}/v1"
  defer
></script>`;
}
