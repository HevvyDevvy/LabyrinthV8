import { type ReactNode, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BadgeCheck,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileKey2,
  FileWarning,
  Fingerprint,
  Hash,
  History,
  LayoutDashboard,
  LockKeyhole,
  Menu,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldEllipsis,
  X,
  XCircle,
} from 'lucide-react';
import {
  getGetAuditTrailQueryKey,
  getGetPendingRequestsQueryKey,
  getGetRequestHistoryQueryKey,
  getGetSecurityAlertsQueryKey,
  getGetSecuritySummaryQueryKey,
  useApproveProtectionRequest,
  useDenyProtectionRequest,
  useGetAuditTrail,
  useGetPendingRequests,
  useGetRequestHistory,
  useGetSecurityAlerts,
  useGetSecuritySummary,
  type AuditEvent,
  type ProtectionRequest,
  type SecurityAlert,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Link, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import '@/index.css';

const queryClient = new QueryClient();

function formatTime(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatRelative(value: string | null | undefined) {
  if (!value) return '—';
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff)) return value;
  const minutes = Math.max(1, Math.floor(diff / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-foreground/8 ${className}`} />;
}

function LoadingBlock({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" data-testid="loading-block">
      {Array.from({ length: rows }).map((_, index) => (
        <div className="flex items-center gap-4 border-b border-border/60 pb-4" key={index}>
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="flex-1 space-y-2"><Skeleton className="h-3 w-2/5" /><Skeleton className="h-3 w-4/5" /></div>
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon: Icon, title, detail }: { icon: typeof ShieldCheck; title: string; detail: string }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center px-6 text-center" data-testid="empty-state">
      <div className="mb-3 rounded-full border border-primary/25 bg-primary/8 p-3 text-primary"><Icon size={20} /></div>
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center px-6 text-center" data-testid="error-state">
      <div className="mb-3 rounded-full border border-destructive/25 bg-destructive/8 p-3 text-destructive"><AlertTriangle size={20} /></div>
      <p className="text-sm font-semibold">Signal unavailable</p>
      <p className="mt-1 text-xs text-muted-foreground">The latest evidence could not be retrieved.</p>
      <button className="mt-4 inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs font-semibold hover-elevate" onClick={onRetry} data-testid="button-retry">
        <RefreshCw size={13} /> Retry
      </button>
    </div>
  );
}

function StatusPill({ status, label }: { status: 'critical' | 'warning' | 'info' | 'pending' | 'approved' | 'denied' | 'intact'; label?: string }) {
  const styles = {
    critical: 'border-destructive/25 bg-destructive/8 text-destructive',
    warning: 'border-accent/35 bg-accent/12 text-accent-foreground',
    info: 'border-primary/25 bg-primary/8 text-primary',
    pending: 'border-accent/35 bg-accent/12 text-accent-foreground',
    approved: 'border-primary/25 bg-primary/8 text-primary',
    denied: 'border-destructive/25 bg-destructive/8 text-destructive',
    intact: 'border-primary/25 bg-primary/8 text-primary',
  };
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-[.1em] ${styles[status]}`} data-testid={`status-${status}`}>
    <span className={`h-1.5 w-1.5 rounded-full ${status === 'critical' || status === 'denied' ? 'bg-destructive' : status === 'warning' || status === 'pending' ? 'bg-accent' : 'bg-primary'}`} />
    {label ?? status}
  </span>;
}

function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navItems = [
    { href: '/', label: 'Overview', icon: LayoutDashboard, exact: true },
    { href: '/requests', label: 'Protection requests', icon: LockKeyhole, count: true },
    { href: '/audit', label: 'Audit trail', icon: History },
  ];
  const active = (href: string, exact?: boolean) => exact ? location === href : location.startsWith(href);
  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-[256px] flex-col bg-sidebar text-sidebar-foreground transition-transform duration-300 md:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-[76px] items-center gap-3 border-b border-sidebar-border px-6">
          <div className="relative h-10 w-10 overflow-hidden rounded-lg border border-sidebar-primary/40 bg-sidebar-primary text-sidebar-primary-foreground">
            <img src="/labyrinth-lock.png" alt="Labyrinth lock emblem" className="h-full w-full object-cover object-center" />
            <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-accent ring-2 ring-sidebar" />
          </div>
          <div>
            <p className="text-sm font-extrabold tracking-[-.02em]">Labyrinth<span className="text-sidebar-primary">V8</span></p>
            <p className="eyebrow mt-0.5 text-sidebar-foreground/45">Security operations</p>
          </div>
        </div>
        <div className="px-4 pt-8">
          <p className="eyebrow px-3 text-sidebar-foreground/35">Command center</p>
          <nav className="mt-3 space-y-1" aria-label="Primary navigation">
            {navItems.map(({ href, label, icon: Icon, count, exact }) => (
              <Link
                href={href}
                key={href}
                onClick={() => setMobileOpen(false)}
                className={`group flex items-center justify-between rounded-lg px-3 py-3 text-sm transition-colors ${active(href, exact) ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground'}`}
                data-testid={`link-${label.toLowerCase().replaceAll(' ', '-')}`}
              >
                <span className="flex items-center gap-3"><Icon size={17} strokeWidth={1.8} /><span>{label}</span></span>
                {count && <span className="rounded bg-accent/18 px-1.5 py-0.5 data-mono text-[10px] text-accent">live</span>}
              </Link>
            ))}
          </nav>
        </div>
        <div className="mt-auto p-5">
          <div className="rounded-xl border border-sidebar-border bg-sidebar-accent/40 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold"><span className="h-2 w-2 rounded-full bg-sidebar-primary" /> Protection engine online</div>
            <p className="mt-2 text-[11px] leading-5 text-sidebar-foreground/45">Human approval is required before any file action.</p>
            <div className="mt-3 flex items-center justify-between border-t border-sidebar-border pt-3 text-[10px] text-sidebar-foreground/40">
              <span className="data-mono">NODE L-08</span><span>v8.0.4</span>
            </div>
          </div>
        </div>
      </aside>
      {mobileOpen && <button className="fixed inset-0 z-30 bg-sidebar/40 md:hidden" onClick={() => setMobileOpen(false)} aria-label="Close navigation" data-testid="button-close-navigation" />}
      <main className="min-h-[100dvh] md:pl-[256px]">
        <header className="sticky top-0 z-20 flex h-[76px] items-center justify-between border-b border-border/80 bg-background/90 px-5 backdrop-blur-md md:px-10">
          <button className="rounded-md p-2 text-muted-foreground hover:bg-muted md:hidden" onClick={() => setMobileOpen(true)} data-testid="button-open-navigation"><Menu size={20} /></button>
          <div className="hidden items-center gap-2 text-xs text-muted-foreground md:flex"><span className="data-mono text-[10px] text-primary">L8 /</span><span>protected workspace</span></div>
          <div className="ml-auto flex items-center gap-4">
            <div className="hidden items-center gap-2 text-[11px] text-muted-foreground sm:flex"><span className="h-1.5 w-1.5 rounded-full bg-primary" /> all systems nominal</div>
            <div className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-card text-xs font-bold text-primary" data-testid="text-operator-avatar">SO</div>
            <span className="hidden text-xs font-semibold sm:block" data-testid="text-operator-name">Security operator</span>
          </div>
        </header>
        <div className="mx-auto max-w-[1480px] px-5 py-8 md:px-10 md:py-10">{children}</div>
      </main>
    </div>
  );
}

