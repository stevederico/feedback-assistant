// Thin wrapper over skateboard-ui's apiRequest, scoped to feedback-assistant's
// /api/* endpoints (everything mounted by feedback-dashboard-api.js).
//
// apiRequest already handles cookies, CSRF header, 30s timeout, and 401 redirect.

import { apiRequest, getBackendURL } from '@stevederico/skateboard-ui/Utilities';

function call(path, opts = {}) {
  return apiRequest(path, opts);
}

export const faApi = {
  // Projects
  listProjects: () => call('/projects'),
  createProject: (body) => call('/projects', { method: 'POST', body: JSON.stringify(body) }),
  updateProject: (id, body) => call(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteProject: (id) => call(`/projects/${id}`, { method: 'DELETE' }),
  rotateProjectKey: (id) => call(`/projects/${id}/rotate-key`, { method: 'POST' }),

  // Submissions
  listSubmissions: (projectId, params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ).toString();
    return call(`/projects/${projectId}/submissions${qs ? `?${qs}` : ''}`);
  },
  getSubmission: (id) => call(`/submissions/${id}`),
  updateSubmission: (id, body) => call(`/submissions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteSubmission: (id) => call(`/submissions/${id}`, { method: 'DELETE' }),

  // Changelog
  listChangelog: (projectId) => call(`/projects/${projectId}/changelog`),
  createChangelog: (projectId, body) => call(`/projects/${projectId}/changelog`, { method: 'POST', body: JSON.stringify(body) }),
  updateChangelog: (id, body) => call(`/changelog/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteChangelog: (id) => call(`/changelog/${id}`, { method: 'DELETE' }),
  reorderChangelog: (projectId, items) =>
    call(`/projects/${projectId}/changelog/reorder`, { method: 'POST', body: JSON.stringify({ items }) }),

  // Widget bundle SRI hash for the embed snippet ({ version, integrity }).
  getWidgetIntegrity: () => call('/widget-integrity'),
};

/**
 * URL for a screenshot (auth-gated; works as <img src>).
 *
 * In dev the dashboard is on :5173 and the API on :8000 — different origins.
 * Browsers don't send cookies on cross-origin <img> requests unless the tag
 * is marked `crossorigin="use-credentials"` AND the response includes the
 * matching CORS headers. The image components also need the right origin,
 * so resolve via skateboard's getBackendURL().
 */
export function screenshotUrl(screenshotId) {
  if (!screenshotId) return null;
  return `${getBackendURL()}/screenshots/${screenshotId}`;
}
