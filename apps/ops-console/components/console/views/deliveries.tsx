import type { MatrixRow, DeliveryRow } from "@/lib/queries";
import { count, stamp } from "@/lib/format";
import { cn } from "cn";
import { AliasMark, Dot, Eyebrow, StateWord, toneOf } from "../atoms";
import { SectionHead, Tbl, Tbody, Td, Th, Thead, Tr } from "../table";

export function DeliveriesView({ matrix, rows, rowsLoaded }: { matrix: MatrixRow[]; rows: DeliveryRow[]; rowsLoaded: number }) {
  const batches = [...new Set(matrix.flatMap((r) => r.cells.map((c) => c.batch)))].sort((a, b) => a - b);
  const promised = rows.filter((r) => r.expected).length;
  const unpromised = rows.length - promised;
  return (
    <>
      <SectionHead title={promised ? "Manifest" : "Files"}
        meta={promised ? `${matrix.length} sources × ${batches.length} batches${unpromised ? ` · ${unpromised} not in the manifest` : ""}` : `${matrix.length} sources × ${batches.length} batches · no manifest`} />
      <div className="mt-5 overflow-x-auto">
        <div className="grid items-center gap-3" style={{ minWidth: `${180 + batches.length * 140}px`, gridTemplateColumns: `180px repeat(${batches.length}, minmax(0, 1fr))` }}>
          <div />
          {batches.map((b) => <div key={b} className="pb-1"><Eyebrow>batch {b}</Eyebrow></div>)}
          {matrix.map((row) => (
            <MatrixLine key={row.source} row={row} batches={batches} />
          ))}
        </div>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-x-8 gap-y-2 text-[13.5px]">
        <StateWord state="loaded" /><StateWord state="missing" /><StateWord state="quarantined" /><StateWord state="loading" />
        <span className="inline-flex items-center gap-[10px] text-ink-2"><AliasMark />schema alias used</span>
      </div>

      <SectionHead className="mt-12" title="Batches" meta={`${rows.length} rows · ${count(rowsLoaded)} loaded`} />
      <div className="mt-[18px]">
        <Tbl cols={[180, 76, 212, 176, 104, 196, 112, null]}>
          <Thead><Tr>
            <Th>Source</Th><Th align="center">Batch</Th><Th>Covers</Th><Th>Status</Th><Th align="right">Rows</Th><Th>Schema</Th><Th align="right">Attempts</Th><Th align="right">Loaded at</Th>
          </Tr></Thead>
          <Tbody>
            {rows.map((r) => {
              const missing = r.status === "missing";
              return (
                <Tr key={`${r.source}-${r.batch}`} className="hover:bg-row-hover">
                  <Td mono className="text-[13.5px] text-ink">{r.source}</Td>
                  <Td mono align="center" muted>{r.batch}</Td>
                  <Td mono className={cn(missing ? "text-st-bad" : r.expected ? "text-ink-2" : "text-ink-muted")}>
                    {r.expected && r.covers_from && r.covers_to ? `${r.covers_from} → ${r.covers_to.slice(5)}` : "not in the manifest"}
                  </Td>
                  <Td><StateWord state={r.status} /></Td>
                  <Td mono align="right" className={cn(missing ? "text-ink-muted" : "text-ink")}>{r.rows_seen === null ? "—" : count(r.rows_seen)}</Td>
                  <Td>
                    {r.schema_version && (
                      <span className="inline-flex items-center gap-[9px] font-mono text-[13px] text-ink-2">
                        {r.schema_version}{r.schema_version !== "v1" && <AliasMark />}
                      </span>
                    )}
                  </Td>
                  <Td mono align="right" muted>{r.attempts ?? 0}</Td>
                  <Td mono align="right" muted>{r.loaded_at ? stamp(r.loaded_at) : "—"}</Td>
                </Tr>
              );
            })}
          </Tbody>
        </Tbl>
      </div>
    </>
  );
}

function MatrixLine({ row, batches }: { row: MatrixRow; batches: number[] }) {
  return (
    <>
      <div className="flex items-center whitespace-nowrap font-mono text-[13.5px] text-ink">{row.source}</div>
      {batches.map((b) => {
        const c = row.cells.find((x) => x.batch === b);
        if (!c) return <div key={b} className="h-[88px] rounded-[8px] border border-dashed border-hairline" />;
        const tone = toneOf(c.status);
        const bad = tone === "bad";
        return (
          <div key={c.batch} className={cn("box-border flex h-[88px] flex-col justify-between overflow-hidden rounded-[8px] border bg-panel px-4 py-[14px]",
            bad ? "border-st-bad" : tone === "warn" ? "border-st-warn" : "border-hairline")}>
            <span className="flex items-center justify-between gap-2">
              <span className={cn("inline-flex items-center gap-2 whitespace-nowrap text-[13.5px]", bad ? "font-medium text-st-bad" : tone === "warn" ? "font-medium text-st-warn" : "text-ink-2")}>
                <Dot tone={tone} />{c.status}
              </span>
              {c.alias && <AliasMark />}
            </span>
            <span className={cn("num whitespace-nowrap font-mono text-[12px]", bad ? "text-st-bad" : "text-ink-muted")}>
              {c.status === "missing" ? "never arrived" : c.status === "loaded" ? `${count(c.rows ?? 0)} rows${c.expected ? "" : " · unannounced"}` : c.status}
            </span>
          </div>
        );
      })}
    </>
  );
}
