import type { PivotQuery } from "@/lib/pivot/types";

/** docs/data/carrier-model.md caveat 3: a mainline group's composition changes over time, and
 * each change is an ownership or contract event, not organic growth. The steps come from
 * sql/03_queries/mainline_steps.sql (derived from map_mainline_group, never a hand-kept list),
 * already filtered to the ones the query's window crosses; this module only decides which ROWS
 * of a pivot result each step belongs to. */
export type StepKind = "joins" | "leaves" | "rolls_up" | "rolls_out";

export interface MainlineStep {
  /** The series that steps -- the op_airline_id a `g=ml` row carries. */
  subjectAirlineId: number;
  /** First month the new composition takes effect, `YYYY-MM`. */
  month: string;
  otherAirlineId: number;
  otherCode: string | null;
  kind: StepKind;
}

/** TWO operands. Without the carrier dimension a mainline result equals the operating one, and
 * without mainline grouping nothing rolls up -- either alone marks rows where nothing stepped. */
export function stepsApply(q: PivotQuery): boolean {
  return q.grouping === "mainline" && q.dimensions.includes("op_airline_id");
}

/** The step's month lies in the row's time bucket: every time dimension the query carries must
 * agree, and with none the bucket is the whole window. `quarter` is quarter-of-year (1-4). */
function inBucket(q: PivotQuery, row: Record<string, unknown>, month: string): boolean {
  const year = Number(month.slice(0, 4));
  const quarter = Math.ceil(Number(month.slice(5, 7)) / 3);
  if (q.dimensions.includes("year_month") && row.year_month !== month) return false;
  if (q.dimensions.includes("year") && Number(row.year) !== year) return false;
  if (q.dimensions.includes("quarter") && Number(row.quarter) !== quarter) return false;
  return true;
}

export function rowSteps(
  q: PivotQuery,
  row: Record<string, unknown>,
  steps: readonly MainlineStep[],
): MainlineStep[] {
  if (!stepsApply(q)) return [];
  const id = Number(row.op_airline_id);
  return steps.filter((s) => s.subjectAirlineId === id && inBucket(q, row, s.month));
}

export function stepPhrase(step: MainlineStep): string {
  // Absence is not a value: an unresolved code shows the id, never a dash.
  const other = step.otherCode ?? String(step.otherAirlineId);
  switch (step.kind) {
    case "joins":
      return `${other} joins ${step.month}`;
    case "leaves":
      return `${other} leaves ${step.month}`;
    case "rolls_up":
      return `counted under ${other} from ${step.month}`;
    case "rolls_out":
      return `counted as itself from ${step.month}`;
  }
}

export function rowNote(
  q: PivotQuery,
  row: Record<string, unknown>,
  steps: readonly MainlineStep[],
): string | null {
  const matched = rowSteps(q, row, steps);
  return matched.length === 0
    ? null
    : `Group composition changes: ${matched.map(stepPhrase).join("; ")}`;
}

/** The foot's list: every crossed step whose subject appears among the result's rows, in the
 * query file's order. Bucket-free on purpose -- a view with no time dimension, or rows that do
 * not show the bucket, still has to say what moved inside its window. */
export function stepsBySubject(
  q: PivotQuery,
  rows: readonly Record<string, unknown>[],
  steps: readonly MainlineStep[],
): { subjectAirlineId: number; phrases: string[] }[] {
  if (!stepsApply(q)) return [];
  const present = new Set(rows.map((r) => Number(r.op_airline_id)));
  const out: { subjectAirlineId: number; phrases: string[] }[] = [];
  for (const s of steps) {
    if (!present.has(s.subjectAirlineId)) continue;
    const last = out[out.length - 1];
    if (last && last.subjectAirlineId === s.subjectAirlineId) last.phrases.push(stepPhrase(s));
    else out.push({ subjectAirlineId: s.subjectAirlineId, phrases: [stepPhrase(s)] });
  }
  return out;
}
