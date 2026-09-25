import { describe, expect, it } from "vitest";
import { hashToUnit, shortHash, stableStringify } from "./hash";

describe("stableStringify", () => {
  it("is insensitive to key order but not to array order", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it("sorts nested keys too", () => {
    expect(stableStringify({ x: { p: 1, q: 2 } })).toBe(
      stableStringify({ x: { q: 2, p: 1 } }),
    );
  });

  it("treats an absent key and an explicit undefined alike", () => {
    expect(stableStringify({ a: 1 })).toBe(stableStringify({ a: 1, b: undefined }));
  });

  it("tags values JSON cannot carry rather than dropping them", () => {
    // A node input that hashes the same as a different input is a replay bug.
    expect(stableStringify({ f: () => 1 })).not.toBe(stableStringify({}));
    expect(stableStringify({ n: NaN })).not.toBe(stableStringify({ n: 0 }));
    expect(stableStringify({ n: 1n })).not.toBe(stableStringify({ n: 1 }));
  });

  it("survives a cycle", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => stableStringify(a)).not.toThrow();
  });
});

describe("shortHash", () => {
  it("is 16 hex chars and stable", () => {
    const h = shortHash({ b: 1, a: [1, 2] });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h).toBe(shortHash({ a: [1, 2], b: 1 }));
  });
});

describe("hashToUnit", () => {
  it("lands in [0, 1) and is deterministic", () => {
    for (const seed of ["a", "b", "exp:user:123"]) {
      const v = hashToUnit(seed);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(hashToUnit(seed)).toBe(v);
    }
  });

  it("spreads roughly evenly", () => {
    let low = 0;
    for (let i = 0; i < 2000; i += 1) if (hashToUnit(`u${i}`) < 0.5) low += 1;
    expect(low).toBeGreaterThan(900);
    expect(low).toBeLessThan(1100);
  });
});
