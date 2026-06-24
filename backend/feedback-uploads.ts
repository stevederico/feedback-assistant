// Screenshot upload helpers for feedback-assistant.
// Storage layout: <UPLOADS_DIR>/<uuid>  (no extension; content_type lives in DB)
// Mirrors fund-admin's pattern: UUID filename, streaming GET, async unlink.

import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from './types.ts';

// Default is relative to the backend process CWD, which is the backend/ dir
// (npm runs the workspace script with CWD = backend/). On Railway the volume
// mounts at ./databases, so the same path works in prod.
const DEFAULT_UPLOADS_DIR = './databases/uploads';
const MAX_SCREENSHOT_BYTES = parseInt(
  process.env.MAX_SCREENSHOT_BYTES || String(2 * 1024 * 1024),
  10
);
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png']);

let uploadsDirCache: string | null = null;

/**
 * Resolve the uploads dir (env override or default), ensuring it exists.
 * Idempotent; cached after first call.
 */
export async function ensureUploadsDir(): Promise<string> {
  if (uploadsDirCache) return uploadsDirCache;
  const dir = path.resolve(process.env.UPLOADS_DIR || DEFAULT_UPLOADS_DIR);
  await mkdir(dir, { recursive: true });
  uploadsDirCache = dir;
  return dir;
}

/** Current uploads dir (resolved from env or default), without creating it. */
export function getUploadsDir(): string {
  return uploadsDirCache || path.resolve(process.env.UPLOADS_DIR || DEFAULT_UPLOADS_DIR);
}

/** Maximum allowed screenshot size in bytes. */
export function getMaxScreenshotBytes(): number {
  return MAX_SCREENSHOT_BYTES;
}

/** True if the given MIME type is an allowed screenshot format. */
export function isAllowedMime(mime: string): boolean {
  return ALLOWED_MIME.has((mime || '').toLowerCase());
}

/**
 * Save a Buffer to disk under a fresh UUID. Returns the id used.
 * Throws on filesystem failure.
 */
export async function saveScreenshotFile(buffer: Buffer): Promise<string> {
  const dir = await ensureUploadsDir();
  const id = randomUUID();
  await writeFile(path.join(dir, id), buffer);
  return id;
}

/**
 * Build a streaming Response for a stored screenshot.
 * Returns null if the file is missing on disk.
 */
export function streamScreenshotResponse(
  id: string,
  contentType: string,
  sizeBytes: number
): Response | null {
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
export async function deleteScreenshotFile(id: string, logger?: Logger): Promise<void> {
  const dir = getUploadsDir();
  const filePath = path.join(dir, id);
  try {
    await unlink(filePath);
  } catch (err) {
    // Narrow the unknown error to read its code/message without casts.
    const code = err instanceof Error && 'code' in err ? err.code : undefined;
    if (code !== 'ENOENT') {
      const message = err instanceof Error ? err.message : String(err);
      logger?.warn?.('screenshot unlink failed', { id, error: message });
    }
  }
}
