import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Plus, Copy, KeyRound, Trash2 } from '@stevederico/skateboard-ui/icons';
import { Button } from '@stevederico/skateboard-ui/shadcn/ui/button';
import { Input } from '@stevederico/skateboard-ui/shadcn/ui/input';
import { Label } from '@stevederico/skateboard-ui/shadcn/ui/label';
import { Textarea } from '@stevederico/skateboard-ui/shadcn/ui/textarea';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription, DialogTrigger,
} from '@stevederico/skateboard-ui/shadcn/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@stevederico/skateboard-ui/shadcn/ui/alert-dialog';
import { Card } from '@stevederico/skateboard-ui/shadcn/ui/card';
import Header from '@stevederico/skateboard-ui/Header';
import { faApi } from '../util/api';
import { embedSnippet } from '../util/embed';
import { copyToClipboard } from '../util/clipboard';
import ProjectDetailsDialog from './ProjectDetailsDialog';
import type { Project, WidgetIntegrity } from '../util/types';

/** Key-disclosure dialog state, shown once after create or rotate. */
interface NewKeyState {
  id: string;
  name: string;
  publicKey: string;
  /** True when produced by a rotate, false when by a create. */
  rotated: boolean;
}

/**
 * Format an epoch-millisecond timestamp as a short US date.
 *
 * @param ms - Epoch milliseconds (falsy yields an empty string)
 * @returns Formatted date, e.g. "Jun 3, 2026"
 */
function formatDate(ms: number | null | undefined): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

export default function ProjectsView() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newKey, setNewKey] = useState<NewKeyState | null>(null); // returned on create/rotate
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [integrity, setIntegrity] = useState<WidgetIntegrity | null>(null);

  function load() {
    faApi.listProjects().then((r) => setProjects(r.projects || [])).catch(() => setProjects([]));
  }
  useEffect(load, []);

  // Fetch the widget bundle SRI hash once so the key-disclosure snippet pins it.
  useEffect(() => {
    faApi.getWidgetIntegrity().then((r) => setIntegrity(r || null)).catch(() => setIntegrity(null));
  }, []);

  async function handleDelete(p: Project) {
    try {
      await faApi.deleteProject(p.id);
      toast.success(`Deleted "${p.name}"`);
      load();
    } catch (e) {
      toast.error((e as Error)?.message || 'Delete failed');
    }
  }

  async function handleRotate(p: Project) {
    try {
      const res = await faApi.rotateProjectKey(p.id);
      setNewKey({ id: p.id, name: p.name, publicKey: res.publicKey, rotated: true });
      load();
    } catch (e) {
      toast.error((e as Error)?.message || 'Rotate failed');
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <Header title="Projects">
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger render={<Button size="sm" />}>
            <Plus size={16} /> New project
          </DialogTrigger>
          <CreateProjectDialog
            onCreated={(p) => {
              setCreateOpen(false);
              setNewKey({ id: p.id, name: p.name, publicKey: p.publicKey, rotated: false });
              load();
            }}
          />
        </Dialog>
      </Header>

      {projects === null && (
        <div className="text-sm text-muted-foreground">Loading projects…</div>
      )}

      {projects !== null && projects.length === 0 && (
        <Card className="p-6 flex flex-col items-start gap-3">
          <div className="text-base font-medium">No projects yet</div>
          <p className="text-sm text-muted-foreground">
            Create a project to get a widget key.
          </p>
        </Card>
      )}

      {projects !== null && projects.length > 0 && (
        <div className="flex flex-col gap-2">
          {projects.map((p) => (
            <Card key={p.id} className="p-4 flex items-start justify-between gap-4">
              <button
                type="button"
                onClick={() => setDetailsId(p.id)}
                className="flex flex-col gap-1 min-w-0 text-left hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
              >
                <div className="text-sm font-medium">{p.name}</div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{p.publicKey}</span>
                  <span>·</span>
                  <span>Budget {p.dailyBudget}/day</span>
                  <span>·</span>
                  <span>Created {formatDate(p.createdAt)}</span>
                </div>
              </button>
              <div className="flex items-center gap-1 shrink-0">
                <Button size="sm" variant="outline" onClick={() => handleRotate(p)} title="Rotate key">
                  <KeyRound size={14} /> Rotate
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger render={<Button size="sm" variant="outline" title="Delete project" />}>
                    <Trash2 size={14} />
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete "{p.name}"?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This permanently removes the project, its submissions, screenshots,
                        and changelog entries. The widget key will stop working immediately.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => handleDelete(p)}>Delete</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ProjectDetailsDialog
        project={projects?.find((p) => p.id === detailsId) || null}
        open={!!detailsId}
        onOpenChange={(o) => !o && setDetailsId(null)}
        onChanged={load}
      />

      {/* Key disclosure dialog — shown once after create or rotate. */}
      <Dialog open={!!newKey} onOpenChange={(o) => !o && setNewKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {newKey?.rotated ? 'New key for ' : 'Project created — '}
              {newKey?.name}
            </DialogTitle>
            <DialogDescription>
              Copy the key or the full embed snippet now — you won't see the full key again.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2">
              <code className="flex-1 font-mono text-xs break-all">{newKey?.publicKey}</code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => copyToClipboard(newKey?.publicKey)}
              >
                <Copy size={14} />
              </Button>
            </div>
            {newKey?.publicKey && (
              <>
                <pre className="rounded-md border bg-muted/40 p-3 text-xs overflow-x-auto">
                  <code>{embedSnippet(newKey.publicKey, integrity)}</code>
                </pre>
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => copyToClipboard(embedSnippet(newKey.publicKey, integrity))}
                  >
                    <Copy size={14} /> Copy snippet
                  </Button>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setNewKey(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Props for the inline create-project form dialog. */
interface CreateProjectDialogProps {
  /** Called with the created project (including its full public key). */
  onCreated: (project: Project) => void;
}

function CreateProjectDialog({ onCreated }: CreateProjectDialogProps) {
  const [name, setName] = useState('');
  const [origins, setOrigins] = useState('');
  const [greeting, setGreeting] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }
    setSubmitting(true);
    try {
      const p = await faApi.createProject({
        name: name.trim(),
        allowedOrigins: origins.trim(),
        greeting: greeting.trim() || null,
      });
      onCreated(p);
      setName(''); setOrigins(''); setGreeting('');
    } catch (err) {
      toast.error((err as Error)?.message || 'Create failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DialogContent>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Each project gets its own widget key, daily budget, and changelog.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="proj-name">Name</Label>
          <Input
            id="proj-name"
            placeholder="My App"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            maxLength={200}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="proj-origins">Allowed origins (comma-separated)</Label>
          <Input
            id="proj-origins"
            placeholder="https://app.example.com, https://staging.example.com"
            value={origins}
            onChange={(e) => setOrigins(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Logged for hygiene; not enforced for security. Per-IP rate limit and
            daily budget are the real guardrails.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="proj-greeting">Greeting bubble (optional)</Label>
          <Textarea
            id="proj-greeting"
            rows={2}
            placeholder="Hey! Tell us what you think."
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
            maxLength={500}
          />
        </div>

        <DialogFooter>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create project'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