function PageHeading({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
      <div className="animate-rise-in">
        <p className="eyebrow text-primary" data-testid="text-page-eyebrow">{eyebrow}</p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-[-.045em] text-foreground md:text-[40px]" data-testid="text-page-title">{title}</h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground" data-testid="text-page-detail">{detail}</p>
      </div>
      {action && <div className="animate-rise-in-delay-1">{action}</div>}
    </div>
  );
}

function SectionTitle({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: ReactNode }) {
  return <div className="mb-5 flex items-end justify-between gap-3">
    <div>{eyebrow && <p className="eyebrow mb-1 text-muted-foreground">{eyebrow}</p>}<h2 className="text-base font-bold tracking-[-.02em]">{title}</h2></div>
    {action}
  </div>;
}

function MetricCard({ label, value, detail, icon: Icon, tone = 'neutral', testId }: { label: string; value: string | number; detail: string; icon: typeof Activity; tone?: 'neutral' | 'alert' | 'ok' | 'warm'; testId: string }) {
  const color = tone === 'alert' ? 'text-destructive bg-destructive/8 border-destructive/20' : tone === 'ok' ? 'text-primary bg-primary/8 border-primary/20' : tone === 'warm' ? 'text-accent-foreground bg-accent/10 border-accent/25' : 'text-foreground bg-card border-border';
  return <div className={`relative overflow-hidden rounded-xl border p-5 transition-transform duration-200 hover:-translate-y-0.5 ${color}`} data-testid={testId}>
    <div className="flex items-start justify-between"><p className="eyebrow opacity-70">{label}</p><Icon size={17} strokeWidth={1.7} /></div>
    <p className="mt-4 text-3xl font-extrabold tracking-[-.06em]" data-testid={`value-${testId}`}>{value}</p>
    <p className="mt-1 text-xs opacity-65">{detail}</p>
    <div className="absolute -bottom-7 -right-4 h-24 w-24 rounded-full border border-current opacity-[.08]" />
  </div>;
}

