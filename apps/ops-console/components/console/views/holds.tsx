import Link from "next/link";
import type { Holds, HoldRow } from "@/lib/queries";
import { money, stamp } from "@/lib/format";
import { cn } from "cn";
import { Num, SourceChip, StateWord } from "../atoms";
import { Notice } from "../chrome";
import { BandRow, SectionHead, Tbl, Tbody, Td, Th, Thead, Tr } from "../table";

const OTHER_REASONS = ["unmapped_value", "missing_required", "bad_value", "unparseable"];
/** Identifying keys first, whatever order the JSON stores them in. */
const DETAIL_PRIORITY = ["order_id", "refund_id", "event_id", "field", "alias", "value", "map", "columns", "fields", "amount", "error", "file"];
const MONEY_KEYS = new Set(["amount", "gross", "spend", "net", "refunds"]);

function orderedEntries(detail: Record<string, unknown>): [string, unknown][] {
  const rank = (k: string) => { const i = DETAIL_PRIORITY.indexOf(k); return i < 0 ? DETAIL_PRIORITY.length : i; };
  return Object.entries(detail).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

function show(k: string, v: unknown): string {
  if (typeof v === "number" && MONEY_KEYS.has(k)) return money(v);
  return Array.isArray(v) ? v.join(", ") : String(v);
}

/** The keys that identify the record, inline; the rest is a count. The full object opens in place via ?open=<ref>. */
function DetailInline({ detail }: { detail: Record<string, unknown> }) {
  const entries = orderedEntries(detail).filter(([, v]) => v !== null && (typeof v !== "object" || Array.isArray(v)));
  const shown = entries.slice(0, 2);
  const rest = Object.keys(detail).length - shown.length;
  return (
    <span className="inline-flex items-baseline gap-[10px] whitespace-nowrap">
      {shown.map(([k, v], i) => (
        <span key={k} className="inline-flex items-baseline gap-[10px]">
          {i > 0 && <span className="text-hairline-2">·</span>}
          <span className="inline-flex items-baseline gap-[6px]"><span className="font-mono text-[12px] text-ink-muted">{k}</span><span className="font-mono text-[12.5px] text-ink-2">{show(k, v)}</span></span>
        </span>
      ))}
      {rest > 0 && <><span className="text-hairline-2">·</span><span className="text-[12px] text-ink-muted">+{rest}</span></>}
    </span>
  );
}

export function HoldsView({ data, tenantId, open }: { data: Holds; tenantId: string; open?: string }) {
  if (data.rows.length === 0) {
    return <Notice title="Nothing held or flagged">Every row was typed, every label was in the tenant&apos;s map, and every file matched a declared header set.</Notice>;
  }
  const key = (r: HoldRow) => `${r.kind}:${r.source}:${r.batch ?? ""}:${r.ref}:${r.reason}`;
  return (
    <>
      <SectionHead title="Held and flagged" meta={`${data.quarantined} quarantined · ${data.schemaEvents} schema events · ${data.conflicts} conflicts`} />
      <div className="mt-[18px]">
        <Tbl cols={[156, 132, 72, 190, 140, null, 72, 176]}>
          <Thead><Tr>
            <Th>Kind</Th><Th>Source</Th><Th align="center">Batch</Th><Th>Reason</Th><Th>Ref</Th><Th>Detail</Th><Th align="right">Run</Th><Th align="right">Seen at</Th>
          </Tr></Thead>
          <Tbody>
            {data.rows.map((r) => {
              const isOpen = open === key(r);
              const href = isOpen ? `/${tenantId}/holds` : `/${tenantId}/holds?open=${encodeURIComponent(key(r))}`;
              const bad = r.kind === "quarantine";
              return [
                <Tr key={key(r)} className={cn("hover:bg-row-hover", isOpen && "[&>td]:border-b-0")}>
                  <Td><StateWord state={r.kind} /></Td>
                  <Td mono className="text-[13.5px] text-ink">{r.source}</Td>
                  <Td mono align="center" muted>{r.batch ?? "—"}</Td>
                  <Td mono className={cn("text-[13.5px]", bad ? "text-st-bad" : "text-ink-2")}>{r.reason}</Td>
                  <Td mono className="text-[13.5px] text-ink-2">{r.ref ? <Link href={href} className="hover:underline">{r.ref}</Link> : "—"}</Td>
                  <Td><Link href={href} className="hover:underline"><DetailInline detail={r.detail} /></Link></Td>
                  <Td mono align="right" muted>{r.run_id === null ? "—" : <Num>#{r.run_id}</Num>}</Td>
                  <Td mono align="right" muted>{stamp(r.at)}</Td>
                </Tr>,
                isOpen && (
                  <BandRow key={`${key(r)}-open`} colSpan={8} className="bg-panel pb-6 pt-0 md:pl-[156px]">
                    <pre className="overflow-x-auto rounded-[8px] border border-hairline bg-code-bg px-6 py-4 font-mono text-[12.5px] leading-[1.6] text-ink-2">
                      {JSON.stringify(Object.fromEntries(orderedEntries(r.detail)), null, 2)}
                    </pre>
                  </BandRow>
                ),
              ];
            })}
          </Tbody>
        </Tbl>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3 text-[13.5px]">
        <StateWord state="quarantine" /><StateWord state="conflict" /><StateWord state="schema event" />
        <span className="ml-2 text-ink-muted">other reasons</span>
        <span className="inline-flex flex-wrap items-center gap-2">{OTHER_REASONS.map((x) => <SourceChip key={x}>{x}</SourceChip>)}</span>
      </div>
      <p className="mt-3 text-[13.5px] leading-[1.55] text-ink-muted">Detail is stored as JSON. The row shows the keys that identify the record; click a ref to open the full object in place.</p>
    </>
  );
}
