import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('widget source', () => {
  it('builds DOM without innerHTML so Trusted Types can load the embed', () => {
    const src = readFileSync(resolve(root, 'widget/src/index.js'), 'utf8');
    assert.equal(/\.innerHTML\s*=/.test(src), false);
  });
});
