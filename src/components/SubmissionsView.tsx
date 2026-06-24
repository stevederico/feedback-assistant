import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Search, Archive, Mail, MailOpen, Trash2, ExternalLink, Image as ImageIcon, Inbox } from '@stevederico/skateboard-ui/icons';
import { Button } from '@stevederico/skateboard-ui/shadcn/ui/button';
import { Input } from '@stevederico/skateboard-ui/shadcn/ui/input';
import { Badge } from '@stevederico/skateboard-ui/shadcn/ui/badge';
import { Card } from '@stevederico/skateboard-ui/shadcn/ui/card';
import {
  Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription,
} from '@stevederico/skateboard-ui/shadcn/ui/empty';
import {
  Tabs, TabsList, TabsTrigger,
} from '@stevederico/skateboard-ui/shadcn/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@stevederico/skateboard-ui/shadcn/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@stevederico/skateboard-ui/shadcn/ui/alert-dialog';
import Header from '@stevederico/skateboard-ui/Header';
import { faApi, screenshotUrl } from '../util/api';
import { embedSnippet } from '../util/embed';
import { useCurrentProject } from '../util/useCurrentProject';
import ProjectPicker from './ProjectPicker';
import type { Submission, SubmissionDetail, SubmissionStatus } from '../util/types';

/** Visual variant accepted by the shadcn Badge component. */
type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive';

/**
 * Format an epoch-millisecond timestamp as a short US date-time.
 *
 * @param ms - Epoch milliseconds (falsy yields an empty string)
 */
function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/**
 * Reduce a full URL to its path + query for compact display.
 *
 * @param href - Full URL (falsy yields ''; unparseable returns href as-is)
 */
function shortPath(href: string | null | undefined): string {
  if (!href) return '';
  try {
    const u = new URL(href);
    return `${u.pathname}${u.search}` || '/';
  } catch { return href; }
}

