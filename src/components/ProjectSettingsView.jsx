import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, KeyRound, Save } from '@stevederico/skateboard-ui/icons';
import { Button } from '@stevederico/skateboard-ui/shadcn/ui/button';
import { Input } from '@stevederico/skateboard-ui/shadcn/ui/input';
import { Label } from '@stevederico/skateboard-ui/shadcn/ui/label';
import { Textarea } from '@stevederico/skateboard-ui/shadcn/ui/textarea';
import { Card } from '@stevederico/skateboard-ui/shadcn/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@stevederico/skateboard-ui/shadcn/ui/dialog';
import Header from '@stevederico/skateboard-ui/Header';
import { faApi } from '../util/api.js';
import { useCurrentProject } from '../util/useCurrentProject.js';
import ProjectPicker from './ProjectPicker.jsx';
import packageJson from '../../package.json';

function copyToClipboard(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast.success('Copied to clipboard'),
    () => toast.error('Could not copy'),
  );
}

// Embed snippet shown for a project. Uses dataset-key attribute the widget reads.
// Points at the same host that serves the dashboard — works for any deploy
// (Railway prod, custom domain, local dev). SRI hash will land once the build
// pipeline can compute it post-build.
function embedSnippet(publicKey) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const version = packageJson.version;
  return `<script
  src="${origin}/widget/v${version}.js"
  data-project="${publicKey}"
  defer
></script>`;
}

export default function ProjectSettingsView() {
  const { projects, current, currentId, setCurrentId, refetch, loading } = useCurrentProject();
  const [name, setName] = useState('');
  const [origins, setOrigins] = useState('');
  const [budget, setBudget] = useState(1000);
  const [greeting, setGreeting] = useState('');
  const [saving, setSaving] = useState(false);
  const [rotatedKey, setRotatedKey] = useState(null);

  useEffect(() => {
    if (!current) return;
    setName(current.name || '');
    setOrigins(current.allowedOrigins || '');
    setBudget(current.dailyBudget ?? 1000);
    setGreeting(current.greeting || '');
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    if (!current) return;
    setSaving(true);
    try {
      await faApi.updateProject(current.id, {
        name: name.trim(),
        allowedOrigins: origins.trim(),
        dailyBudget: Number(budget) || 1000,
        greeting: greeting.trim() || null,
      });
      toast.success('Settings saved');
      await refetch();
    } catch (e) {
      toast.error(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleRotate() {
    if (!current) return;
    try {
      const res = await faApi.rotateProjectKey(current.id);
      setRotatedKey(res.publicKey);
      await refetch();
      toast.success('Key rotated — old key is now invalid');
    } catch (e) {
      toast.error(e?.message || 'Rotate failed');
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <Header title="Settings">
        {projects && projects.length > 1 && (
          <ProjectPicker projects={projects} currentId={currentId} onChange={setCurrentId} />
        )}
      </Header>

      {!loading && (!projects || projects.length === 0) && (
        <Card className="p-6">
          <div className="text-sm">Create a project to configure settings.</div>
        </Card>
      )}

      {current && (
        <>
          <Card className="p-4 flex flex-col gap-4">
            <div className="text-sm font-medium">Project</div>
            <div className="flex flex-col gap-3">
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
                  Comma-separated. Logged for hygiene; not enforced for security.
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
          </Card>

          <Card className="p-4 flex flex-col gap-3">
            <div className="text-sm font-medium">Widget key</div>
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2">
              <code className="flex-1 font-mono text-xs">{current.publicKey}</code>
              <Button size="sm" variant="outline" onClick={handleRotate}>
                <KeyRound size={14} /> Rotate
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Full key is shown once on create or rotate. After that it's masked.
              Rotating immediately invalidates the previous key.
            </p>
          </Card>

          <Card className="p-4 flex flex-col gap-3">
            <div className="text-sm font-medium">Embed snippet</div>
            <pre className="rounded-md border bg-muted/40 p-3 text-xs overflow-x-auto">
              <code>{embedSnippet(current.publicKey)}</code>
            </pre>
            <div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => copyToClipboard(embedSnippet(current.publicKey))}
              >
                <Copy size={14} /> Copy snippet
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Drop this on any page where you want the widget to appear. Currently
              the snippet shows the masked key — replace it with the full key from
              create/rotate.
            </p>
          </Card>
        </>
      )}

      <Dialog open={!!rotatedKey} onOpenChange={(o) => !o && setRotatedKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New widget key</DialogTitle>
            <DialogDescription>
              Copy this key now. You won't see the full value again.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2">
            <code className="flex-1 font-mono text-xs break-all">{rotatedKey}</code>
            <Button size="sm" variant="outline" onClick={() => copyToClipboard(rotatedKey)}>
              <Copy size={14} />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setRotatedKey(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
