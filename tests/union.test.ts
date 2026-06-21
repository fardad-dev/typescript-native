import { describe, it, expect } from "vitest";
import { lower } from "../src/frontend/lower";
import { emit } from "../src/codegen/emit";

// Union types that COMPILE-AND-RUN are covered by the e2e harness (tests/cases/
// union-*.ts). This file covers the union constructs the subset deliberately
// REJECTS — they can't be expressed as a runnable .ts/.expected pair. The subset
// must reject them with a clear `tsnc:` message, never silently miscompile.
//
// (Type errors proper — e.g. accessing a member on an un-narrowed union — are
// caught earlier by the stage-0 TypeChecker; see tests/typecheck.test.ts.)

const FILE = "/virtual/case.ts";
// Lowering-stage rejections (thrown by `lower`).
const lowerSrc = (src: string) => lower(FILE, src);
// Codegen-stage rejections (thrown by `emit`, after a clean lowering).
const emitSrc = (src: string) => emit(lower(FILE, src));

describe("union types: subset rejections (clean tsnc errors)", () => {
  it("rejects an optional object field (deferred — needs literal defaulting)", () => {
    expect(() => lowerSrc(`let o: { x?: number } = { x: 1 };`)).toThrow(
      /Optional object field/,
    );
  });

  it("rejects widening a narrower union into a wider union (v1)", () => {
    expect(() =>
      emitSrc(
        `function f(x: number | string): number | string | null { return x; }`,
      ),
    ).toThrow(/Widening/);
  });
});
