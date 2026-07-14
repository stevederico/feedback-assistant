// Thin wrapper over skateboard-ui's apiRequest, scoped to feedback-assistant's
// /api/* endpoints (everything mounted by feedback-dashboard-api).
//
// apiRequest already handles cookies, CSRF header, 30s timeout, and 401 redirect.

import { apiRequest, getBackendURL } from '@stevederico/skateboard-ui/Utilities';
import type { ApiRequestOptions } from '@stevederico/skateboard-ui/Utilities';
import type {
  App,
  Submission,
  SubmissionDetail,
  ChangelogEntry,
  WidgetIntegrity,
} from './types';

/** App as returned by create/rotate — always includes the full publicKey. */
type AppWithKey = App & { publicKey: string };

/** Query params accepted by the submissions list endpoint. */
interface SubmissionListParams {
  status?: string;
  q?: string;
  limit?: number;
}

/** A single reorder instruction: an entry id and its new 1-based position. */
interface ReorderItem {
  id: string;
  sortOrder: number;
}

/** Mutable fields accepted when creating/updating a changelog entry. */
interface ChangelogInput {
  title?: string;
  body?: string;
  publish?: boolean;
}

/**
 * Issue a request against the feedback dashboard API.
 *
 * @param path - Endpoint path under /api (leading slash)
 * @param opts - Fetch options forwarded to apiRequest
 * @returns Parsed JSON response of the caller-declared shape
 */
function call<T = unknown>(path: string, opts: ApiRequestOptions = {}): Promise<T> {
  return apiRequest<T>(path, opts);
}

export const faApi = {
  // Apps (DB table Apps; dashboard routes under /apps)
  listProjects: () => call<{ apps: App[] }>('/apps').then((r) => ({ projects: r.apps || [] })),
  createProject: (body: Partial<App>) =>
    call<AppWithKey>('/apps', { method: 'POST', body: JSON.stringify(body) }),
  updateProject: (id: string, body: Partial<App>) =>
    call<App>(`/apps/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteProject: (id: string) => call<{ ok: boolean }>(`/apps/${id}`, { method: 'DELETE' }),
  rotateProjectKey: (id: string) =>
    call<{ publicKey: string }>(`/apps/${id}/rotate-key`, { method: 'POST' }),

  // Submissions
  /**
   * List submissions for one app, or the whole org when `appId` is
   * `'all'` (inbox view — each row includes `appName`).
   */
  listSubmissions: (appId: string, params: SubmissionListParams = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    const path = appId === 'all'
      ? `/submissions${qs ? `?${qs}` : ''}`
      : `/apps/${appId}/submissions${qs ? `?${qs}` : ''}`;
    return call<{ submissions: Submission[] }>(path);
  },
  getSubmission: (id: string) => call<SubmissionDetail>(`/submissions/${id}`),
  updateSubmission: (id: string, body: Partial<Submission>) =>
    call<Submission>(`/submissions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteSubmission: (id: string) =>
    call<{ ok: boolean }>(`/submissions/${id}`, { method: 'DELETE' }),

  // Changelog
  listChangelog: (appId: string) =>
    call<{ changelog: ChangelogEntry[] }>(`/apps/${appId}/changelog`),
  createChangelog: (appId: string, body: ChangelogInput) =>
    call<ChangelogEntry>(`/apps/${appId}/changelog`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateChangelog: (id: string, body: ChangelogInput) =>
    call<ChangelogEntry>(`/changelog/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteChangelog: (id: string) =>
    call<{ ok: boolean }>(`/changelog/${id}`, { method: 'DELETE' }),
  reorderChangelog: (appId: string, items: ReorderItem[]) =>
    call<{ ok: boolean }>(`/apps/${appId}/changelog/reorder`, {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),

  // Widget bundle SRI hash for optional pinned embeds ({ version, integrity }).
  getWidgetIntegrity: () => call<WidgetIntegrity>('/widget-integrity'),
};

/**
 * URL for a screenshot (auth-gated; works as <img src>).
 *
 * @param screenshotId - Screenshot attachment id (null/empty yields null)
 * @returns Absolute screenshot URL, or null when no id is given
 */
export function screenshotUrl(screenshotId: string | null | undefined): string | null {
  if (!screenshotId) return null;
  return `${getBackendURL()}/screenshots/${screenshotId}`;
}