function AlertRow({ alert }: { alert: SecurityAlert }) {
  return <div className="group flex gap-4 border-b border-border/70 py-4 last:border-0" data-testid={`row-alert-${alert.id}`}>
    <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${alert.severity === 'critical' ? 'bg-destructive/10 text-destructive' : alert.severity === 'warning' ? 'bg-accent/15 text-accent-foreground' : 'bg-primary/10 text-primary'}`}>
      {alert.severity === 'critical' ? <FileWarning size={16} /> : <AlertTriangle size={16} />}
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2"><p className="text-sm font-bold">{alert.kind}</p><StatusPill status={alert.severity} /></div>
      <p className="data-mono mt-1 truncate text-[11px] text-primary" title={alert.path}>{alert.path}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{alert.detail}</p>
    </div>
    <time className="shrink-0 text-[10px] text-muted-foreground" dateTime={alert.timestamp}>{formatRelative(alert.timestamp)}</time>
  </div>;
}

function ChainCard({ intact, events = 0 }: { intact: boolean; events?: number }) {
  return <div className={`relative overflow-hidden rounded-xl border p-5 ${intact ? 'border-primary/25 bg-primary/6' : 'border-destructive/25 bg-destructive/6'}`} data-testid="card-chain-status">
    <div className="flex items-start justify-between">
      <div><p className="eyebrow text-muted-foreground">Audit chain</p><h3 className="mt-2 text-lg font-bold">{intact ? 'Integrity confirmed' : 'Review required'}</h3></div>
      <div className={`rounded-lg p-2.5 ${intact ? 'bg-primary/12 text-primary' : 'bg-destructive/12 text-destructive'}`}><Fingerprint size={20} /></div>
    </div>
    <div className="mt-5 flex items-center gap-2" data-testid="status-audit-chain">
      <StatusPill status={intact ? 'intact' : 'critical'} label={intact ? 'chain intact' : 'chain mismatch'} />
      <span className="data-mono text-[10px] text-muted-foreground">{events} events indexed</span>
    </div>
    <div className="chain-line absolute bottom-0 left-0 h-1 w-full bg-primary/55" />
  </div>;
}

function Overview() {
  const summaryQuery = useGetSecuritySummary();
  const alertsQuery = useGetSecurityAlerts();
  const pendingQuery = useGetPendingRequests();
  const auditQuery = useGetAuditTrail();
  const summary = summaryQuery.data;
  const alerts = alertsQuery.data ?? [];
  const pending = pendingQuery.data ?? [];
  const criticalCount = summary?.criticalAlerts ?? alerts.filter((alert) => alert.severity === 'critical').length;
  return (
    <div>
      <PageHeading eyebrow="Security overview / live" title="Quiet protection, clear evidence." detail="A focused view of what needs a human eye today. No action is taken without a named operator." action={<Link href="/audit" className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-xs font-bold hover-elevate" data-testid="link-open-audit"><Fingerprint size={15} className="text-primary" /> Inspect audit chain <ArrowUpRight size={14} /></Link>} />
      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {summaryQuery.isLoading ? Array.from({ length: 4 }).map((_, i) => <Skeleton className="h-[139px] rounded-xl" key={i} />) : <>
          <MetricCard label="Pending review" value={summary?.pending ?? pending.length} detail="protection requests" icon={Clock3} tone="warm" testId="metric-pending" />
          <MetricCard label="Critical alerts" value={criticalCount} detail="integrity signals" icon={AlertTriangle} tone={criticalCount ? 'alert' : 'ok'} testId="metric-critical" />
          <MetricCard label="Monitored files" value={summary?.monitoredFiles ?? '—'} detail="under observation" icon={FileKey2} tone="neutral" testId="metric-monitored" />
          <MetricCard label="Last scan" value={summary?.lastScan ? formatRelative(summary.lastScan) : '—'} detail={summary?.scanInterval ? `every ${summary.scanInterval}` : 'scan timestamp'} icon={Activity} tone="ok" testId="metric-scan" />
        </>}
      </div>
      <div className="grid gap-6 xl:grid-cols-[1.18fr_.82fr]">
        <section className="rounded-xl border border-border bg-card p-5 md:p-6 animate-rise-in-delay-1" data-testid="section-active-alerts">
          <SectionTitle eyebrow="Integrity monitor" title="Active alerts" action={<Link href="/audit" className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline" data-testid="link-alert-audit">View evidence <ChevronRight size={14} /></Link>} />
          {alertsQuery.isLoading ? <LoadingBlock /> : alertsQuery.isError ? <ErrorState onRetry={() => alertsQuery.refetch()} /> : alerts.length === 0 ? <EmptyState icon={ShieldCheck} title="No active alerts" detail="The monitor has not surfaced any integrity deviations." /> : <div>{alerts.slice(0, 5).map((alert) => <AlertRow alert={alert} key={alert.id} />)}</div>}
        </section>
        <div className="space-y-6">
          <ChainCard intact={summary?.chainIntact ?? auditQuery.data?.chainIntact ?? true} events={auditQuery.data?.events.length ?? 0} />
          <section className="rounded-xl border border-border bg-card p-5 md:p-6 animate-rise-in-delay-2" data-testid="section-pending-approvals">
            <SectionTitle eyebrow="Human gate" title="Pending approvals" action={<Link href="/requests" className="text-xs font-bold text-primary hover:underline" data-testid="link-all-requests">Review all</Link>} />
            {pendingQuery.isLoading ? <LoadingBlock rows={2} /> : pendingQuery.isError ? <ErrorState onRetry={() => pendingQuery.refetch()} /> : pending.length === 0 ? <EmptyState icon={BadgeCheck} title="Queue is clear" detail="There are no protection actions waiting for a decision." /> : <div className="space-y-3">{pending.slice(0, 3).map((request) => <RequestCompact request={request} key={request.id} />)}</div>}
          </section>
        </div>
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-[.8fr_1.2fr]">
        <div className="grid-signal rounded-xl border border-border bg-card p-6" data-testid="card-operating-principle">
          <p className="eyebrow text-primary">Operating principle</p>
          <p className="mt-5 max-w-md text-xl font-bold leading-8 tracking-[-.03em]">Protection should be visible, attributable, and reversible.</p>
          <p className="mt-3 max-w-md text-xs leading-5 text-muted-foreground">Labyrinth observes sensitive paths without touching them until an operator makes the call.</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-6" data-testid="card-scan-context">
          <div className="flex items-center justify-between"><div><p className="eyebrow text-muted-foreground">Scan context</p><p className="mt-2 text-sm font-bold">The quiet interval</p></div><ShieldCheck className="text-primary" size={21} /></div>
          <div className="mt-6 grid grid-cols-3 gap-4 border-t border-border pt-5">
            <div><p className="data-mono text-lg font-medium">{summary?.scanInterval ?? '—'}</p><p className="mt-1 text-[10px] text-muted-foreground">interval</p></div>
            <div><p className="data-mono text-lg font-medium">{summary?.lastScan ? formatTime(summary.lastScan).split(',')[1] : '—'}</p><p className="mt-1 text-[10px] text-muted-foreground">last sweep</p></div>
            <div><p className="data-mono text-lg font-medium text-primary">{summary?.chainIntact ? 'verified' : 'review'}</p><p className="mt-1 text-[10px] text-muted-foreground">chain state</p></div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RequestCompact({ request }: { request: ProtectionRequest }) {
  return <Link href="/requests" className="block rounded-lg border border-border/80 p-3 transition-colors hover:border-primary/40 hover:bg-primary/4" data-testid={`link-request-${request.id}`}>
    <div className="flex items-center justify-between gap-3"><p className="data-mono min-w-0 truncate text-[11px] text-primary">{request.path}</p><ChevronRight className="shrink-0 text-muted-foreground" size={14} /></div>
    <p className="mt-2 line-clamp-1 text-xs text-muted-foreground">{request.reason}</p>
    <p className="mt-2 text-[10px] text-muted-foreground">{formatRelative(request.createdAt)}</p>
  </Link>;
}

function DecisionDialog({ request, decision, onClose, onSubmit, isPending }: { request: ProtectionRequest; decision: 'approve' | 'deny'; onClose: () => void; onSubmit: (approver: string) => void; isPending: boolean }) {
  const [approver, setApprover] = useState('');
  const isApprove = decision === 'approve';
  const valid = approver.trim().length >= 2;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-sidebar/45 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" data-testid="dialog-decision">
    <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl animate-rise-in">
      <div className="flex items-start justify-between gap-4"><div><div className={`mb-3 inline-flex rounded-lg p-2 ${isApprove ? 'bg-primary/10 text-primary' : 'bg-destructive/10 text-destructive'}`}>{isApprove ? <Check size={18} /> : <X size={18} />}</div><h2 className="text-xl font-bold tracking-[-.03em]">{isApprove ? 'Approve protection?' : 'Deny protection?'}</h2></div><button className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" onClick={onClose} data-testid="button-close-dialog"><X size={18} /></button></div>
      <div className="mt-5 rounded-lg border border-border bg-background/60 p-3"><p className="data-mono truncate text-xs text-primary">{request.path}</p><p className="mt-2 text-xs leading-5 text-muted-foreground">{request.reason}</p></div>
      <label className="mt-5 block text-xs font-bold" htmlFor="approver-input">{isApprove ? 'Named approver' : 'Named decision-maker'}<span className="ml-1 text-destructive">*</span></label>
      <input id="approver-input" autoFocus value={approver} onChange={(event) => setApprover(event.target.value)} placeholder="Enter your full name" className="mt-2 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none ring-primary/30 placeholder:text-muted-foreground/60 focus:ring-4" data-testid="input-approver" />
      <p className="mt-2 text-[11px] text-muted-foreground">This name will be written to the tamper-evident audit trail.</p>
      <div className="mt-6 flex justify-end gap-2"><button className="rounded-lg px-4 py-2.5 text-xs font-bold text-muted-foreground hover:bg-muted" onClick={onClose} data-testid="button-cancel-decision">Cancel</button><button disabled={!valid || isPending} onClick={() => onSubmit(approver.trim())} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs font-bold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45 ${isApprove ? 'bg-primary' : 'bg-destructive'}`} data-testid={`button-confirm-${decision}`}>{isPending ? <RefreshCw size={14} className="animate-spin" /> : isApprove ? <Check size={14} /> : <X size={14} />}{isPending ? 'Writing decision…' : isApprove ? 'Approve request' : 'Deny request'}</button></div>
    </div>
  </div>;
}

