import { describe, it, expect } from "vitest";
import { typeCheck } from "../src/frontend/check";

// The type checker (stage 0) runs a real `ts.Program` + TypeChecker over the
// source and aborts before lowering/codegen on any TypeScript type error. The
// e2e harness only exercises programs that should *compile and run*, so it can't
// express "this program must be rejected" — that's what this file is for.
//
// `typeCheck` throws on a type error and returns normally on a clean program.
const FILE = "/virtual/case.ts";
const check = (src: string) => typeCheck(FILE, src);

describe("type checker: rejects type-erroneous programs before codegen", () => {
  // Each row: a label, a snippet, and a pattern the thrown diagnostic must match
  // (a stable TS error code or the message text — both survive the ANSI coloring).
  const rejected: Array<[string, string, RegExp]> = [
    ["assignment type mismatch", `let x: number = "hi";`, /TS2322/],
    ["boolean assigned to number", `let x: number = true;`, /TS2322/],
    ["undeclared identifier", `let y: number = z + 1;`, /Cannot find name 'z'/],
    ["call to unknown function", `foo(1);`, /Cannot find name 'foo'/],
    [
      "wrong argument count",
      `function f(a: number): number { return a; }\nf(1, 2);`,
      /Expected 1 arguments/,
    ],
    [
      "wrong argument type",
      `function f(a: number): number { return a; }\nf("x");`,
      /TS2345/,
    ],
    [
      "method that doesn't exist on number",
      `let n: number = 5;\nn.toUpperCase();`,
      /Property 'toUpperCase' does not exist/,
    ],
    ["return type mismatch", `function f(): number { return "s"; }`, /TS2322/],
    [
      "field access that doesn't exist",
      `let p = { x: 1 };\nconsole.log(p.y);`,
      /Property 'y' does not exist/,
    ],
  ];

  for (const [label, src, pattern] of rejected) {
    it(`rejects: ${label}`, () => {
      expect(() => check(src)).toThrow(pattern);
    });
  }
});

describe("type checker: accepts valid subset programs", () => {
  const accepted = [
    `let a: number = 1;\nconsole.log(a + 2);`,
    `let s = "hi";\nconsole.log(s.length);`,
    `let xs: number[] = [1, 2, 3];\nxs.push(4);\nconsole.log(xs.length);`,
    `let p = { x: 1 };\nlet q = p;\nconsole.log(p === q);`,
    `class C { v: number; constructor(v: number) { this.v = v; } }\nlet c = new C(3);\nconsole.log(c.v);`,
  ];

  accepted.forEach((src, i) => {
    it(`accepts valid program #${i + 1}`, () => {
      expect(() => check(src)).not.toThrow();
    });
  });
});
