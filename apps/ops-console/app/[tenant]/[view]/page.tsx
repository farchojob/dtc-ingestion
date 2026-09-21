import { notFound } from "next/navigation";
import { listTenants } from "@/lib/db";
import { deliveries, holds, restatements, revenue, runs } from "@/lib/queries";
import { Container, TenantHeader, VIEWS, type View } from "@/components/console/chrome";
import { DeliveriesView } from "@/components/console/views/deliveries";
import { RunsView } from "@/components/console/views/runs";
import { RevenueView } from "@/components/console/views/revenue";
import { RestatementsView } from "@/components/console/views/restatements";
import { HoldsView } from "@/components/console/views/holds";
import { symbol } from "@/lib/format";

export const dynamic = "force-dynamic";

type Params = Promise<{ tenant: string; view: string }>;
type Search = Promise<{ open?: string }>;

export default async function TenantView({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { tenant: tenantId, view } = await params;
  const { open } = await searchParams;
  const tenant = (await listTenants()).find((t) => t.id === tenantId);
  if (!tenant || !VIEWS.some(([v]) => v === view)) notFound();
  const v = view as View;

  if (v === "deliveries") {
    const d = await deliveries(tenant.id);
    const missing = d.rows.filter((r) => r.status === "missing").length;
    return (
      <>
        <TenantHeader tenant={tenant} view={v} lastRun={d.lastRun}
          explainer={<>What the manifest promised, against what loaded. {missing ? `${missing === 1 ? "One batch" : `${missing} batches`} of ${d.rows.length} never arrived.` : "Everything arrived."}</>} />
        <Container className="pb-16 pt-10"><DeliveriesView matrix={d.matrix} rows={d.rows} rowsLoaded={d.rowsLoaded} /></Container>
      </>
    );
  }
  if (v === "runs") {
    const r = await runs(tenant.id);
    return (
      <>
        <TenantHeader tenant={tenant} view={v} lastRun={r.lastRun} explainer="Every invocation, newest first. A failed run leaves its files resumable; the next run picks them up." />
        <Container className="pb-16 pt-10"><RunsView rows={r.rows} tenantName={tenant.display_name} /></Container>
      </>
    );
  }
  if (v === "revenue") {
    const t = await revenue(tenant.id);
    const sym = symbol(tenant.currency);
    return (
      <>
        <TenantHeader tenant={tenant} view={v} lastRun={t.lastRun}
          explainer={<>One row per day, after every restatement. Money is in {tenant.currency}; the symbol {sym} lives in the header, not in the cells. A day marked incomplete is missing an expected batch.</>} />
        <Container className="pb-16 pt-10"><RevenueView t={t} /></Container>
      </>
    );
  }
  if (v === "restatements") {
    const r = await restatements(tenant.id);
    return (
      <>
        <TenantHeader tenant={tenant} view={v} lastRun={r.lastRun}
          explainer={r.total ? "A number the client could already see, and what it became. One row per metric that moved; the day carries the run and the sources that caused it."
            : `A number the client could already see, and what it became. Nothing has moved yet for ${tenant.display_name}.`} />
        <Container className="pb-16 pt-10"><RestatementsView data={r} tenant={tenant} /></Container>
      </>
    );
  }
  const h = await holds(tenant.id);
  return (
    <>
      <TenantHeader tenant={tenant} view={v} lastRun={h.lastRun}
        explainer="Everything the pipeline held back or flagged instead of guessing. Held rows never reach the numbers; schema events explain how a changed file was still read." />
      <Container className="pb-16 pt-10"><HoldsView data={h} tenantId={tenant.id} open={open} /></Container>
    </>
  );
}
