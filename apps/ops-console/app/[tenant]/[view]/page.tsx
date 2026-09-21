import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listTenants } from "@/lib/db";
import { deliveries, holds, restatements, revenue, runs } from "@/lib/queries";

export const dynamic = "force-dynamic";

const VIEWS = [
  ["deliveries", "Deliveries"],
  ["runs", "Runs"],
  ["revenue", "Daily revenue"],
  ["restatements", "Restatements"],
  ["holds", "Holds"],
] as const;
type View = (typeof VIEWS)[number][0];

export default async function TenantView({ params }: { params: Promise<{ tenant: string; view: string }> }) {
  const { tenant: tenantId, view } = await params;
  const tenant = (await listTenants()).find((t) => t.id === tenantId);
  if (!tenant || !VIEWS.some(([v]) => v === view)) notFound();
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{tenant.display_name}</h1>
        <Badge variant="outline">{tenant.currency}</Badge>
        <nav className="flex gap-1 text-sm">
          {VIEWS.map(([v, label]) => (
            <Link key={v} href={`/${tenant.id}/${v}`} className={`rounded-md px-3 py-1 ${v === view ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"}`}>{label}</Link>
          ))}
        </nav>
      </div>
      {view === "deliveries" && <Deliveries tenantId={tenant.id} />}
      {view === "runs" && <Runs tenantId={tenant.id} />}
      {view === "revenue" && <Revenue tenantId={tenant.id} currency={tenant.currency} />}
      {view === "restatements" && <Restatements tenantId={tenant.id} />}
      {view === "holds" && <Holds tenantId={tenant.id} />}
    </div>
  );
}

const statusVariant = (s: string) => (s === "loaded" || s === "succeeded" ? "secondary" : s === "missing" || s === "failed" || s === "quarantined" ? "destructive" : "outline");
const num = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

