import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { listTenants, type Tenant } from "@/lib/db";
import { currentTheme } from "@/lib/theme";
import { Container, Notice, RoleStrip, TopBar } from "@/components/console/chrome";

export const metadata: Metadata = {
  title: "dtc · ops console",
  description: "Deliveries, runs, restatements and holds for every tenant, read through row-level security.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = await currentTheme();
  const path = (await headers()).get("x-pathname") ?? "/";
  let tenants: Tenant[] | null = null;
  let dbError: string | null = null;
  try {
    tenants = await listTenants();
  } catch (err) {
    dbError = (err as Error).message;
  }
  return (
    <html lang="en" className={theme ?? undefined}>
      <body className="flex min-h-screen flex-col">
        <TopBar tenants={tenants ?? []} back={path} />
        <div className="grow">
          {tenants ? children : (
            <Container className="py-16">
              <Notice title="The database is not reachable" commands={["cp .env.example .env", "npm run db:up && npm run migrate"]}>
                {dbError ?? "Connection failed."} The console reads through <span className="font-mono">APP_DATABASE_URL</span> in <span className="font-mono">.env</span>.
              </Notice>
            </Container>
          )}
        </div>
        <footer className="md:hidden">
          <Container className="py-8"><RoleStrip /></Container>
        </footer>
      </body>
    </html>
  );
}
