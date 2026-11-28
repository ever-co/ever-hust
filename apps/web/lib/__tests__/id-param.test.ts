/**
 * Every serial/identity id in packages/db is a Postgres `integer` (int4). A route that handed
 * Postgres 3000000000 got "out of range for type integer", and 1.5 got "invalid input syntax";
 * both were logged as errors and answered 500. parsePositiveIntId lets a route answer 400 first.
 */
import { INT4_MAX, parsePositiveIntId } from "../id-param";

describe("INT4_MAX", () => {
  it("is the largest Postgres integer", () => {
    expect(INT4_MAX).toBe(2_147_483_647);
  });
});

describe("parsePositiveIntId", () => {
  it.each([
    ["1", 1],
    ["42", 42],
    ["2147483647", 2_147_483_647],
  ])("accepts %j", (raw, expected) => {
    expect(parsePositiveIntId(raw)).toBe(expected);
  });

  it.each([
    "0",
    "-1",
    "1.5",
    "1.0",
    "1e3",
    " 5",
    "5 ",
    "+5",
    "05",
    "0x10",
    "1_000",
    "2147483648",
    "3000000000",
    "99999999999999999999",
    "Infinity",
    "NaN",
    "abc",
    "",
  ])("rejects %j", (raw) => {
    expect(parsePositiveIntId(raw)).toBeNull();
  });

  it("rejects a missing value", () => {
    expect(parsePositiveIntId(null)).toBeNull();
    expect(parsePositiveIntId(undefined)).toBeNull();
  });
});
