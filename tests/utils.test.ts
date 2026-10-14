import { describe, expect, test } from "bun:test";
import { atoiOrDefault, parseFloatOrDefault } from "../src/utils";

describe("atoiOrDefault", () => {
  test("parses integers", () => {
    expect(atoiOrDefault("30")).toBe(30);
    expect(atoiOrDefault("-1")).toBe(-1);
  });
  test("falls back on bad input", () => {
    expect(atoiOrDefault("")).toBe(0);
    expect(atoiOrDefault("abc", 15)).toBe(15);
    expect(atoiOrDefault(undefined, 7)).toBe(7);
  });
});

describe("parseFloatOrDefault", () => {
  test("parses floats", () => {
    expect(parseFloatOrDefault("1.25")).toBe(1.25);
  });
  test("falls back on bad input", () => {
    expect(parseFloatOrDefault("")).toBe(0);
    expect(parseFloatOrDefault("Infinity", 3)).toBe(3);
  });
});