// Validate http(s) before rendering external links — blocks javascript: payloads.
function isSafeHttpUrl(href: string): boolean {
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

/** Maps a submission status to its Badge variant. */
const STATUS_BADGE: Record<SubmissionStatus, BadgeVariant> = {
  new: 'default',
  read: 'secondary',
  archived: 'outline',
};

export default function SubmissionsView() {
  const navigate = useNavigate();
  const { projects, current, currentId, setCurrentId, loading } = useCurrentProject();

  const [submissions, setSubmissions] = useState<Submission[] | null>(null);
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeDetail, setActiveDetail] = useState<SubmissionDetail | null>(null);

  // True when a status tab or search query is narrowing the list — used to tell
  // "no results for this filter" apart from "this project has no feedback yet".
  const isFiltered = status !== 'all' || search.trim() !== '';

  const fetchList = useCallback(() => {
    if (!currentId) { setSubmissions([]); return; }
    const params: { limit: number; status?: string; q?: string } = { limit: 100 };
    if (status !== 'all') params.status = status;
    if (search.trim()) params.q = search.trim();
    faApi.listSubmissions(currentId, params)
      .then((r) => setSubmissions(r.submissions || []))
      .catch(() => setSubmissions([]));
  }, [currentId, status, search]);

  useEffect(() => { fetchList(); }, [fetchList]);

  // Debounce search input so we don't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(fetchList, 300);
    return () => clearTimeout(t);
  }, [search, fetchList]);

  // Load full detail when a row is clicked.
  useEffect(() => {
    if (!activeId) { setActiveDetail(null); return; }
    let cancelled = false;
    faApi.getSubmission(activeId)
      .then((d) => { if (!cancelled) setActiveDetail(d); })
      .catch(() => { if (!cancelled) setActiveDetail({ error: true }); });
    return () => { cancelled = true; };
  }, [activeId]);

  async function updateStatus(id: string, newStatus: SubmissionStatus) {
    try {
      await faApi.updateSubmission(id, { status: newStatus });
      toast.success(`Marked ${newStatus}`);
      fetchList();
      if (activeDetail && !activeDetail.error && activeDetail.id === id) {
        setActiveDetail({ ...activeDetail, status: newStatus });
      }
    } catch (e) { toast.error((e as Error)?.message || 'Update failed'); }
  }

  async function handleDelete(id: string) {
    try {
      await faApi.deleteSubmission(id);
      toast.success('Submission deleted');
      setActiveId(null);
      fetchList();
    } catch (e) { toast.error((e as Error)?.message || 'Delete failed'); }
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <Header title="Submissions">
        {projects && projects.length > 1 && (
          <ProjectPicker projects={projects} currentId={currentId} onChange={setCurrentId} />
        )}
      </Header>

      {!loading && (!projects || projects.length === 0) && (
        <Card className="p-6">
          <div className="text-sm">Create a project first to receive submissions.</div>
        </Card>
      )}

      {currentId && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Tabs value={status} onValueChange={setStatus}>
              <TabsList>
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="new">New</TabsTrigger>
                <TabsTrigger value="read">Read</TabsTrigger>
                <TabsTrigger value="archived">Archived</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="relative flex-1 max-w-sm">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search message, name, email, URL…"
                className="pl-8"
              />
            </div>
          </div>

          {submissions === null && (
            <div className="text-sm text-muted-foreground">Loading…</div>
          )}

          {submissions !== null && submissions.length === 0 && isFiltered && (
            <Card className="p-6 text-sm text-muted-foreground">
              No submissions match your filters.
            </Card>
          )}

          {current && submissions !== null && submissions.length === 0 && !isFiltered && (
            <div className="flex items-center justify-center py-8">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon"><Inbox size={24} /></EmptyMedia>
                  <EmptyTitle>No feedback yet</EmptyTitle>
                  <EmptyDescription>
                    Add the widget to your site to start collecting feedback for "{current.name}".
                  </EmptyDescription>
                </EmptyHeader>
                <pre className="rounded-md border bg-muted/40 p-3 text-xs overflow-x-auto text-left max-w-full">
                  <code>{embedSnippet(current.publicKey)}</code>
                </pre>
                <p className="text-xs text-muted-foreground text-left">
                  This is a preview — the key is masked. Open the project to copy your full widget key.
                </p>
                <Button onClick={() => navigate('/app/projects')}>Set up widget</Button>
                <ol className="text-xs text-muted-foreground text-left list-decimal pl-4 flex flex-col gap-1">
                  <li>Open the project in Projects to get the full widget key.</li>
                  <li>Paste the snippet before <code>&lt;/body&gt;</code> on your site.</li>
                  <li>Submit a test message — it appears here.</li>
                </ol>
              </Empty>
            </div>
          )}

          {submissions !== null && submissions.length > 0 && (
            <Card className="overflow-hidden">
              <ul className="divide-y">
                {submissions.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setActiveId(s.id)}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <Badge variant={STATUS_BADGE[s.status] || 'default'}>{s.status}</Badge>
                          {s.endUserName && (
                            <span className="text-xs text-muted-foreground truncate">
                              {s.endUserName}
                              {s.endUserEmail ? ` · ${s.endUserEmail}` : ''}
                            </span>
                          )}
                          {s.screenshotId && (
                            <span className="inline-flex items-center text-xs text-muted-foreground">
                              <ImageIcon size={12} />
                            </span>
                          )}
                        </div>
                        <div className="mt-1 text-sm line-clamp-2">{s.message}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {fmtTime(s.createdAt)}{s.url ? ` · ${shortPath(s.url)}` : ''}
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      {/* Detail dialog */}
      <Dialog open={!!activeId} onOpenChange={(o) => !o && setActiveId(null)}>
        <DialogContent className="max-w-2xl">
          {!activeDetail && <div className="text-sm text-muted-foreground">Loading…</div>}
          {activeDetail?.error && <div className="text-sm text-destructive">Could not load submission.</div>}
          {activeDetail && !activeDetail.error && (
            <>
              <DialogHeader>
                <DialogTitle>Feedback submission</DialogTitle>
                <DialogDescription>
                  {fmtTime(activeDetail.createdAt)}
                </DialogDescription>
              </DialogHeader>

              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={STATUS_BADGE[activeDetail.status] || 'default'}>
                    {activeDetail.status}
                  </Badge>
                  {activeDetail.appVersion && (
                    <span className="text-xs text-muted-foreground">v{activeDetail.appVersion}</span>
                  )}
                  {activeDetail.endUserName && (
                    <span className="text-xs text-muted-foreground">
                      {activeDetail.endUserName}{activeDetail.endUserEmail ? ` · ${activeDetail.endUserEmail}` : ''}
                    </span>
                  )}
                </div>

                {/* React escapes by default; render as plain text. */}
                <div className="rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap break-words">
                  {activeDetail.message}
                </div>

                {activeDetail.url && (
                  <div className="text-xs text-muted-foreground flex items-center gap-1">
                    URL:&nbsp;
                    {isSafeHttpUrl(activeDetail.url) ? (
                      <a href={activeDetail.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline">
                        {activeDetail.url} <ExternalLink size={12} />
                      </a>
                    ) : (
                      <span className="font-mono">{activeDetail.url}</span>
                    )}
                  </div>
                )}

                {activeDetail.screenshotId && (
                  <a
                    href={screenshotUrl(activeDetail.screenshotId) ?? undefined}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="block rounded-md border overflow-hidden"
                  >
                    <img
                      src={screenshotUrl(activeDetail.screenshotId) ?? undefined}
                      crossOrigin="use-credentials"
                      alt="Submission screenshot"
                      className="w-full h-auto block"
                    />
                  </a>
                )}

                {activeDetail.userAgent && (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">User agent</summary>
                    <div className="mt-1 font-mono break-all">{activeDetail.userAgent}</div>
                  </details>
                )}
              </div>

              <DialogFooter className="flex-wrap gap-2">
                {activeDetail.status !== 'read' && (
                  <Button variant="outline" size="sm" onClick={() => updateStatus(activeDetail.id, 'read')}>
                    <MailOpen size={14} /> Mark read
                  </Button>
                )}
                {activeDetail.status !== 'new' && (
                  <Button variant="outline" size="sm" onClick={() => updateStatus(activeDetail.id, 'new')}>
                    <Mail size={14} /> Mark new
                  </Button>
                )}
                {activeDetail.status !== 'archived' && (
                  <Button variant="outline" size="sm" onClick={() => updateStatus(activeDetail.id, 'archived')}>
                    <Archive size={14} /> Archive
                  </Button>
                )}
                <AlertDialog>
                  <AlertDialogTrigger render={<Button variant="destructive" size="sm" />}>
                    <Trash2 size={14} /> Delete
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete submission?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This permanently removes the message and any attached screenshot.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => handleDelete(activeDetail.id)}>Delete</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
