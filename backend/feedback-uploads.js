// Screenshot upload helpers for feedback-assistant.
// Storage layout: <UPLOADS_DIR>/<uuid>  (no extension; content_type lives in DB)
// Mirrors fund-admin's pattern: UUID filename, streaming GET, async unlink.

import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Default is relative to the backend process CWD, which is the backend/ dir
// (npm runs the workspace script with CWD = backend/). On Railway the volume
// mounts at ./databases, so the same path works in prod.
const DEFAULT_UPLOADS_DIR = './databases/uploads';
const MAX_SCREENSHOT_BYTES = parseInt(
  process.env.MAX_SCREENSHOT_BYTES || String(2 * 1024 * 1024),
  10
);
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png']);

let uploadsDirCache = null;

/**
 * Resolve the uploads dir (env override or default), ensuring it exists.
 * Idempotent; cached after first call.
 */
export async function ensureUploadsDir() {
  if (uploadsDirCache) return uploadsDirCache;
  const dir = path.resolve(process.env.UPLOADS_DIR || DEFAULT_UPLOADS_DIR);
  await mkdir(dir, { recursive: true });
  uploadsDirCache = dir;
  return dir;
}

export function getUploadsDir() {
  return uploadsDirCache || path.resolve(process.env.UPLOADS_DIR || DEFAULT_UPLOADS_DIR);
}

export function getMaxScreenshotBytes() {
  return MAX_SCREENSHOT_BYTES;
}

export function isAllowedMime(mime) {
  return ALLOWED_MIME.has((mime || '').toLowerCase());
}

/**
 * Save a Buffer to disk under a fresh UUID. Returns the id used.
 * Throws on filesystem failure.
 */
export async function saveScreenshotFile(buffer) {
  const dir = await ensureUploadsDir();
  const id = randomUUID();
  await writeFile(path.join(dir, id), buffer);
  return id;
}

/**
 * Build a streaming Response for a stored screenshot.
 * Returns null if the file is missing on disk.
 */
export function streamScreenshotResponse(id, contentType, sizeBytes) {
  const dir = getUploadsDir();
  const filePath = path.join(dir, id);
  if (!existsSync(filePath)) return null;
  const nodeStream = createReadStream(filePath);
  return new Response(Readable.toWeb(nodeStream), {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(sizeBytes),
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}

/**
 * Remove a screenshot file from disk. Best-effort; logs failure but never throws.
 */
export async function deleteScreenshotFile(id, logger) {
  const dir = getUploadsDir();
  const filePath = path.join(dir, id);
  try {
    await unlink(filePath);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      logger?.warn?.('screenshot unlink failed', { id, error: err.message });
    }
  }
}
