import type { MixRow } from "@/lib/chart/aircraftMix";
import { mixChartDraws, plural } from "@/lib/chart/mixPlotConfig";
import { formatSeats } from "@/lib/format";

/** docs/design/system.md § Seasonality heatmap. A month's seats are the sum of its STATEABLE
 * bands -- exactly what the aircraft-mix chart above stacks, so the two cannot disagree. A NULL
 * band is a wholly quarantined filing (#121), never 0. */
export type CellKind = "value" | "understated" | "unknown" | "unfiled" | "outside";
export interface HeatCell {
  month: string;
  kind: CellKind;
  seats: number | null;
  bin: 1 | 2 | 3 | 4 | 5 | null;
}
export interface HeatGrid {
  years: { year: number; cells: HeatCell[] }[];
  first: string;
  last: string;
  min: number;
  max: number;
  highest: { month: string; seats: number };
  lowest: { month: string; seats: number };
  counts: { unfiled: number; unknown: number; understated: number };
}

export function binOf(v: number, min: number, max: number): 1 | 2 | 3 | 4 | 5 {
  if (min === max) return 5;
  return Math.min(5, 1 + Math.floor(((v - min) / (max - min)) * 5)) as 1 | 2 | 3 | 4 | 5;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function heatmapGrid(rows: readonly MixRow[]): HeatGrid | null {
  if (!mixChartDraws([...rows])) return null;
  const byMonth = new Map<string, { sum: number; stateable: number; nulls: number }>();
  for (const r of rows) {
    const m = byMonth.get(r.month) ?? { sum: 0, stateable: 0, nulls: 0 };
    if (r.seats === null) m.nulls += 1;
    else {
      m.sum += r.seats;
      m.stateable += 1;
    }
    byMonth.set(r.month, m);
  }
  const filed = [...byMonth.keys()].sort();
  const first = filed[0];
  const last = filed[filed.length - 1];
  const counts = { unfiled: 0, unknown: 0, understated: 0 };
  const stated: { month: string; seats: number }[] = [];
  const years: HeatGrid["years"] = [];
  for (let y = Number(first.slice(0, 4)); y <= Number(last.slice(0, 4)); y++) {
    const cells: HeatCell[] = [];
    for (let mo = 1; mo <= 12; mo++) {
      const month = `${y}-${pad(mo)}`;
      const m = byMonth.get(month);
      let cell: HeatCell;
      if (month < first || month > last) cell = { month, kind: "outside", seats: null, bin: null };
      else if (!m) {
        counts.unfiled += 1;
        cell = { month, kind: "unfiled", seats: null, bin: null };
      } else if (m.stateable === 0) {
        counts.unknown += 1;
        cell = { month, kind: "unknown", seats: null, bin: null };
      } else {
        const kind = m.nulls > 0 ? "understated" : "value";
        if (kind === "understated") counts.understated += 1;
        stated.push({ month, seats: m.sum });
        cell = { month, kind, seats: m.sum, bin: null };
      }
      cells.push(cell);
    }
    years.push({ year: y, cells });
  }
  const min = Math.min(...stated.map((s) => s.seats));
  const max = Math.max(...stated.map((s) => s.seats));
  for (const { cells } of years)
    for (const c of cells) if (c.seats !== null) c.bin = binOf(c.seats, min, max);
  // First month wins a tie, so the label is stable.
  const highest = stated.reduce((a, b) => (b.seats > a.seats ? b : a));
  const lowest = stated.reduce((a, b) => (b.seats < a.seats ? b : a));
  return { years, first, last, min, max, highest, lowest, counts };
}

export function heatmapKeyNotes(g: HeatGrid): string[] {
  const notes: string[] = [];
  if (g.counts.unfiled)
    notes.push(`${plural(g.counts.unfiled, "month")} with no filings, left unfilled.`);
  if (g.counts.unknown)
    notes.push(
      `${plural(g.counts.unknown, "month")} filed but wholly quarantined — every filing failed an ` +
        `invariant, so the month cannot be stated.`,
    );
  if (g.counts.understated)
    notes.push(
      `${plural(g.counts.understated, "month")} understated — a quarantined filing is left out ` +
        `of that month's total, which is lower than the real one by an amount that cannot be ` +
        `stated.`,
    );
  return notes;
}

export function heatmapLabel(g: HeatGrid): string {
  const parts = [
    `Seats by month, ${g.first} to ${g.last}.`,
    `Highest ${g.highest.month} ${formatSeats(g.highest.seats)} seats, lowest ${g.lowest.month} ` +
      `${formatSeats(g.lowest.seats)} seats.`,
  ];
  if (g.counts.unfiled) parts.push(`${plural(g.counts.unfiled, "month")} with no filings.`);
  if (g.counts.unknown)
    parts.push(`${plural(g.counts.unknown, "month")} filed but wholly quarantined.`);
  if (g.counts.understated) parts.push(`${plural(g.counts.understated, "month")} understated.`);
  return parts.join(" ");
}
