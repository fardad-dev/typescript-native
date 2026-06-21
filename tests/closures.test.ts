import { describe, it, expect } from "vitest";
import { lower } from "../src/frontend/lower";
import { emit } from "../src/codegen/emit";

// Closures / first-class functions that COMPILE-AND-RUN are covered by the e2e
// harness (tests/cases/closure-*.ts, function-*.ts). This file covers the closure
// constructs the subset deliberately REJECTS — they can't be a runnable
// .ts/.expected pair. The subset must reject each with a clear `tsnc:` message,
// never silently miscompile.

const FILE = "/virtual/case.ts";
// Lowering-stage rejections (thrown by `lower`).
const lowerSrc = (src: string) => lower(FILE, src);
// Codegen-stage rejections (thrown by `emit`, incl. the capture pass) — run the
// single-file pipeline lower → emit.
const emitSrc = (src: string) => emit(lower(FILE, src));

describe("closures: subset rejections (clean tsnc errors)", () => {
  it("rejects an async arrow function (deferred — async closures)", () => {
    expect(() =>
      lowerSrc(`const f = async (x: number): Promise<number> => x;`),
    ).toThrow(/async arrow/);
  });

  // Default and rest parameters on closures are now SUPPORTED (see
  // tests/cases/default-params.ts, rest-params.ts, and destructure-rest-default.test.ts).

  it("rejects `this` captured by an arrow inside a method", () => {
    const src = `
      class C {
        x: number;
        constructor() { this.x = 1; }
        get(): () => number { return (): number => this.x; }
      }
      const c = new C();
      console.log(c.get()());
    `;
    expect(() => emitSrc(src)).toThrow(/this.*closure/);
  });

  it("rejects comparing function values with ===", () => {
    const src = `
      const f = (x: number): number => x;
      const g = (x: number): number => x;
      console.log(f === g);
    `;
    expect(() => emitSrc(src)).toThrow(/Function values cannot be compared/);
  });

  it("rejects JSON.stringify of a function", () => {
    const src = `
      const f = (x: number): number => x;
      console.log(JSON.stringify(f));
    `;
    expect(() => emitSrc(src)).toThrow(/JSON.stringify of a function/);
  });

  it("rejects calling a non-function value", () => {
    const src = `
      let n = 5;
      console.log(n(3));
    `;
    expect(() => emitSrc(src)).toThrow(/is not a function/);
  });
});
