/** Number formatting rules from the handoff: tabular, two decimals, negatives in parentheses, never a minus sign. */

const two = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** 1247.12 → "1,247.12"; -95.1 → "(95.10)". */
export function money(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  return n < 0 ? `(${two.format(-n)})` : two.format(n);
}

/** Whether a restated metric is money (two decimals) or a count (none). Decided by the metric, never by the value. */
export function isMoneyMetric(mart: string, metricName: string): boolean {
  return mart === "daily_revenue" && metricName !== "orders";
}

/** A change: +158.01 or (158.01); counts keep no decimals. */
export function delta(v: string | number, moneyValue: boolean): string {
  const n = Number(v);
  const f = moneyValue ? two : whole;
  return n < 0 ? `(${f.format(-n)})` : `+${f.format(n)}`;
}

/** A restated value: money or count, negatives in parentheses. */
export function metric(v: string | number | null | undefined, moneyValue: boolean): string {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  const f = moneyValue ? two : whole;
  return n < 0 ? `(${f.format(-n)})` : f.format(n);
}

export function count(v: number | string): string {
  return whole.format(Number(v));
}

export const CURRENCY_SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", CAD: "C$" };

export function symbol(currency: string): string {
  return CURRENCY_SYMBOL[currency] ?? currency;
}

/** "2026-09-21 14:32:50" from a timestamp text, or "" */
export function stamp(ts: string | null | undefined): string {
  return ts ? ts.slice(0, 19).replace("T", " ") : "";
}

/** "late or changed records in: ad_spend, refunds" → ["ad_spend", "refunds"] */
export function sourcesFromCause(cause: string): string[] {
  const i = cause.indexOf(":");
  return i < 0 ? [] : cause.slice(i + 1).split(",").map((s) => s.trim()).filter(Boolean);
}