function RequestRow({ request, onDecision }: { request: ProtectionRequest; onDecision: (request: ProtectionRequest, decision: 'approve' | 'deny') => void }) {
  const pending = request.status === 'pending';
  return <div className="rounded-xl border border-border bg-card p-4 md:p-5" data-testid={`row-request-${request.id}`}>
    <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><StatusPill status={request.status} /><span className="data-mono text-[10px] text-muted-foreground">#{request.id}</span></div><p className="data-mono mt-3 break-all text-sm font-medium text-primary" data-testid={`text-request-path-${request.id}`}>{request.path}</p><p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">{request.reason}</p></div>
      <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-right text-[10px] text-muted-foreground lg:min-w-[180px]"><span>created</span><span className="data-mono text-foreground">{formatTime(request.createdAt)}</span>{!pending && <><span>decided by</span><span className="font-semibold text-foreground">{request.decidedBy ?? '—'}</span></>}{request.encryptedTo && <><span>encrypted to</span><span className="data-mono truncate text-primary">{request.encryptedTo}</span></>}</div>
    </div>
    {pending && <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4"><p className="flex items-center gap-2 text-[11px] text-muted-foreground"><ShieldCheck size={14} className="text-primary" /> Review the evidence before authorizing</p><div className="flex gap-2"><button className="inline-flex items-center gap-2 rounded-lg border border-destructive/30 px-3 py-2 text-xs font-bold text-destructive hover:bg-destructive/8" onClick={() => onDecision(request, 'deny')} data-testid={`button-deny-${request.id}`}><X size={14} /> Deny</button><button className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-foreground hover:opacity-90" onClick={() => onDecision(request, 'approve')} data-testid={`button-approve-${request.id}`}><Check size={14} /> Approve protection</button></div></div>}
  </div>;
}

