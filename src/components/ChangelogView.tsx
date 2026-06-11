import { useEffect, useState, useCallback, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Plus, GripVertical, Eye, EyeOff, Trash2, Pencil } from '@stevederico/skateboard-ui/icons';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors,
} from '@dnd-kit/core';
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates,
  useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@stevederico/skateboard-ui/shadcn/ui/button';
import { Input } from '@stevederico/skateboard-ui/shadcn/ui/input';
import { Label } from '@stevederico/skateboard-ui/shadcn/ui/label';
import { Textarea } from '@stevederico/skateboard-ui/shadcn/ui/textarea';
import { Badge } from '@stevederico/skateboard-ui/shadcn/ui/badge';
import { Card } from '@stevederico/skateboard-ui/shadcn/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@stevederico/skateboard-ui/shadcn/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@stevederico/skateboard-ui/shadcn/ui/alert-dialog';
import type { DragEndEvent } from '@dnd-kit/core';
import Header from '@stevederico/skateboard-ui/Header';
import { faApi } from '../util/api';
import { useCurrentProject } from '../util/useCurrentProject';
import ProjectPicker from './ProjectPicker';
import type { ChangelogEntry } from '../util/types';

/** Values produced by the entry form (create/edit). */
interface EntryFormValues {
  title: string;
  body: string;
  publish: boolean;
}

/** Props for a single sortable changelog row. */
interface SortableRowProps {
  entry: ChangelogEntry;
  onEdit: (entry: ChangelogEntry) => void;
  onTogglePublish: (entry: ChangelogEntry) => void;
  onDelete: (entry: ChangelogEntry) => void;
}

function SortableRow({ entry, onEdit, onTogglePublish, onDelete }: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: entry.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  const published = !!entry.publishedAt;
  return (
    <li ref={setNodeRef} style={style} className="flex items-start gap-2 p-3 border-b last:border-b-0 bg-card">
      <button
        type="button"
        className="mt-1 cursor-grab text-muted-foreground touch-none"
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder"
      >
        <GripVertical size={16} />
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div className="text-sm font-medium truncate">{entry.title}</div>
          <Badge variant={published ? 'default' : 'outline'}>
            {published ? 'Published' : 'Draft'}
          </Badge>
        </div>
        {entry.body && (
          <div className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap line-clamp-3 break-words">
            {entry.body}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button size="sm" variant="outline" onClick={() => onTogglePublish(entry)} title={published ? 'Unpublish' : 'Publish'}>
          {published ? <EyeOff size={14} /> : <Eye size={14} />}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onEdit(entry)} title="Edit">
          <Pencil size={14} />
        </Button>
        <AlertDialog>
          <AlertDialogTrigger render={<Button size="sm" variant="outline" title="Delete" />}>
            <Trash2 size={14} />
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete "{entry.title}"?</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently removes the entry from your widget's What's New tab.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => onDelete(entry)}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </li>
  );
}

/** Props for the create/edit changelog entry form. */
interface EntryFormProps {
  /** Existing entry when editing; omitted when creating. */
  initial?: ChangelogEntry | null;
  /** Submit handler receiving the form values. */
  onSubmit: (values: EntryFormValues) => void;
  /** Optional cancel handler (renders a Cancel button when present). */
  onCancel?: () => void;
  /** Whether a save is in flight (disables submit). */
  submitting: boolean;
}

function EntryForm({ initial, onSubmit, onCancel, submitting }: EntryFormProps) {
  const [title, setTitle] = useState(initial?.title || '');
  const [body, setBody] = useState(initial?.body || '');
  const [publish, setPublish] = useState(initial ? !!initial.publishedAt : true);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!title.trim()) { toast.error('Title is required'); return; }
    onSubmit({ title: title.trim(), body: body, publish });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="cl-title">Title</Label>
        <Input id="cl-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="cl-body">Body (markdown)</Label>
        <Textarea id="cl-body" rows={6} value={body} onChange={(e) => setBody(e.target.value)} maxLength={50000} />
      </div>
      <div className="flex items-center gap-2">
        <input
          id="cl-publish"
          type="checkbox"
          checked={publish}
          onChange={(e) => setPublish(e.target.checked)}
          className="size-4"
        />
        <Label htmlFor="cl-publish" className="cursor-pointer">Publish (visible in widget)</Label>
      </div>
      <DialogFooter>
        {onCancel && <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" disabled={submitting}>{submitting ? 'Saving…' : 'Save'}</Button>
      </DialogFooter>
    </form>
  );
}

