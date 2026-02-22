import { getRegex } from "./regexCache";

describe("getRegex", () => {
  // Case 1: valid pattern returns a RegExp instance
  it("should return a RegExp for a valid pattern", () => {
    const result = getRegex("hello");
    expect(result).toBeInstanceOf(RegExp);
    expect(result!.source).toBe("hello");
    expect(result!.flags).toBe("i");
  });

  // Case 2: calling with the same pattern returns the cached instance (same reference)
  it("should return the same cached instance for a repeated pattern", () => {
    const first = getRegex("cached-pattern");
    const second = getRegex("cached-pattern");
    expect(first).toBe(second);
  });

  // Case 3: invalid pattern returns null
  it("should return null for an invalid regex pattern", () => {
    const result = getRegex("[invalid");
    expect(result).toBeNull();
  });

  // Case 4: empty string is a valid regex that matches everything
  it("should return a valid RegExp for an empty string pattern", () => {
    const result = getRegex("");
    expect(result).toBeInstanceOf(RegExp);
    expect(result!.test("anything")).toBe(true);
    expect(result!.test("")).toBe(true);
  });

  // Case 5: pattern with embedded flag syntax works correctly
  it("should handle a pattern with embedded flag syntax", () => {
    const result = getRegex("(?:foo|bar)");
    expect(result).toBeInstanceOf(RegExp);
    expect(result!.test("foo")).toBe(true);
    expect(result!.test("BAR")).toBe(true);
    expect(result!.test("baz")).toBe(false);
  });
});
