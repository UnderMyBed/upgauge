export interface DimensionEntry {
  key: string;
  label: string;
  columnExpr: string;
  grain: string;
  joinDim: string | null;
  joinKey: string | null;
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
