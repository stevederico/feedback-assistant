// Thin wrapper over skateboard-ui's apiRequest, scoped to feedback-assistant's
// /api/* endpoints (everything mounted by feedback-dashboard-api.js).
//
// apiRequest already handles cookies, CSRF header, 30s timeout, and 401 redirect.

import { apiRequest, getBackendURL } from '@stevederico/skateboard-ui/Utilities';
import type { ApiRequestOptions } from '@stevederico/skateboard-ui/Utilities';
import type {
  Project,
  Submission,
  SubmissionDetail,
  ChangelogEntry,
  WidgetIntegrity,
} from './types';

/** Project as returned by create/rotate — always includes the full publicKey. */
type ProjectWithKey = Project & { publicKey: string };

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
  // Projects
  listProjects: () => call<{ projects: Project[] }>('/projects'),
  createProject: (body: Partial<Project>) =>
    call<ProjectWithKey>('/projects', { method: 'POST', body: JSON.stringify(body) }),
  updateProject: (id: string, body: Partial<Project>) =>
    call<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteProject: (id: string) => call<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
  rotateProjectKey: (id: string) =>
    call<{ publicKey: string }>(`/projects/${id}/rotate-key`, { method: 'POST' }),

  // Submissions
  listSubmissions: (projectId: string, params: SubmissionListParams = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    return call<{ submissions: Submission[] }>(
      `/projects/${projectId}/submissions${qs ? `?${qs}` : ''}`,
    );
  },
  getSubmission: (id: string) => call<SubmissionDetail>(`/submissions/${id}`),
  updateSubmission: (id: string, body: Partial<Submission>) =>
    call<Submission>(`/submissions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteSubmission: (id: string) =>
    call<{ ok: boolean }>(`/submissions/${id}`, { method: 'DELETE' }),

  // Changelog
  listChangelog: (projectId: string) =>
    call<{ changelog: ChangelogEntry[] }>(`/projects/${projectId}/changelog`),
  createChangelog: (projectId: string, body: ChangelogInput) =>
    call<ChangelogEntry>(`/projects/${projectId}/changelog`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateChangelog: (id: string, body: ChangelogInput) =>
    call<ChangelogEntry>(`/changelog/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteChangelog: (id: string) =>
    call<{ ok: boolean }>(`/changelog/${id}`, { method: 'DELETE' }),
  reorderChangelog: (projectId: string, items: ReorderItem[]) =>
    call<{ ok: boolean }>(`/projects/${projectId}/changelog/reorder`, {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),

  // Widget bundle SRI hash for the embed snippet ({ version, integrity }).
  getWidgetIntegrity: () => call<WidgetIntegrity>('/widget-integrity'),
};

/**
 * URL for a screenshot (auth-gated; works as <img src>).
 *
 * In dev the dashboard is on :5173 and the API on :8000 — different origins.
 * Browsers don't send cookies on cross-origin <img> requests unless the tag
 * is marked `crossorigin="use-credentials"` AND the response includes the
 * matching CORS headers. The image components also need the right origin,
 * so resolve via skateboard's getBackendURL().
 *
 * @param screenshotId - Screenshot attachment id (null/empty yields null)
 * @returns Absolute screenshot URL, or null when no id is given
 */
export function screenshotUrl(screenshotId: string | null | undefined): string | null {
  if (!screenshotId) return null;
  return `${getBackendURL()}/screenshots/${screenshotId}`;
}
