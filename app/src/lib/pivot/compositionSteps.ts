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

/** Under `g=ml` an `op_airline_id` filter targets the RAW fact column, not the rolled-up one
 * (render.ts filters `op_airline_id IN (...)` on the fact; sql/03_queries/pivot_mainline_join.sql
 * "KNOWN SEMANTIC GAP"). So `f=op_airline_id:19930` keeps AS-operated metal only, and its
 * 2016-12 row holds no VX seats. Rule: under such a filter a `joins`/`leaves` step is kept only
 * when its other airline passes the filter too -- otherwise the row never held the metal the
 * step names. `rolls_up`/`rolls_out` are already constrained: the subject's own row exists only
 * when the subject passes. Repeated `op_airline_id` filters AND together in render.ts, so the
 * admitted set is their intersection. No filter, no constraint. */
function admittedByFilter(q: PivotQuery): (s: MainlineStep) => boolean {
  const lists = q.filters.filter(([key]) => key === "op_airline_id").map(([, values]) => values);
  if (lists.length === 0) return () => true;
  const admits = (id: string) => lists.every((values) => values.includes(id));
  return (s) => (s.kind !== "joins" && s.kind !== "leaves") || admits(String(s.otherAirlineId));
}

export function rowSteps(
  q: PivotQuery,
  row: Record<string, unknown>,
  steps: readonly MainlineStep[],
): MainlineStep[] {
  if (!stepsApply(q)) return [];
  const id = Number(row.op_airline_id);
  const admitted = admittedByFilter(q);
  return steps.filter(
    (s) => s.subjectAirlineId === id && inBucket(q, row, s.month) && admitted(s),
  );
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

/** The foot's list: every crossed step whose subject appears among the result's rows and that
 * the `op_airline_id` filter admits, in the query file's order. Bucket-free on purpose -- a view
 * with no time dimension, or rows that do not show the bucket, still has to say what moved
 * inside its window. Steps arrive ordered by subject (mainline_steps.sql's ORDER BY), so a
 * subject's steps are contiguous and the merge below is adjacency-based. */
export function stepsBySubject(
  q: PivotQuery,
  rows: readonly Record<string, unknown>[],
  steps: readonly MainlineStep[],
): { subjectAirlineId: number; phrases: string[] }[] {
  if (!stepsApply(q)) return [];
  const present = new Set(rows.map((r) => Number(r.op_airline_id)));
  const admitted = admittedByFilter(q);
  const out: { subjectAirlineId: number; phrases: string[] }[] = [];
  for (const s of steps) {
    if (!present.has(s.subjectAirlineId) || !admitted(s)) continue;
    const last = out[out.length - 1];
    if (last && last.subjectAirlineId === s.subjectAirlineId) last.phrases.push(stepPhrase(s));
    else out.push({ subjectAirlineId: s.subjectAirlineId, phrases: [stepPhrase(s)] });
  }
  return out;
}
