export interface DimensionEntry {
  key: string;
  label: string;
  columnExpr: string;
  grain: string;
  joinDim: string | null;
  joinKey: string | null;
  /** Accepted in a filter, rejected as a grouping dimension. See
   * sql/02_marts/300_meta_pivot_dimensions.sql for why exactly one row sets this. */
  filterOnly: boolean;
  /** null = single column `IN`; "pair" = route's least()/greatest(); "either" = OR. */
  filterMode: "pair" | "either" | null;
}

export interface MeasureEntry {
  key: string;
  label: string;
  isAdditive: boolean;
  expr: string;
}

export interface Allowlist {
  dims: Map<string, DimensionEntry>;
  meas: Map<string, MeasureEntry>;
}
