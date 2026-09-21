import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { listTenants } from "@/lib/db";
import { overview } from "@/lib/queries";

export const dynamic = "force-dynamic";

function money(v: string, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(v));
}

export default async function Home() {
  const tenants = await listTenants();
  const cards = await Promise.all(tenants.map(async (t) => ({ tenant: t, o: await overview(t.id) })));
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tenants</h1>
        <p className="text-sm text-muted-foreground">Each card is read inside that tenant&apos;s context. Nothing on this page joins across tenants.</p>
      </div>
      {cards.length === 0 && <p className="text-sm text-muted-foreground">No tenant has run yet. Run <code>npm run ingest -- --tenant northwind</code> first.</p>}
      <div className="grid gap-4 md:grid-cols-2">
        {cards.map(({ tenant, o }) => (
          <Card key={tenant.id}>
            <CardHeader>
              <CardTitle className="flex items-center gap-3">
                <Link href={`/${tenant.id}/deliveries`} className="hover:underline">{tenant.display_name}</Link>
                <Badge variant="outline">{tenant.currency}</Badge>
                {o.lastRun && <Badge variant={o.lastRun.status === "succeeded" ? "secondary" : "destructive"}>last run #{o.lastRun.id} {o.lastRun.status}</Badge>}
              </CardTitle>
              <CardDescription>{o.days} days of revenue · net {money(o.net, tenant.currency)} · gross {money(o.gross, tenant.currency)} · refunds {money(o.refunds, tenant.currency)}</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Stat href={`/${tenant.id}/deliveries`} label="deliveries" value={`${o.loaded} / ${o.expected}`} bad={o.missing > 0} note={o.missing ? `${o.missing} missing` : "all arrived"} />
              <Stat href={`/${tenant.id}/restatements`} label="restatements" value={String(o.restatements)} note="numbers that moved" />
              <Stat href={`/${tenant.id}/holds`} label="holds" value={String(o.quarantine)} bad={o.quarantine > 0} note="quarantined rows" />
              <Stat href={`/${tenant.id}/revenue`} label="incomplete days" value={String(o.incompleteDays)} bad={o.incompleteDays > 0} note="revenue days missing a batch" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function Stat({ href, label, value, note, bad }: { href: string; label: string; value: string; note: string; bad?: boolean }) {
  return (
    <Link href={href} className="rounded-md border p-3 hover:bg-muted/50">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-xl font-semibold ${bad ? "text-destructive" : ""}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{note}</div>
    </Link>
  );
}
