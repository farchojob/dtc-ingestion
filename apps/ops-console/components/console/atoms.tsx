/** The small vocabulary every screen shares: eyebrows, state words, chips, numbers, the alias mark. Server-only, no JS. */
import { Badge } from "@/components/ui/badge";
import { cn } from "cn";

export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("eyebrow", className)}>{children}</span>;
}

/** Colour by state (handoff §3). Neutral is the resting state; only three states carry a colour, always with the word. */
export type Tone = "neutral" | "ok" | "bad" | "warn";

export function toneOf(state: string): Tone {
  if (["succeeded", "yes", "complete"].includes(state)) return "ok";
  if (["missing", "failed", "quarantined", "no", "quarantine"].includes(state)) return "bad";
  if (["loading", "conflict", "running"].includes(state)) return "warn";
  return "neutral";
}

const TONE_TEXT: Record<Tone, string> = { neutral: "text-ink-2", ok: "text-st-ok font-medium", bad: "text-st-bad font-medium", warn: "text-st-warn font-medium" };
const TONE_DOT: Record<Tone, string> = { neutral: "bg-fill", ok: "bg-st-ok", bad: "bg-st-bad", warn: "bg-st-warn" };

export function StateWord({ state, tone, className, size = 13.5 }: { state: string; tone?: Tone; className?: string; size?: number }) {
  const t = tone ?? toneOf(state);
  return (
    <span className={cn("inline-flex items-center gap-2 whitespace-nowrap", TONE_TEXT[t], className)} style={{ fontSize: size }}>
      <span className={cn("dot", TONE_DOT[t])} />
      {state}
    </span>
  );
}

export function Dot({ tone = "neutral", className }: { tone?: Tone; className?: string }) {
  return <span className={cn("dot", TONE_DOT[tone], className)} />;
}

/** Outline is the only badge variant on the console: mono, uppercase, radius 4. */
export function Chip({ children, className, upper = true }: { children: React.ReactNode; className?: string; upper?: boolean }) {
  return (
    <Badge variant="outline" className={cn("h-auto rounded-[4px] border-hairline-2 px-[7px] py-[3px] font-mono text-[11.5px] font-normal tracking-[0.06em] text-ink-muted", upper && "uppercase", className)}>
      {children}
    </Badge>
  );
}

/** A source or reason chip inside a table: mono 12, ink-2, padding 2/7. */
export function SourceChip({ children }: { children: React.ReactNode }) {
  return <span className="whitespace-nowrap rounded-[4px] border border-hairline-2 px-[7px] py-[2px] font-mono text-[12px] text-ink-2">{children}</span>;
}

export function AliasMark({ className }: { className?: string }) {
  return <span className={cn("alias-mark", className)} role="img" aria-label="schema alias used" title="schema alias used" />;
}

/** A number in prose or a cell: mono and tabular. */
export function Num({ children, className, mono = true }: { children: React.ReactNode; className?: string; mono?: boolean }) {
  return <span className={cn("num", mono && "font-mono", className)}>{children}</span>;
}

export function Caret({ up }: { up: boolean }) {
  return <span aria-hidden="true" className={cn("caret", up ? "caret-up" : "caret-down")} />;
}

export function LastRunLine({ run, size = 13.5 }: { run: { id: number; status: string } | null; size?: number }) {
  if (!run) return <span className="text-ink-muted" style={{ fontSize: size }}>no runs yet</span>;
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-ink-muted" style={{ fontSize: size }}>
      <Dot tone={toneOf(run.status)} />
      <span>last run <Num>#{run.id}</Num> {run.status}</span>
    </span>
  );
}