function Requests() {
  const queryClientInstance = useQueryClient();
  const pendingQuery = useGetPendingRequests();
  const historyQuery = useGetRequestHistory();
  const approveMutation = useApproveProtectionRequest();
  const denyMutation = useDenyProtectionRequest();
  const [dialog, setDialog] = useState<{ request: ProtectionRequest; decision: 'approve' | 'deny' } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = pendingQuery.data ?? [];
  const history = historyQuery.data ?? [];
  const busy = approveMutation.isPending || denyMutation.isPending;
  const handleDecision = (approver: string) => {
    if (!dialog) return;
    const mutation = dialog.decision === 'approve' ? approveMutation : denyMutation;
    mutation.mutate({ id: dialog.request.id, data: { approver } }, {
      onSuccess: (result) => {
        queryClientInstance.invalidateQueries({ queryKey: getGetPendingRequestsQueryKey() });
        queryClientInstance.invalidateQueries({ queryKey: getGetRequestHistoryQueryKey() });
        queryClientInstance.invalidateQueries({ queryKey: getGetSecuritySummaryQueryKey() });
        queryClientInstance.invalidateQueries({ queryKey: getGetAuditTrailQueryKey() });
        setDialog(null);
        setNotice(result.message);
      },
      onError: () => setNotice('Decision could not be written. Please retry.'),
    });
  };
  return <div>
    <PageHeading eyebrow="Protection requests / human gate" title="Review before action." detail="Every protection request arrives with a path and a reason. Approve only when the evidence is sufficient, and leave a name behind." />
    {notice && <div className="mb-6 flex items-center justify-between gap-3 rounded-lg border border-primary/25 bg-primary/7 px-4 py-3 text-xs font-semibold text-primary animate-rise-in" role="status" data-testid="status-decision-feedback"><span className="flex items-center gap-2"><CheckCircle2 size={16} />{notice}</span><button onClick={() => setNotice(null)} className="text-primary/60 hover:text-primary" data-testid="button-dismiss-feedback"><X size={14} /></button></div>}
    <section className="mb-8" data-testid="section-pending-requests"><SectionTitle eyebrow={`${pending.length} awaiting a decision`} title="Pending queue" action={<div className="flex items-center gap-2 text-[10px] text-muted-foreground"><span className="h-1.5 w-1.5 rounded-full bg-accent" /> live queue</div>} />
      {pendingQuery.isLoading ? <LoadingBlock rows={3} /> : pendingQuery.isError ? <ErrorState onRetry={() => pendingQuery.refetch()} /> : pending.length === 0 ? <div className="rounded-xl border border-border bg-card"><EmptyState icon={BadgeCheck} title="No pending requests" detail="The approval queue is clear. New protection proposals will appear here." /></div> : <div className="space-y-3">{pending.map((request) => <RequestRow key={request.id} request={request} onDecision={(selected, decision) => setDialog({ request: selected, decision })} />)}</div>}
    </section>
    <section data-testid="section-request-history"><SectionTitle eyebrow="Decided requests" title="Decision history" action={<span className="data-mono text-[10px] text-muted-foreground">{history.length} records</span>} />
      {historyQuery.isLoading ? <LoadingBlock rows={3} /> : historyQuery.isError ? <ErrorState onRetry={() => historyQuery.refetch()} /> : history.length === 0 ? <div className="rounded-xl border border-border bg-card"><EmptyState icon={History} title="No decisions recorded" detail="Completed approvals and denials will remain inspectable here." /></div> : <div className="space-y-3">{history.map((request) => <RequestRow key={request.id} request={request} onDecision={() => undefined} />)}</div>}
    </section>
    {dialog && <DecisionDialog request={dialog.request} decision={dialog.decision} onClose={() => !busy && setDialog(null)} onSubmit={handleDecision} isPending={busy} />}
  </div>;
}

