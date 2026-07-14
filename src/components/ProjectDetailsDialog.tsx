import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, KeyRound, Save } from '@stevederico/skateboard-ui/icons';
import { Button } from '@stevederico/skateboard-ui/shadcn/ui/button';
import { Input } from '@stevederico/skateboard-ui/shadcn/ui/input';
import { Label } from '@stevederico/skateboard-ui/shadcn/ui/label';
import { Textarea } from '@stevederico/skateboard-ui/shadcn/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@stevederico/skateboard-ui/shadcn/ui/dialog';
import { faApi } from '../util/api';
import { embedSnippet } from '../util/embed';
import { copyToClipboard } from '../util/clipboard';
import type { Project } from '../util/types';

/** Props for {@link ProjectDetailsDialog}. */
interface ProjectDetailsDialogProps {
  /** Project to edit, or null to render nothing. */
  project: Project | null;
  /** Whether the dialog is open. */
  open: boolean;
  /** Open-state change handler. */
  onOpenChange: (open: boolean) => void;
  /** Called after a successful save or key rotation. */
  onChanged?: () => void;
}

export default function ProjectDetailsDialog({ project, open, onOpenChange, onChanged }: ProjectDetailsDialogProps) {
  const [name, setName] = useState('');
  const [origins, setOrigins] = useState('');
  // Number from the project, string while the user edits the number input.
  const [budget, setBudget] = useState<number | string>(1000);
  const [greeting, setGreeting] = useState('');
  const [saving, setSaving] = useState(false);
  const [rotatedKey, setRotatedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    setName(project.name || '');
    setOrigins(project.allowedOrigins || '');
    setBudget(project.dailyBudget ?? 1000);
    setGreeting(project.greeting || '');
    setRotatedKey(null);
  }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    if (!project) return;
    setSaving(true);
    try {
      await faApi.updateProject(project.id, {
        name: name.trim(),
        allowedOrigins: origins.trim(),
        dailyBudget: Number(budget) || 1000,
        greeting: greeting.trim() || null,
      });
      toast.success('Settings saved');
      onChanged?.();
    } catch (e) {
      toast.error((e instanceof Error ? e.message : String(e)) || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleRotate() {
    if (!project) return;
    try {
      const res = await faApi.rotateProjectKey(project.id);
      setRotatedKey(res.publicKey);
      onChanged?.();
      toast.success('Key rotated — old key is now invalid');
    } catch (e) {
      toast.error((e instanceof Error ? e.message : String(e)) || 'Rotate failed');
    }
  }

  if (!project) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{project.name}</DialogTitle>
          <DialogDescription>App details, widget key, and embed snippet.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-3">
            <div className="text-sm font-medium">App</div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="proj-name">Name</Label>
              <Input id="proj-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="proj-origins">Allowed origins</Label>
              <Input
                id="proj-origins"
                value={origins}
                onChange={(e) => setOrigins(e.target.value)}
                placeholder="https://app.example.com, https://staging.example.com"
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated. Empty = any site. Non-empty = enforced on the
                widget API. Supports <code>*.example.com</code>.
              </p>
            </div>
            <div className="flex flex-col gap-1.5 max-w-xs">
              <Label htmlFor="proj-budget">Daily submission budget</Label>
              <Input
                id="proj-budget"
                type="number"
                min={1}
                max={1000000}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Hard ceiling on submissions accepted per UTC day.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="proj-greeting">Greeting bubble</Label>
              <Textarea
                id="proj-greeting"
                rows={2}
                value={greeting}
                onChange={(e) => setGreeting(e.target.value)}
                placeholder="Hey! What's on your mind?"
                maxLength={500}
              />
            </div>
            <div>
              <Button onClick={handleSave} disabled={saving}>
                <Save size={14} /> {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium">Widget key</div>
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2">
              <code className="flex-1 font-mono text-xs">{project.publicKey}</code>
              <Button size="sm" variant="outline" onClick={handleRotate}>
                <KeyRound size={14} /> Rotate
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Full key is shown once on create or rotate. After that it's masked.
              Rotating immediately invalidates the previous key.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium">Embed snippet</div>
            <pre className="rounded-md border bg-muted/40 p-3 text-xs overflow-x-auto">
              <code>{embedSnippet(project.publicKey)}</code>
            </pre>
            <div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => copyToClipboard(embedSnippet(project.publicKey))}
              >
                <Copy size={14} /> Copy snippet
              </Button>
            </div>
          </div>
        </div>

        <Dialog open={!!rotatedKey} onOpenChange={(o) => !o && setRotatedKey(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New widget key</DialogTitle>
              <DialogDescription>
                Copy the key or the full embed snippet now — you won't see the full key again.
              </DialogDescription>
            </DialogHeader>
            {rotatedKey && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2">
                  <code className="flex-1 font-mono text-xs break-all">{rotatedKey}</code>
                  <Button size="sm" variant="outline" onClick={() => copyToClipboard(rotatedKey)}>
                    <Copy size={14} />
                  </Button>
                </div>
                <pre className="rounded-md border bg-muted/40 p-3 text-xs overflow-x-auto">
                  <code>{embedSnippet(rotatedKey)}</code>
                </pre>
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => copyToClipboard(embedSnippet(rotatedKey))}
                  >
                    <Copy size={14} /> Copy snippet
                  </Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
