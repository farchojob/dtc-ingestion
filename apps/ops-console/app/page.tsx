import { listTenants } from "@/lib/db";
import { overview } from "@/lib/queries";
import { Container, Notice } from "@/components/console/chrome";
import { TenantCard } from "@/components/console/views/home";

export const dynamic = "force-dynamic";

export default async function Home() {
  const tenants = await listTenants();
  const cards = await Promise.all(tenants.map(async (t) => ({ tenant: t, o: await overview(t.id) })));
  return (
    <Container className="pb-16 pt-8 md:pt-13">
      <h1 className="text-[28px] font-semibold tracking-[-0.03em] text-ink md:text-[32px]">Tenants</h1>
      <p className="mt-3 text-[14.5px] text-ink-muted">Each card is read inside that tenant&apos;s context. Nothing on this page joins across tenants.</p>
      {cards.length === 0 ? (
        <div className="mt-10">
          <Notice title="No tenant has run yet" commands={["npm run ingest -- --tenant northwind", "npm run ingest -- --tenant lumen"]}>
            A tenant appears here after its first run registers it. Both fixtures tenants are one command each.
          </Notice>
        </div>
      ) : (
        <div className="mt-8 grid gap-6 md:mt-10 md:grid-cols-2 md:gap-7">
          {cards.map(({ tenant, o }) => <TenantCard key={tenant.id} tenant={tenant} o={o} />)}
        </div>
      )}
    </Container>
  );
}
