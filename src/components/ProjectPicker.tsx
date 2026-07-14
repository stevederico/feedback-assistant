// App picker shown at the top of app-scoped views.
// Hidden when there's exactly one app (auto-selected), unless `allowAll`
// or `alwaysShow` is set. (API/resource still called "project" in code.)

import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@stevederico/skateboard-ui/shadcn/ui/select';
import type { Project } from '../util/types';

/** Sentinel value for the org-wide "All apps" inbox filter. */
export const ALL_PROJECTS = 'all';

/** Props for {@link ProjectPicker}. */
interface ProjectPickerProps {
  /** Apps to choose from; picker hides when 0 or 1 (unless allowAll/alwaysShow). */
  projects: Project[] | null;
  /** Currently selected app id, or {@link ALL_PROJECTS}. */
  currentId: string | null;
  /** Called with the newly selected app id (or {@link ALL_PROJECTS}). */
  onChange: (id: string) => void;
  /**
   * When true, include an "All apps" option and show the picker whenever
   * at least one app exists (so the inbox can span the org).
   */
  allowAll?: boolean;
  /**
   * When true, show the picker even with a single app so the active
   * app name is always visible (Changelog).
   */
  alwaysShow?: boolean;
}

/**
 * Dropdown to switch the current app scope for app-scoped views.
 *
 * @param props - Apps list, selection, change handler, optional All / alwaysShow
 */
export default function ProjectPicker({
  projects, currentId, onChange, allowAll = false, alwaysShow = false,
}: ProjectPickerProps) {
  if (!projects || projects.length === 0) return null;
  if (!allowAll && !alwaysShow && projects.length <= 1) return null;

  return (
    <Select value={currentId || ''} onValueChange={(value) => value && onChange(value)}>
      <SelectTrigger className="w-64" aria-label="Select app">
        <SelectValue placeholder="Select app" />
      </SelectTrigger>
      <SelectContent>
        {allowAll && (
          <SelectItem value={ALL_PROJECTS}>All apps</SelectItem>
        )}
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