function AuditEventRow({ event, index }: { event: AuditEvent; index: number }) {
  return <div className="relative flex gap-4 pb-7 last:pb-0" data-testid={`row-audit-${event.id}`}>
    {index !== 0 && <div className="absolute left-[15px] top-[-18px] h-[18px] w-px bg-border" />}
    <div className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/8 text-primary"><Hash size={13} /></div>
    <div className="min-w-0 flex-1 rounded-lg border border-border/75 bg-card p-4">
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-bold">{event.action}</p><span className="data-mono rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{event.actor}</span></div><time className="data-mono text-[10px] text-muted-foreground" dateTime={event.timestamp}>{formatTime(event.timestamp)}</time></div>
      <p className="data-mono mt-3 break-all text-xs text-primary">{event.target}</p><p className="mt-2 text-xs leading-5 text-muted-foreground">{event.detail}</p>
    </div>
  </div>;
}

function Audit() {
  const auditQuery = useGetAuditTrail();
  const audit = auditQuery.data;
  const events = useMemo(() => audit?.events ?? [], [audit?.events]);
  return <div>
    <PageHeading eyebrow="Audit / inspectable evidence" title="The trail holds." detail="A chronological record of observations and decisions. Verify the chain first, then inspect the event that matters." action={<button onClick={() => auditQuery.refetch()} className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-xs font-bold hover-elevate" data-testid="button-refresh-audit"><RefreshCw size={14} className={auditQuery.isFetching ? 'animate-spin' : ''} /> Refresh trail</button>} />
    {auditQuery.isLoading ? <div className="space-y-5"><Skeleton className="h-36 rounded-xl" /><LoadingBlock rows={5} /></div> : auditQuery.isError ? <div className="rounded-xl border border-border bg-card"><ErrorState onRetry={() => auditQuery.refetch()} /></div> : <div className="grid gap-6 xl:grid-cols-[.75fr_1.25fr]">
      <div className="space-y-6">
        <div className={`rounded-xl border p-6 ${audit?.chainIntact ? 'border-primary/30 bg-primary/7' : 'border-destructive/30 bg-destructive/7'}`} data-testid="card-chain-verification">
          <div className="flex items-center gap-3"><div className={`rounded-lg p-2.5 ${audit?.chainIntact ? 'bg-primary/12 text-primary' : 'bg-destructive/12 text-destructive'}`}>{audit?.chainIntact ? <CheckCircle2 size={21} /> : <XCircle size={21} />}</div><div><p className="eyebrow text-muted-foreground">Cryptographic posture</p><h2 className="mt-1 text-xl font-extrabold tracking-[-.04em]">{audit?.chainIntact ? 'Chain verified' : 'Chain mismatch'}</h2></div></div>
          <p className="mt-5 text-xs leading-5 text-muted-foreground">{audit?.chainIntact ? 'Events are linked in sequence and no tampering signal is present in the indexed trail.' : 'The event sequence needs operator review before it can be trusted.'}</p>
          <div className="mt-5 flex items-center justify-between border-t border-current/10 pt-4 text-[10px]"><span className="data-mono text-muted-foreground">VERIFICATION STATUS</span><StatusPill status={audit?.chainIntact ? 'intact' : 'critical'} label={audit?.chainIntact ? 'verified' : 'mismatch'} /></div>
        </div>
        <div className="rounded-xl border border-border bg-card p-6" data-testid="card-audit-summary"><SectionTitle eyebrow="Index" title="Trail summary" /><div className="space-y-4 text-xs"><div className="flex justify-between"><span className="text-muted-foreground">Indexed events</span><span className="data-mono font-medium">{events.length}</span></div><div className="flex justify-between"><span className="text-muted-foreground">Latest event</span><span className="data-mono font-medium">{events[0] ? formatRelative(events[0].timestamp) : '—'}</span></div><div className="flex justify-between"><span className="text-muted-foreground">Record mode</span><span className="font-semibold text-primary">append-only</span></div></div></div>
        <div className="rounded-xl border border-border bg-card p-6"><div className="flex gap-3"><Search size={16} className="mt-0.5 text-primary" /><div><p className="text-xs font-bold">What belongs here?</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Scans, integrity observations, and named protection decisions. Nothing is silently discarded.</p></div></div></div>
      </div>
      <section className="rounded-xl border border-border bg-background/35 p-5 md:p-6" data-testid="section-audit-events"><SectionTitle eyebrow="Most recent first" title="Audit events" action={<span className="data-mono text-[10px] text-muted-foreground">{events.length} indexed</span>} />{events.length === 0 ? <EmptyState icon={History} title="The trail is empty" detail="No audit events have been recorded yet." /> : <div className="mt-7">{events.map((event, index) => <AuditEventRow event={event} index={index} key={event.id} />)}</div>}</section>
    </div>}
  </div>;
}

function Router() {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}><Shell><Switch><Route path="/" component={Overview} /><Route path="/requests" component={Requests} /><Route path="/audit" component={Audit} /><Route component={NotFound} /></Switch></Shell></ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;