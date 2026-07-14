import { useEffect, useState, useCallback, type FormEvent } from 'react';
import { Plus, Eye, EyeOff, Trash2, Pencil } from '@stevederico/skateboard-ui/icons';
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

/** Props for a single changelog row. */
interface EntryRowProps {
  entry: ChangelogEntry;
  onEdit: (entry: ChangelogEntry) => void;
  onTogglePublish: (entry: ChangelogEntry) => void;
  onDelete: (entry: ChangelogEntry) => void;
}

/**
 * One changelog entry row with publish, edit, and delete actions.
 *
 * @param props - Entry data and action handlers
 * @returns List item for the changelog list
 */
function EntryRow({ entry, onEdit, onTogglePublish, onDelete }: EntryRowProps) {
  const published = !!entry.publishedAt;
  return (
    <li className="flex items-start gap-2 p-3 border-b last:border-b-0 bg-card">
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

/**
 * Create/edit form for a changelog entry (title, body, publish flag).
 *
 * @param props - Initial values, submit/cancel handlers, submitting state
 * @returns Form element
 */
function EntryForm({ initial, onSubmit, onCancel, submitting }: EntryFormProps) {
  const [title, setTitle] = useState(initial?.title || '');
  const [body, setBody] = useState(initial?.body || '');
  const [publish, setPublish] = useState(initial ? !!initial.publishedAt : true);
  const [titleError, setTitleError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!title.trim()) {
      setTitleError('Title is required');
      return;
    }
    setTitleError(null);
    onSubmit({ title: title.trim(), body: body, publish });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="cl-title">Title</Label>
        <Input
          id="cl-title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            if (titleError) setTitleError(null);
          }}
          maxLength={200}
          autoFocus
          aria-invalid={!!titleError}
          aria-describedby={titleError ? 'cl-title-error' : undefined}
        />
        {titleError && (
          <p id="cl-title-error" className="text-sm text-destructive" role="alert">
            {titleError}
          </p>
        )}
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

/**
 * Per-app changelog admin: list, create, edit, publish/unpublish, delete.
 *
 * @returns Changelog management view
 */
export default function ChangelogView() {
  const { projects, current, currentId, setCurrentId, loading } = useCurrentProject();
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ChangelogEntry | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!currentId) { setEntries([]); return; }
    faApi.listChangelog(currentId).then((r) => setEntries(r.changelog || []))
      .catch(() => setEntries([]));
  }, [currentId]);

  useEffect(load, [load]);
  useEffect(() => { setActionError(null); }, [currentId]);

  async function handleCreate(values: EntryFormValues) {
    if (!current) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await faApi.createChangelog(current.id, values);
      setCreating(false);
      load();
    } catch (e) {
      setActionError((e instanceof Error ? e.message : String(e)) || 'Create failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUpdate(values: EntryFormValues) {
    if (!editing) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await faApi.updateChangelog(editing.id, values);
      setEditing(null);
      load();
    } catch (e) {
      setActionError((e instanceof Error ? e.message : String(e)) || 'Update failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTogglePublish(entry: ChangelogEntry) {
    setActionError(null);
    try {
      await faApi.updateChangelog(entry.id, { publish: !entry.publishedAt });
      load();
    } catch (e) {
      setActionError((e instanceof Error ? e.message : String(e)) || 'Toggle failed');
    }
  }

  async function handleDelete(entry: ChangelogEntry) {
    setActionError(null);
    try {
      await faApi.deleteChangelog(entry.id);
      load();
    } catch (e) {
      setActionError((e instanceof Error ? e.message : String(e)) || 'Delete failed');
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <Header title={current ? `Changelog · ${current.name}` : 'Changelog'}>
        {/* Always show app scope — changelog is per-app, never org-wide. */}
        <ProjectPicker
          projects={projects}
          currentId={currentId}
          onChange={setCurrentId}
          alwaysShow
        />
        <Dialog open={creating} onOpenChange={setCreating}>
          <DialogTrigger render={<Button size="sm" disabled={!current} />}>
            <Plus size={16} /> New entry
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New changelog entry</DialogTitle>
              <DialogDescription>
                {current
                  ? `Adds to "${current.name}" only. Shows in that app's widget What's New tab. Drafts stay hidden until published.`
                  : "Shows in the widget's What's New tab. Drafts are hidden until published."}
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

      {actionError && (
        <p className="text-sm text-destructive" role="alert">{actionError}</p>
      )}

      {!loading && (!projects || projects.length === 0) && (
        <Card className="p-6">
          <div className="text-sm">Create an app to manage its changelog.</div>
        </Card>
      )}

      {current && entries !== null && entries.length === 0 && (
        <Card className="p-6 text-sm text-muted-foreground">
          No entries for "{current.name}" yet. Create one to show up in that app's
          widget What's New tab.
        </Card>
      )}

      {current && entries && entries.length > 0 && (
        <Card className="overflow-hidden">
          <ul>
            {entries.map((e) => (
              <EntryRow
                key={e.id}
                entry={e}
                onEdit={setEditing}
                onTogglePublish={handleTogglePublish}
                onDelete={handleDelete}
              />
            ))}
          </ul>
        </Card>
      )}

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit entry</DialogTitle>
            {current && (
              <DialogDescription>App: {current.name}</DialogDescription>
            )}
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
