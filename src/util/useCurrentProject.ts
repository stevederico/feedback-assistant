// Tracks the "current project" across Submissions / Changelog / Settings views.
//
// Priority: URL query `?project=<id>`  >  localStorage  >  first project in list.
// Updating selection writes both URL + localStorage so reloads + shares both work.

import { useEffect, useState, useCallback } from 'react';
import { useSafeNavigate } from '@stevederico/skateboard-ui/Utilities';
import { faApi } from './api';
import type { Project } from './types';

const STORAGE_KEY = 'fa-current-project';

/** Return value of {@link useCurrentProject}. */
export interface CurrentProjectState {
  /** Loaded projects, or null while the initial fetch is in flight. */
  projects: Project[] | null;
  /** The resolved current project, or null when none is selected/available. */
  current: Project | null;
  /** Id of the resolved current project, or null. */
  currentId: string | null;
  /** Select a project by id (persists to URL + localStorage). */
  setCurrentId: (id: string) => void;
  /** Re-fetch the project list, returning the fresh array. */
  refetch: () => Promise<Project[]>;
  /** Fetch error, if the initial load failed. */
  error: unknown;
  /** True while the initial project list is loading. */
  loading: boolean;
}

/** Read `?project=` from the current location. */
function projectFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('project');
}

/**
 * Resolve and persist the "current project" selection for project-scoped views.
 *
 * @returns Current project state plus selection/refetch helpers
 */
export function useCurrentProject(): CurrentProjectState {
  const navigate = useSafeNavigate();
  const [urlProject, setUrlProject] = useState<string | null>(projectFromLocation);
  const [projects, setProjects] = useState<Project[] | null>(null); // null = loading
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    /** Keep the selection aligned when the browser back button changes the query. */
    function handlePopState() {
      setUrlProject(projectFromLocation());
    }
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Load projects once.
  useEffect(() => {
    let cancelled = false;
    faApi.listProjects()
      .then((res) => { if (!cancelled) setProjects(res.projects || []); })
      .catch((e) => { if (!cancelled) setError(e); });
    return () => { cancelled = true; };
  }, []);

  // Resolve current id with URL > localStorage > first project fallback.
  const urlId = urlProject;
  const stored = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  let currentId: string | null = urlId || stored || null;
  if (projects && currentId && !projects.find((p) => p.id === currentId)) {
    currentId = null; // stale id, fall through to default
  }
  if (!currentId && projects && projects.length) {
    currentId = projects[0].id;
  }

  const setCurrentId = useCallback((id: string) => {
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* ignore */ }
    setUrlProject(id);
    const next = new URLSearchParams(window.location.search);
    next.set('project', id);
    const query = next.toString();
    navigate(`${window.location.pathname}${query ? `?${query}` : ''}`, { replace: true });
  }, [navigate]);

  const refetch = useCallback(() => {
    return faApi.listProjects().then((res) => {
      setProjects(res.projects || []);
      return res.projects || [];
    });
  }, []);

  const current = projects?.find((p) => p.id === currentId) || null;

  return {
    projects,           // array | null while loading
    current,            // project object or null
    currentId,
    setCurrentId,
    refetch,
    error,
    loading: projects === null,
  };
}
