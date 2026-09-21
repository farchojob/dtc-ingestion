/**
 * The console's table: shadcn primitives with the handoff's measurements applied once here,
 * so views only say what goes in each cell. table-layout is fixed with an explicit <colgroup>,
 * which is what lets every cell be nowrap without a column drifting.
 */
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "cn";

export type Align = "left" | "right" | "center";
const ALIGN: Record<Align, string> = { left: "text-left", right: "text-right", center: "text-center" };

export function Tbl({ cols, children, className }: { cols: (number | null)[]; children: React.ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <Table className={cn("min-w-[960px] table-fixed border-separate border-spacing-0 overflow-hidden rounded-[10px] border border-hairline bg-panel text-[13.5px]", className)}>
        <colgroup>
          {cols.map((w, i) => <col key={i} style={w === null ? undefined : { width: w }} />)}
        </colgroup>
        {children}
      </Table>
    </div>
  );
}

export { TableBody as Tbody, TableHeader as Thead, TableFooter as Tfoot, TableRow as Tr };

export function Th({ children, align = "left", className, colSpan, scope = "col" }: { children?: React.ReactNode; align?: Align; className?: string; colSpan?: number; scope?: "col" | "colgroup" }) {
  return (
    <TableHead scope={scope} colSpan={colSpan}
      className={cn("h-auto whitespace-nowrap border-b border-hairline-2 px-[18px] py-[11px] align-middle eyebrow font-normal", ALIGN[align], className)}>
      {children}
    </TableHead>
  );
}

export function Td({ children, align = "left", mono, muted, strong, className, colSpan, wrap }: {
  children?: React.ReactNode; align?: Align; mono?: boolean; muted?: boolean; strong?: boolean; className?: string; colSpan?: number; wrap?: boolean;
}) {
  return (
    <TableCell colSpan={colSpan}
      className={cn("border-b border-hairline px-[18px] py-[14px] align-middle leading-[1.45] text-ink-2", !wrap && "whitespace-nowrap",
        mono && "num font-mono text-[13px]", muted && "text-ink-muted", strong && "font-medium text-ink", ALIGN[align], className)}>
      {children}
    </TableCell>
  );
}

/** A full-width band inside the body: day group headers, expanded detail rows. */
export function BandRow({ children, colSpan, className }: { children: React.ReactNode; colSpan: number; className?: string }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className={cn("border-b border-hairline bg-row-hover px-[18px] py-[12px] align-middle", className)}>{children}</TableCell>
    </TableRow>
  );
}

export function SectionHead({ title, meta, className }: { title: React.ReactNode; meta?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-6", className)}>
      <h2 className="whitespace-nowrap text-[14.5px] font-medium tracking-[-0.005em] text-ink">{title}</h2>
      {meta && <span className="eyebrow">{meta}</span>}
    </div>
  );
}
