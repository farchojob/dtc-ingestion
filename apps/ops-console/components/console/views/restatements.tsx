import type { Restatements, RestatementRow } from "@/lib/queries";
import { delta, isMoneyMetric, metric } from "@/lib/format";
import { cn } from "cn";
import { Caret, Num, SourceChip } from "../atoms";
import { Notice } from "../chrome";
import { BandRow, SectionHead, Tbl, Tbody, Td, Th, Thead, Tr } from "../table";

/** previous → current as one object: previous muted, the arrow at hairline strength, current in ink. */
function Pair({ r }: { r: RestatementRow }) {
  const m = isMoneyMetric(r.mart, r.metric);
  return (
    <span className="num inline-flex w-full items-baseline justify-end gap-[14px] whitespace-nowrap font-mono text-[14px]">
      <span className="text-ink-muted">{metric(r.previous, m)}</span>
      <span aria-hidden="true" className="text-hairline-2">→</span>
      <span className="font-medium text-ink">{metric(r.current, m)}</span>
    </span>
  );
}

function Change({ r }: { r: RestatementRow }) {
  const d = Number(r.current) - Number(r.previous);
  return (
    <span className="num inline-flex items-center whitespace-nowrap font-mono text-[13.5px] text-ink-2">
      <Caret up={d >= 0} />{delta(d, isMoneyMetric(r.mart, r.metric))}
    </span>
  );
}

function DayHeader({ d }: { d: Restatements["days"][number] }) {
  return (
    <span className="flex flex-wrap items-center gap-4">
      <Num className="text-[14px] text-ink">{d.day}</Num>
      <span className="whitespace-nowrap text-[13px] text-ink-muted">
        {d.rows.length} change{d.rows.length > 1 ? "s" : ""} · run {d.runs.map((r, i) => <span key={r}>{i > 0 && ", "}<Num>#{r}</Num></span>)} · late or changed records in
      </span>
      <span className="inline-flex flex-wrap items-center gap-2">{d.sources.map((s) => <SourceChip key={s}>{s}</SourceChip>)}</span>
    </span>
  );
}

export function RestatementsView({ data, tenant }: { data: Restatements; tenant: { id: string; display_name: string } }) {
  if (data.total === 0) {
    return (
      <Notice title={`No restatements for ${tenant.display_name}`}
        commands={[`npm run ingest -- --tenant ${tenant.id} --batches 1-4`, `npm run ingest -- --tenant ${tenant.id}`]}>
        A restatement is written when a number that was already reported changes. Replay the deliveries in order, then run in full, and the ones the late records cause will appear here.
      </Notice>
    );
  }
  return (
    <>
      <SectionHead title="Grouped by day, newest first" meta={`${data.total} changes · ${data.days.length} days · ${data.marts} mart${data.marts > 1 ? "s" : ""}`} />

      {/* laptop and up: the table */}
      <div className="mt-[18px] hidden md:block">
        <Tbl cols={[190, 220, 180, 420, null]}>
          <Thead><Tr><Th>Mart</Th><Th>Dimension</Th><Th>Metric</Th><Th align="right">Previous → current</Th><Th align="right">Change</Th></Tr></Thead>
          <Tbody>
            {data.days.map((d) => [
              <BandRow key={d.day} colSpan={5} className="border-t border-hairline"><DayHeader d={d} /></BandRow>,
              ...d.rows.map((r) => (
                <Tr key={r.id} className="hover:bg-row-hover">
                  <Td mono muted>{r.mart}</Td>
                  <Td mono className="text-[13.5px] text-ink">{r.dimension}</Td>
                  <Td mono className="text-[13.5px]">{r.metric}</Td>
                  <Td align="right"><Pair r={r} /></Td>
                  <Td align="right"><Change r={r} /></Td>
                </Tr>
              )),
            ])}
          </Tbody>
        </Tbl>
      </div>

      {/* phone: two-line blocks, no horizontal scroll */}
      <div className="mt-[18px] space-y-3 md:hidden">
        {data.days.map((d) => (
          <div key={d.day} className="overflow-hidden rounded-[10px] border border-hairline bg-panel">
            <div className="border-b border-hairline bg-row-hover px-4 py-3"><DayHeader d={d} /></div>
            {d.rows.map((r) => (
              <div key={r.id} className="border-b border-hairline px-4 py-3 last:border-b-0">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-mono text-[13.5px] text-ink">{r.dimension} <span className="text-ink-2">· {r.metric}</span></span>
                  <Change r={r} />
                </div>
                <div className="mt-1 flex items-baseline justify-between gap-3">
                  <span className="font-mono text-[12px] text-ink-muted">{r.mart}</span>
                  <Pair r={r} />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      <p className={cn("mt-5 text-[13.5px] text-ink-muted")}>Direction is carried by the sign and the caret, not by colour: parentheses mean the metric fell.</p>
    </>
  );
}
