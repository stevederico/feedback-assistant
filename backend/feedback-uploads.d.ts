/**
 * Type declarations for the screenshot upload helpers (feedback-uploads.js).
 *
 * The implementation stays JavaScript on purpose — app-specific filesystem
 * helpers for stored widget screenshots. This sidecar mirrors the public
 * exports consumed by server.ts and the dashboard/widget APIs.
 */

import type { Logger } from './types.ts';

/** Resolve the uploads dir (env override or default), ensuring it exists. Cached. */
export function ensureUploadsDir(): Promise<string>;

/** Current uploads dir (resolved from env or default), without creating it. */
export function getUploadsDir(): string;

/** Maximum allowed screenshot size in bytes. */
export function getMaxScreenshotBytes(): number;

/** True if the given MIME type is an allowed screenshot format. */
export function isAllowedMime(mime: string): boolean;

/** Save a Buffer to disk under a fresh UUID. Returns the id used. */
export function saveScreenshotFile(buffer: Buffer): Promise<string>;

/** Build a streaming Response for a stored screenshot, or null if missing. */
export function streamScreenshotResponse(id: string, contentType: string, sizeBytes: number): Response | null;

/** Remove a screenshot file from disk. Best-effort; never throws. */
export function deleteScreenshotFile(id: string, logger?: Logger): Promise<void>;
