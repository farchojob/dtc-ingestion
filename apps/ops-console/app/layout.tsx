import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { listTenants } from "@/lib/db";

export const metadata: Metadata = {
  title: "dtc · ops console",
  description: "Deliveries, runs, restatements and quarantine for every tenant, read through row-level security.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const tenants = await listTenants().catch(() => []);
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-background text-foreground">
        <header className="border-b">
          <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
            <Link href="/" className="font-semibold tracking-tight">dtc · ops console</Link>
            <nav className="flex items-center gap-4 text-sm text-muted-foreground">
              {tenants.map((t) => (
                <Link key={t.id} href={`/${t.id}/deliveries`} className="hover:text-foreground">{t.display_name}</Link>
              ))}
            </nav>
            <span className="ml-auto text-xs text-muted-foreground">read-only · app_rw role · row-level security</span>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
