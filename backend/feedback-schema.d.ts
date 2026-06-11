/**
 * Type declarations for the feedback-assistant schema bootstrap (feedback-schema.js).
 *
 * The implementation stays JavaScript on purpose — it is app-specific DDL that
 * sits on top of skateboard's core tables. This sidecar covers only what
 * server.ts imports.
 */

import type { DatabaseSync } from 'node:sqlite';

/**
 * Create feedback-assistant tables + indexes if missing (idempotent).
 *
 * @param db node:sqlite DatabaseSync instance (the raw bound database handle)
 */
export function bootstrapFeedbackSchema(db: DatabaseSync): void;
