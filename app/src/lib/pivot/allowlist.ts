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
  /** The DuckDB type of the underlying fact column, introspected by
   * sql/02_marts/300_meta_pivot_dimensions.sql -- 'VARCHAR' | 'TINYINT' | 'SMALLINT' |
   * 'INTEGER' | 'BIGINT'. Read, never inferred from the key: aircraft_type is VARCHAR
   * carrying zero-padded codes ('079'), so a numeric rule guessed from the name would
   * corrupt it. Typed as `string` rather than a union because the catalog is the authority
   * and a new column type must not become a compile error in the port. */
  valueType: string;
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
