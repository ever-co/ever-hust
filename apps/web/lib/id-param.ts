/**
 * Largest value of a Postgres `integer` (int4). Every serial/identity id in packages/db is an
 * int4, so a larger id fails in Postgres ("out of range for type integer") instead of matching
 * nothing.
 */
export const INT4_MAX = 2_147_483_647;

/**
 * Parse a positive integer id from a route segment or a query parameter.
 *
 * Accepts only plain decimal digits without a leading zero (`/^[1-9]\d*$/`) up to INT4_MAX, and
 * returns null for anything else: `0`, `-1`, `1.5`, `1e3`, ` 5`, `05`, `0x10`, `2147483648`, an
 * empty string or a missing value. A route answers 400 for null before it reaches the database,
 * where such a value would fail with a 500.
 */
export function parsePositiveIntId(raw: string | null | undefined): number | null {
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) return null;
  // More than 10 digits is past INT4_MAX; checking the length first keeps Number() exact.
  if (raw.length > 10) return null;
  const id = Number(raw);
  return id <= INT4_MAX ? id : null;
}
