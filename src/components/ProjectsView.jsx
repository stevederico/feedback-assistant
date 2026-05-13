import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Copy, KeyRound, Trash2 } from 'lucide-react';
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
import { faApi } from '../util/api.js';

function formatDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function copyToClipboard(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast.success('Copied to clipboard'),
    () => toast.error('Could not copy'),
  );
}

export default function ProjectsView() {
  const [projects, setProjects] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newKey, setNewKey] = useState(null); // { id, name, publicKey } returned on create

  function load() {
    faApi.listProjects().then((r) => setProjects(r.projects || [])).catch(() => setProjects([]));
  }
  useEffect(load, []);

  async function handleDelete(p) {
    try {
      await faApi.deleteProject(p.id);
      toast.success(`Deleted "${p.name}"`);
      load();
    } catch (e) {
      toast.error(e?.message || 'Delete failed');
    }
  }

  async function handleRotate(p) {
    try {
      const res = await faApi.rotateProjectKey(p.id);
      setNewKey({ id: p.id, name: p.name, publicKey: res.publicKey, rotated: true });
      load();
    } catch (e) {
      toast.error(e?.message || 'Rotate failed');
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <Header title="Projects">
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus size={16} /> New project</Button>
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
              <div className="flex flex-col gap-1 min-w-0">
                <div className="text-sm font-medium">{p.name}</div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{p.publicKey}</span>
                  <span>·</span>
                  <span>Budget {p.dailyBudget}/day</span>
                  <span>·</span>
                  <span>Created {formatDate(p.createdAt)}</span>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button size="sm" variant="outline" onClick={() => handleRotate(p)} title="Rotate key">
                  <KeyRound size={14} /> Rotate
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="outline" title="Delete project">
                      <Trash2 size={14} />
                    </Button>
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

      {/* Key disclosure dialog — shown once after create or rotate. */}
      <Dialog open={!!newKey} onOpenChange={(o) => !o && setNewKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {newKey?.rotated ? 'New key for ' : 'Project created — '}
              {newKey?.name}
            </DialogTitle>
            <DialogDescription>
              Copy this key now. You won't see the full value again.
            </DialogDescription>
          </DialogHeader>
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
          <DialogFooter>
            <Button onClick={() => setNewKey(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CreateProjectDialog({ onCreated }) {
  const [name, setName] = useState('');
  const [origins, setOrigins] = useState('');
  const [greeting, setGreeting] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
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
      toast.error(err?.message || 'Create failed');
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