export default function ChangelogView() {
  const { projects, current, currentId, setCurrentId, loading } = useCurrentProject();
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ChangelogEntry | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const load = useCallback(() => {
    if (!currentId) { setEntries([]); return; }
    faApi.listChangelog(currentId).then((r) => setEntries(r.changelog || []))
      .catch(() => setEntries([]));
  }, [currentId]);

  useEffect(load, [load]);

  async function handleCreate(values: EntryFormValues) {
    if (!current) return;
    setSubmitting(true);
    try {
      await faApi.createChangelog(current.id, values);
      toast.success('Entry created');
      setCreating(false);
      load();
    } catch (e) { toast.error((e as Error)?.message || 'Create failed'); }
    finally { setSubmitting(false); }
  }

  async function handleUpdate(values: EntryFormValues) {
    if (!editing) return;
    setSubmitting(true);
    try {
      await faApi.updateChangelog(editing.id, values);
      toast.success('Entry updated');
      setEditing(null);
      load();
    } catch (e) { toast.error((e as Error)?.message || 'Update failed'); }
    finally { setSubmitting(false); }
  }

  async function handleTogglePublish(entry: ChangelogEntry) {
    try {
      await faApi.updateChangelog(entry.id, { publish: !entry.publishedAt });
      load();
    } catch (e) { toast.error((e as Error)?.message || 'Toggle failed'); }
  }

  async function handleDelete(entry: ChangelogEntry) {
    try {
      await faApi.deleteChangelog(entry.id);
      toast.success('Entry deleted');
      load();
    } catch (e) { toast.error((e as Error)?.message || 'Delete failed'); }
  }

  async function handleDragEnd(event: DragEndEvent) {
    if (!current || !entries) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = entries.findIndex((e) => e.id === active.id);
    const newIdx = entries.findIndex((e) => e.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const reordered = arrayMove(entries, oldIdx, newIdx);
    // Renumber sort_order as 1..N to match the new visual order.
    const items = reordered.map((e, i) => ({ id: e.id, sortOrder: i + 1 }));
    setEntries(reordered.map((e, i) => ({ ...e, sortOrder: i + 1 })));
    try {
      await faApi.reorderChangelog(current.id, items);
    } catch (e) {
      toast.error('Reorder failed');
      load(); // revert
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <Header title="Changelog">
        {projects && projects.length > 1 && (
          <ProjectPicker projects={projects} currentId={currentId} onChange={setCurrentId} />
        )}
        <Dialog open={creating} onOpenChange={setCreating}>
          <DialogTrigger render={<Button size="sm" disabled={!current} />}>
            <Plus size={16} /> New entry
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New changelog entry</DialogTitle>
              <DialogDescription>
                Shows in the widget's What's New tab. Drafts are hidden until published.
              </DialogDescription>
            </DialogHeader>
            <EntryForm
              onSubmit={handleCreate}
              onCancel={() => setCreating(false)}
              submitting={submitting}
            />
          </DialogContent>
        </Dialog>
      </Header>

      {!loading && (!projects || projects.length === 0) && (
        <Card className="p-6">
          <div className="text-sm">Create a project to manage its changelog.</div>
        </Card>
      )}

      {current && entries !== null && entries.length === 0 && (
        <Card className="p-6 text-sm text-muted-foreground">
          No entries yet. Create one to show up in the widget's What's New tab.
        </Card>
      )}

      {current && entries && entries.length > 0 && (
        <Card className="overflow-hidden">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={entries.map((e) => e.id)} strategy={verticalListSortingStrategy}>
              <ul>
                {entries.map((e) => (
                  <SortableRow
                    key={e.id}
                    entry={e}
                    onEdit={setEditing}
                    onTogglePublish={handleTogglePublish}
                    onDelete={handleDelete}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        </Card>
      )}

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit entry</DialogTitle>
          </DialogHeader>
          {editing && (
            <EntryForm
              initial={editing}
              onSubmit={handleUpdate}
              onCancel={() => setEditing(null)}
              submitting={submitting}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
