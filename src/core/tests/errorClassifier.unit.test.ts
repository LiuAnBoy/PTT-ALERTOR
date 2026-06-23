import { classifyError } from "../errorClassifier";

describe("classifyError", () => {
  // ── PARSE (explicit marker, highest precedence) ──────────────────────────
  describe("PARSE", () => {
    it("classifies an explicit parse marker as PARSE", () => {
      expect(classifyError({ kind: "parse", parseError: "Cannot read property" })).toBe("PARSE");
    });

    it("prefers PARSE over httpStatus when kind is parse", () => {
      expect(classifyError({ kind: "parse", httpStatus: 502 })).toBe("PARSE");
    });
  });

  // ── HTTP status ──────────────────────────────────────────────────────────
  describe("HTTP status", () => {
    it("classifies 5xx as HTTP_5XX", () => {
      expect(classifyError({ httpStatus: 502 })).toBe("HTTP_5XX");
    });

    it("classifies 4xx as HTTP_4XX", () => {
      expect(classifyError({ httpStatus: 403 })).toBe("HTTP_4XX");
    });

    it.each([
      [399, "OTHER"],
      [400, "HTTP_4XX"],
      [499, "HTTP_4XX"],
      [500, "HTTP_5XX"],
      [599, "HTTP_5XX"],
      [600, "OTHER"],
    ])("classifies boundary status %i as %s", (status, expected) => {
      expect(classifyError({ httpStatus: status })).toBe(expected);
    });

    it("ignores non-number httpStatus (string)", () => {
      expect(classifyError({ httpStatus: "502" })).toBe("OTHER");
    });

    it("ignores NaN httpStatus", () => {
      expect(classifyError({ httpStatus: NaN })).toBe("OTHER");
    });

    it("falls through to TIMEOUT when status missing but message is a timeout", () => {
      expect(classifyError({ httpStatus: undefined, errorMsg: "ETIMEDOUT" })).toBe("TIMEOUT");
    });
  });

  // ── TIMEOUT (message tokens) ─────────────────────────────────────────────
  describe("TIMEOUT", () => {
    it.each([
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "ECONNABORTED",
      "timeout of 5000ms exceeded",
    ])("classifies %s as TIMEOUT", (msg) => {
      expect(classifyError({ errorMsg: msg })).toBe("TIMEOUT");
    });

    it("matches timeout tokens case-insensitively", () => {
      expect(classifyError({ error: "econnreset" })).toBe("TIMEOUT");
    });

    it("reads the parseError field for tokens too", () => {
      expect(classifyError({ parseError: "ECONNREFUSED" })).toBe("TIMEOUT");
    });
  });

  // ── OTHER / defensive ────────────────────────────────────────────────────
  describe("OTHER and defensive inputs", () => {
    it("classifies undefined detail as OTHER", () => {
      expect(classifyError(undefined)).toBe("OTHER");
    });

    it("classifies null detail as OTHER", () => {
      expect(classifyError(null)).toBe("OTHER");
    });

    it("classifies an empty object as OTHER", () => {
      expect(classifyError({})).toBe("OTHER");
    });

    it("classifies an unrelated message as OTHER", () => {
      expect(classifyError({ errorMsg: "something unexpected" })).toBe("OTHER");
    });

    it("classifies a non-object detail as OTHER", () => {
      expect(classifyError("a string detail")).toBe("OTHER");
    });
  });
});
