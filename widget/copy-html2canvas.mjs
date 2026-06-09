// Vendor html2canvas into widget/dist as a self-hosted, immutably-cached asset.
// Runs after `vite build` (which empties dist), so the file survives. The widget
// lazy-loads it from /widget/html2canvas-v1.js only when a screenshot is taken,
// keeping it out of the main IIFE bundle.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

// Resolve the package's UMD build regardless of npm workspace hoisting.
const pkgMain = require.resolve('html2canvas'); // .../html2canvas/dist/html2canvas.js
const src = resolve(dirname(pkgMain), 'html2canvas.min.js');

const destDir = resolve(here, 'dist');
const dest = resolve(destDir, 'html2canvas-v1.js');

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log('Vendored html2canvas →', dest);
