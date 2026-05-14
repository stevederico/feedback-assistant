import packageJson from '../../package.json';

export function embedSnippet(publicKey) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const version = packageJson.version;
  return `<script
  src="${origin}/widget/v${version}.js"
  data-project="${publicKey}"
  defer
></script>`;
}
