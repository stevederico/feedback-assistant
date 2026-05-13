// Project picker shown at the top of project-scoped views.
// Hidden when there's exactly one project (auto-selected).

import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@stevederico/skateboard-ui/shadcn/ui/select';

export default function ProjectPicker({ projects, currentId, onChange }) {
  if (!projects || projects.length <= 1) return null;
  return (
    <Select value={currentId || ''} onValueChange={onChange}>
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
