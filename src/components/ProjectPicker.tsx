// Project picker shown at the top of project-scoped views.
// Hidden when there's exactly one project (auto-selected).

import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@stevederico/skateboard-ui/shadcn/ui/select';
import type { Project } from '../util/types';

/** Props for {@link ProjectPicker}. */
interface ProjectPickerProps {
  /** Projects to choose from; picker hides when 0 or 1. */
  projects: Project[] | null;
  /** Currently selected project id. */
  currentId: string | null;
  /** Called with the newly selected project id. */
  onChange: (id: string) => void;
}

export default function ProjectPicker({ projects, currentId, onChange }: ProjectPickerProps) {
  if (!projects || projects.length <= 1) return null;
  return (
    <Select value={currentId || ''} onValueChange={(value) => value && onChange(value)}>
      <SelectTrigger className="w-64">
        <SelectValue placeholder="Select project" />
      </SelectTrigger>
      <SelectContent>
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
