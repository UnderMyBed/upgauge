/** Null is absence, zero is a measurement. Never render one as the other. */
const DASH = "—";

export function formatSeats(v: number | null): string {
  return v === null ? DASH : v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function formatCount(v: number | null): string {
  return v === null ? DASH : v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function formatLoadFactor(v: number | null): string {
  return v === null ? DASH : `${(v * 100).toFixed(2)}%`;
}

export function formatGauge(v: number | null): string {
  return v === null ? DASH : v.toFixed(1);
}
