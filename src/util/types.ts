// App-owned domain types for the feedback-assistant dashboard.
//
// These mirror the JSON shapes returned by the backend's /api endpoints
// (feedback-dashboard-api.js). The backend stays JavaScript, so there is no
// shared type to import — these are the frontend's source of truth for the
// data it renders. Fields are optional where the API omits them (e.g. masked
// keys, nullable greetings) so views stay null-safe.

/** A feedback project — owns a widget key, daily budget, and changelog. */
export interface Project {
  id: string;
  name: string;
  /** Public widget key (pk_*); masked after the one-time create/rotate reveal. */
  publicKey: string;
  /** Comma-separated allowed origins (logged for hygiene, not enforced). */
  allowedOrigins?: string;
  /** Hard ceiling on submissions accepted per UTC day. */
  dailyBudget?: number;
  /** Optional greeting bubble shown by the widget. */
  greeting?: string | null;
  /** Creation time in epoch milliseconds. */
  createdAt?: number;
}

/** Lifecycle status of a feedback submission. */
export type SubmissionStatus = 'new' | 'read' | 'archived';

/** A single end-user feedback submission. */
export interface Submission {
  id: string;
  message: string;
  status: SubmissionStatus;
  /** Owning project id (always present from list/detail APIs). */
  projectId?: string;
  /** Owning project display name. */
  projectName?: string;
  endUserName?: string | null;
  endUserEmail?: string | null;
  /** URL the widget was on when the feedback was sent. */
  url?: string | null;
  /** Screenshot attachment id, if the user captured one. */
  screenshotId?: string | null;
  appVersion?: string | null;
  userAgent?: string | null;
  /** Submission time in epoch milliseconds. */
  createdAt?: number;
}

/**
 * Submission detail dialog state: either a loaded submission or a bare error
 * sentinel when the fetch failed. Narrow on `error` to discriminate — the
 * loaded branch never carries it, so `!detail.error` yields the Submission.
 */
export type SubmissionDetail = (Submission & { error?: undefined }) | { error: true };

/** A changelog entry shown in the widget's "What's New" tab. */
export interface ChangelogEntry {
  id: string;
  title: string;
  body?: string;
  /** Publish time in epoch milliseconds; falsy means draft. */
  publishedAt?: number | null;
  sortOrder?: number;
}

/** Widget bundle SRI metadata used to pin the embed snippet. */
export interface WidgetIntegrity {
  version?: string;
  integrity?: string | null;
}
