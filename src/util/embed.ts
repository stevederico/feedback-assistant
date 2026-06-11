import packageJson from '../../package.json';

/** Options for {@link embedSnippet}. Matches the {@link WidgetIntegrity} shape. */
export interface EmbedSnippetOptions {
  /** Widget version to pin (defaults to app version). */
  version?: string;
  /** SRI hash, e.g. "sha384-..." (omitted when falsy). */
  integrity?: string | null;
}

/**
 * Build the `<script>` embed snippet a customer pastes into their site.
 *
 * The widget is served from this dashboard's own origin at a versioned,
 * immutable URL. `data-api` is set explicitly so the widget posts to this
 * host's `/v1` API regardless of which origin the customer embeds it on.
 * When an SRI `integrity` hash is supplied, it is emitted alongside
 * `crossorigin="anonymous"` so browsers verify the bytes before executing.
 *
 * @param publicKey - Project public key (pk_*)
 * @param opts - Optional version/integrity overrides
 * @returns The embed snippet HTML
 */
export function embedSnippet(
  publicKey: string,
  opts: EmbedSnippetOptions | null = {},
): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
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
