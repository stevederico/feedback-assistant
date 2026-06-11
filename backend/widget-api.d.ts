/**
 * Type declarations for the widget ingest API factory (widget-api.js).
 *
 * The implementation stays JavaScript on purpose — app-specific Hono sub-app
 * mounted at /v1 for widget submissions/screenshots. This sidecar covers what
 * server.ts imports.
 */

import type { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from './types.ts';

/** Options for {@link createWidgetApi}. */
export interface WidgetApiOptions {
  logger?: Logger;
  db: DatabaseSync;
}

/** Build the widget ingest Hono sub-app (mounted at /v1). */
export function createWidgetApi(options?: WidgetApiOptions): Hono;
