import { describe, it, expect } from "vitest";
import { lower } from "../src/frontend/lower";
import { emit } from "../src/codegen/emit";

// Destructuring / spread / rest / default parameters that COMPILE-AND-RUN are
// covered by the e2e harness (tests/cases/{spread-array,rest-params,default-params,
// destructure-var,destructure-params}.ts). This file covers the sub-cases the
// subset deliberately REJECTS — each must produce a clear `tsnc:` message rather
// than silently miscompile.

const FILE = "/virtual/case.ts";
// Lowering-stage rejections (thrown by `lower`).
const lowerSrc = (src: string) => lower(FILE, src);
// Codegen-stage rejections (thrown by `emit` after lowering).
const emitSrc = (src: string) => emit(lower(FILE, src));

describe("destructuring / spread / rest / default: subset rejections", () => {
  it("rejects object rest in destructuring ('{ ...rest }')", () => {
    expect(() =>
      lowerSrc(`const o = { a: 1, b: 2 }; const { a, ...rest } = o;`),
    ).toThrow(/Object rest/);
  });

  it("rejects destructuring a for…of binding", () => {
    expect(() =>
      lowerSrc(`const ps = [[1, 2]]; for (const [a, b] of ps) { a + b; }`),
    ).toThrow(/simple identifier/);
  });

  it("rejects an array hole in a value literal", () => {
    expect(() => lowerSrc(`const xs = [1, , 3];`)).toThrow(/hole/i);
  });

  it("rejects a destructured rest parameter ('...[a, b]')", () => {
    expect(() =>
      lowerSrc(`function f(...[a, b]: number[]): number { return a + b; }`),
    ).toThrow(/rest parameter cannot be destructured/i);
  });

  it("rejects a spread argument into a function with no rest parameter", () => {
    const src = `
      function f(a: number, b: number): number { return a + b; }
      const xs = [1, 2];
      console.log(f(...xs));
    `;
    expect(() => emitSrc(src)).toThrow(/spread argument/);
  });

  it("rejects a spread that would fill a fixed parameter before the rest", () => {
    const src = `
      function f(a: number, ...rest: number[]): number { return a; }
      const xs = [1, 2];
      console.log(f(...xs, 3));
    `;
    expect(() => emitSrc(src)).toThrow(/spread argument/);
  });

  it("rejects a default value on a union-typed parameter", () => {
    const src = `function f(x: number | string = 1): string { return "" + x; }`;
    expect(() => emitSrc(src)).toThrow(/union-typed parameter/);
  });
});
