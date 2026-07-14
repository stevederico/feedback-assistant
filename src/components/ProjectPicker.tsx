// Project picker shown at the top of project-scoped views.
// Hidden when there's exactly one project (auto-selected), unless `allowAll`
// or `alwaysShow` is set.

import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@stevederico/skateboard-ui/shadcn/ui/select';
import type { Project } from '../util/types';

/** Sentinel value for the org-wide "All projects" inbox filter. */
export const ALL_PROJECTS = 'all';

/** Props for {@link ProjectPicker}. */
interface ProjectPickerProps {
  /** Projects to choose from; picker hides when 0 or 1 (unless allowAll/alwaysShow). */
  projects: Project[] | null;
  /** Currently selected project id, or {@link ALL_PROJECTS}. */
  currentId: string | null;
  /** Called with the newly selected project id (or {@link ALL_PROJECTS}). */
  onChange: (id: string) => void;
  /**
   * When true, include an "All projects" option and show the picker whenever
   * at least one project exists (so the inbox can span the org).
   */
  allowAll?: boolean;
  /**
   * When true, show the picker even with a single project so the active
   * project name is always visible (Changelog).
   */
  alwaysShow?: boolean;
}

/**
 * Dropdown to switch the current project scope for project-scoped views.
 *
 * @param props - Projects list, selection, change handler, optional All / alwaysShow
 */
export default function ProjectPicker({
  projects, currentId, onChange, allowAll = false, alwaysShow = false,
}: ProjectPickerProps) {
  if (!projects || projects.length === 0) return null;
  if (!allowAll && !alwaysShow && projects.length <= 1) return null;

  return (
    <Select value={currentId || ''} onValueChange={(value) => value && onChange(value)}>
      <SelectTrigger className="w-64" aria-label="Select project">
        <SelectValue placeholder="Select project" />
      </SelectTrigger>
      <SelectContent>
        {allowAll && (
          <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
        )}
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
