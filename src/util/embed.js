import packageJson from '../../package.json';

/**
 * Build the `<script>` embed snippet a customer pastes into their site.
 *
 * The widget is served from this dashboard's own origin at a versioned,
 * immutable URL. `data-api` is set explicitly so the widget posts to this
 * host's `/v1` API regardless of which origin the customer embeds it on.
 * When an SRI `integrity` hash is supplied, it is emitted alongside
 * `crossorigin="anonymous"` so browsers verify the bytes before executing.
 *
 * @param {string} publicKey - Project public key (pk_*)
 * @param {Object} [opts]
 * @param {string} [opts.version] - Widget version to pin (defaults to app version)
 * @param {string|null} [opts.integrity] - SRI hash, e.g. "sha384-..." (omitted when falsy)
 * @returns {string} The embed snippet HTML
 */
export function embedSnippet(publicKey, opts = {}) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const version = opts.version || packageJson.version;
  const integrityAttr = opts.integrity
    ? `\n  integrity="${opts.integrity}"\n  crossorigin="anonymous"`
    : '';
  return `<script
  src="${origin}/widget/v${version}.js"
  data-project="${publicKey}"
  data-api="${origin}/v1"${integrityAttr}
  defer
></script>`;
}