async function Deliveries({ tenantId }: { tenantId: string }) {
  const rows = await deliveries(tenantId);
  const missing = rows.filter((r) => r.status === "missing").length;
  return (
    <section className="space-y-3">
      <p className="text-sm text-muted-foreground">What the manifest promised, against what loaded. {missing ? <span className="text-destructive">{missing} batch{missing > 1 ? "es" : ""} never arrived.</span> : "Everything arrived."}</p>
      <Table>
        <TableHeader><TableRow><TableHead>Source</TableHead><TableHead>Batch</TableHead><TableHead>Covers</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Rows</TableHead><TableHead>Schema</TableHead><TableHead className="text-right">Attempts</TableHead><TableHead>Loaded at</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={`${r.source}-${r.batch}`}>
              <TableCell className="font-mono text-xs">{r.source}</TableCell>
              <TableCell>{r.batch}</TableCell>
              <TableCell className="whitespace-nowrap">{r.covers_from} to {r.covers_to}</TableCell>
              <TableCell><Badge variant={statusVariant(r.status)}>{r.status}</Badge></TableCell>
              <TableCell className="text-right tabular-nums">{r.rows_seen ?? ""}</TableCell>
              <TableCell className="font-mono text-xs">{r.schema_version ?? ""}</TableCell>
              <TableCell className="text-right tabular-nums">{r.attempts ?? ""}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{r.loaded_at?.slice(0, 19) ?? ""}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

async function Runs({ tenantId }: { tenantId: string }) {
  const rows = await runs(tenantId);
  return (
    <section className="space-y-3">
      <p className="text-sm text-muted-foreground">Every invocation, newest first. A failed run leaves its files resumable; the next run picks them up.</p>
      <Table>
        <TableHeader><TableRow><TableHead>#</TableHead><TableHead>Status</TableHead><TableHead>Started</TableHead><TableHead className="text-right">Files</TableHead><TableHead className="text-right">Duplicates</TableHead><TableHead className="text-right">Rows inserted</TableHead><TableHead className="text-right">Restatements</TableHead><TableHead className="text-right">Missing</TableHead><TableHead>Args</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>{r.id}</TableCell>
              <TableCell><Badge variant={statusVariant(r.status)}>{r.status}</Badge>{r.error && <div className="mt-1 max-w-md text-xs text-destructive">{r.error}</div>}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{r.started_at.slice(0, 19)}</TableCell>
              <TableCell className="text-right tabular-nums">{r.files}</TableCell>
              <TableCell className="text-right tabular-nums">{r.duplicates}</TableCell>
              <TableCell className="text-right tabular-nums">{r.inserted}</TableCell>
              <TableCell className="text-right tabular-nums">{r.restatements}</TableCell>
              <TableCell className="text-right tabular-nums">{r.missing}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">{Object.entries(r.args).filter(([k, v]) => k !== "phases" && v !== undefined && v !== null).map(([k, v]) => `${k}=${String(v)}`).join(" ")}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

async function Revenue({ tenantId, currency }: { tenantId: string; currency: string }) {
  const rows = await revenue(tenantId);
  const channels = [...new Set(rows.flatMap((r) => Object.keys(r.by_channel)))].sort();
  return (
    <section className="space-y-3">
      <p className="text-sm text-muted-foreground">mart.daily_revenue in {currency}: gross by the order&apos;s day, refunds by the refund&apos;s day. A day marked incomplete is missing an expected batch.</p>
      <Table>
        <TableHeader><TableRow><TableHead>Day</TableHead><TableHead className="text-right">Orders</TableHead><TableHead className="text-right">Gross</TableHead><TableHead className="text-right">Refunds</TableHead><TableHead className="text-right">Net</TableHead>{channels.map((c) => <TableHead key={c} className="text-right">net · {c}</TableHead>)}<TableHead>Complete</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.day}>
              <TableCell className="whitespace-nowrap">{r.day}</TableCell>
              <TableCell className="text-right tabular-nums">{r.orders}</TableCell>
              <TableCell className="text-right tabular-nums">{num(r.gross)}</TableCell>
              <TableCell className="text-right tabular-nums">{num(r.refunds)}</TableCell>
              <TableCell className="text-right font-medium tabular-nums">{num(r.net)}</TableCell>
              {channels.map((c) => <TableCell key={c} className="text-right tabular-nums text-muted-foreground">{num(r.by_channel[c])}</TableCell>)}
              <TableCell>{r.complete ? <Badge variant="secondary">yes</Badge> : <Badge variant="destructive">no</Badge>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

async function Restatements({ tenantId }: { tenantId: string }) {
  const rows = await restatements(tenantId);
  return (
    <section className="space-y-3">
      <p className="text-sm text-muted-foreground">A number the client could already see, and what it became. One row per metric that moved, with the run and the sources that caused it.</p>
      {rows.length === 0 && <p className="text-sm">Nothing has been restated. Replay the deliveries in order (<code>--batches 1-4</code>, then a full run) to see late arrivals move numbers.</p>}
      <Table>
        <TableHeader><TableRow><TableHead>Mart</TableHead><TableHead>Day</TableHead><TableHead>Dimension</TableHead><TableHead>Metric</TableHead><TableHead className="text-right">Previous</TableHead><TableHead className="text-right">Current</TableHead><TableHead>Run</TableHead><TableHead>Cause</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-mono text-xs">{r.mart}</TableCell>
              <TableCell className="whitespace-nowrap">{r.day}</TableCell>
              <TableCell>{r.dimension}</TableCell>
              <TableCell>{r.metric}</TableCell>
              <TableCell className="text-right tabular-nums">{num(r.previous)}</TableCell>
              <TableCell className="text-right tabular-nums font-medium">{num(r.current)}</TableCell>
              <TableCell>#{r.run_id}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{r.cause}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

async function Holds({ tenantId }: { tenantId: string }) {
  const rows = await holds(tenantId);
  return (
    <section className="space-y-3">
      <p className="text-sm text-muted-foreground">Everything the pipeline held back or flagged instead of guessing: quarantined rows and files, schema events, re-deliveries with different content.</p>
      <Table>
        <TableHeader><TableRow><TableHead>Kind</TableHead><TableHead>Source</TableHead><TableHead>Reference</TableHead><TableHead>Reason</TableHead><TableHead>Detail</TableHead><TableHead>At</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              <TableCell><Badge variant={r.kind === "quarantine" ? "destructive" : "outline"}>{r.kind}</Badge></TableCell>
              <TableCell className="font-mono text-xs">{r.source}</TableCell>
              <TableCell className="font-mono text-xs">{r.ref}</TableCell>
              <TableCell>{r.reason}</TableCell>
              <TableCell className="max-w-md truncate font-mono text-xs text-muted-foreground">{JSON.stringify(r.detail)}</TableCell>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{r.at.slice(0, 19)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
