import { escapeRegex, getRegex } from "../services/regexCache";

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

  // Case 3: invalid pattern auto-escapes for literal matching
  it("should auto-escape invalid regex and return a RegExp", () => {
    const result = getRegex("[invalid");
    expect(result).toBeInstanceOf(RegExp);
    expect(result!.test("[invalid")).toBe(true);
    expect(result!.test("valid")).toBe(false);
  });

  // Case 3b: invalid regex like C++ auto-escapes
  it("should auto-escape C++ and return a RegExp for literal matching", () => {
    const result = getRegex("C++");
    expect(result).toBeInstanceOf(RegExp);
    expect(result!.test("C++")).toBe(true);
    expect(result!.test("C")).toBe(false);
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

describe("escapeRegex", () => {
  it("should escape all special regex characters", () => {
    expect(escapeRegex("C++")).toBe("C\\+\\+");
    expect(escapeRegex("a.b")).toBe("a\\.b");
    expect(escapeRegex("foo*bar")).toBe("foo\\*bar");
    expect(escapeRegex("(test)")).toBe("\\(test\\)");
    expect(escapeRegex("[abc]")).toBe("\\[abc\\]");
    expect(escapeRegex("a{1,2}")).toBe("a\\{1,2\\}");
    expect(escapeRegex("a|b")).toBe("a\\|b");
    expect(escapeRegex("a\\b")).toBe("a\\\\b");
    expect(escapeRegex("^start$")).toBe("\\^start\\$");
    expect(escapeRegex("what?")).toBe("what\\?");
  });

  it("should return plain text unchanged", () => {
    expect(escapeRegex("hello")).toBe("hello");
    expect(escapeRegex("問卦")).toBe("問卦");
  });
});
