import { randomBytes } from "node:crypto";

import { decryptSecret, encryptSecret } from "../crypto";

const key = randomBytes(32).toString("base64");

describe("crypto", () => {
  it("round-trips and uses the v1 format with a fresh IV each time", () => {
    const a = encryptSecret("p@ss 密碼", key);
    const b = encryptSecret("p@ss 密碼", key);
    expect(a).toMatch(/^v1\.[^.]+\.[^.]+\.[^.]+$/);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key)).toBe("p@ss 密碼");
  });

  it("detects tampering with ciphertext, tag or IV", () => {
    const [v, iv, tag, ct] = encryptSecret("secret", key).split(".") as [
      string,
      string,
      string,
      string,
    ];
    const flip = (s: string) => {
      const buf = Buffer.from(s, "base64");
      buf[0] = buf[0]! ^ 1;
      return buf.toString("base64");
    };
    expect(() => decryptSecret([v, iv, tag, flip(ct)].join("."), key)).toThrow();
    expect(() => decryptSecret([v, iv, flip(tag), ct].join("."), key)).toThrow();
    expect(() => decryptSecret([v, flip(iv), tag, ct].join("."), key)).toThrow();
  });

  it("rejects a truncated auth tag", () => {
    const [v, iv, tag, ct] = encryptSecret("secret", key).split(".") as [
      string,
      string,
      string,
      string,
    ];
    const truncated = Buffer.from(tag, "base64").subarray(0, 4).toString("base64");
    expect(() => decryptSecret([v, iv, truncated, ct].join("."), key)).toThrow();
  });

  it("fails with the wrong key", () => {
    const enc = encryptSecret("secret", key);
    expect(() => decryptSecret(enc, randomBytes(32).toString("base64"))).toThrow();
  });

  it("rejects keys that are not 32 bytes", () => {
    const short = randomBytes(16).toString("base64");
    expect(() => encryptSecret("x", short)).toThrow(/32 bytes/);
    expect(() => encryptSecret("x", "")).toThrow(/32 bytes/);
    expect(() => decryptSecret(encryptSecret("x", key), short)).toThrow(/32 bytes/);
  });

  it("rejects an unknown format", () => {
    expect(() => decryptSecret("v2.a.b.c", key)).toThrow(/format/);
    expect(() => decryptSecret("garbage", key)).toThrow(/format/);
  });
});
