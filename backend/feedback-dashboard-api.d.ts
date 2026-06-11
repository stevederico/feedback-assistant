/**
 * Type declarations for the dashboard API factory (feedback-dashboard-api.js).
 *
 * The implementation stays JavaScript on purpose — app-specific Hono sub-app
 * mounted under /api for the feedback dashboard. This sidecar covers what
 * server.ts imports.
 */

import type { Hono, MiddlewareHandler } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from './types.ts';

/** Options for {@link createFeedbackDashboardApi}. */
export interface FeedbackDashboardApiOptions {
  db: DatabaseSync;
  authMiddleware: MiddlewareHandler;
  csrfProtection: MiddlewareHandler;
  logger?: Logger;
  widgetVersion?: string | null;
  widgetIntegrity?: string | null;
}

/** Build the feedback dashboard Hono sub-app (mounted under /api). */
export function createFeedbackDashboardApi(options: FeedbackDashboardApiOptions): Hono;
