import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadProgram } from "../src/frontend/modules";

// The module loader resolves the import graph, lowers each file, and merges
// everything into one IR Module. The e2e harness covers programs that compile and
// run (incl. the `module-*` cases for aliasing, default/namespace imports, and
// re-exports); this file covers the loader's *structural* behavior that can't be a
// runnable .ts/.expected pair — its rejections (cycles, name collisions, the two
// permanently-unsupported forms) and the symbol-table wiring of the advanced
// import/export forms.

describe("module loader: graph resolution and rejections", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsn-mod-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Write `name` (e.g. "a.ts") with `src` into the temp dir; return its path.
  const file = (name: string, src: string): string => {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, src);
    return p;
  };
  const load = (entry: string) => loadProgram(entry);

  it("merges a simple two-module program", () => {
    file("dep.ts", `export function inc(n: number): number { return n + 1; }`);
    const entry = file(
      "main.ts",
      `import { inc } from "./dep";\nconsole.log(inc(1));`,
    );
    const mod = load(entry);
    // inc lowered from dep.ts; the log statement from main.ts.
    expect(mod.functions.map((f) => f.name)).toContain("inc");
    expect(mod.main.length).toBe(1);
  });

  it("compiles a dependency into a record module, separate from the entry's main", () => {
    file("a.ts", `console.log("a");\nexport const A = 1;`);
    const entry = file("main.ts", `import { A } from "./a";\nconsole.log(A);`);
    const mod = load(entry);
    // a.ts is a dependency → its top-level (the log + `const A`) becomes a record
    // module; the entry's main holds only its own console.log(A).
    expect(mod.modules.length).toBe(1);
    expect(
      mod.modules[0].body.some((s) => s.kind === "let" && s.name === "A"),
    ).toBe(true);
    expect(mod.main.length).toBe(1);
    expect(mod.main[0]).toMatchObject({ kind: "log" });
  });

  it("rejects circular imports", () => {
    file(
      "a.ts",
      `import { b } from "./b";\nexport function a(): number { return b(); }`,
    );
    file(
      "b.ts",
      `import { a } from "./a";\nexport function b(): number { return a(); }`,
    );
    const entry = file(
      "main.ts",
      `import { a } from "./a";\nconsole.log(a());`,
    );
    expect(() => load(entry)).toThrow(/[Cc]ircular import/);
  });

  it("scopes cross-module top-level name collisions by mangling", () => {
    file("a.ts", `export function helper(): number { return 1; }`);
    file(
      "b.ts",
      `export function helper(): number { return 2; }\nexport function other(): number { return 3; }`,
    );
    // Both a.ts and b.ts declare a top-level `helper`; the loader scopes them
    // apart (mangling) instead of rejecting — two distinct functions coexist.
    const entry = file(
      "main.ts",
      `import { helper } from "./a";\nimport { other } from "./b";\nconsole.log(helper() + other());`,
    );
    const mod = load(entry);
    const names = mod.functions.map((f) => f.name);
    expect(names.filter((n) => n.includes("helper")).length).toBe(2);
    expect(new Set(names).size).toBe(names.length); // every merged name is unique
  });

  it("rejects an unresolvable import specifier", () => {
    const entry = file(
      "main.ts",
      `import { x } from "./missing";\nconsole.log(x);`,
    );
    expect(() => load(entry)).toThrow(/[Cc]annot resolve import/);
  });

  it("rejects non-relative (package) imports", () => {
    const entry = file(
      "main.ts",
      `import { readFileSync } from "fs";\nconsole.log(1);`,
    );
    expect(() => load(entry)).toThrow(/relative import/);
  });

  it("wires an import alias to the dependency's export", () => {
    file("dep.ts", `export function add(a: number, b: number): number { return a + b; }`);
    const entry = file(
      "main.ts",
      `import { add as plus } from "./dep";\nconsole.log(plus(1, 2));`,
    );
    const mod = load(entry);
    // The local `plus` resolves to dep's `add`: the call's callee is rewritten.
    expect(mod.functions.map((f) => f.name)).toContain("add");
    expect(mod.main[0]).toMatchObject({
      kind: "log",
      arg: { kind: "call", callee: "add" },
    });
  });

  it("wires a default import to the dependency's default export", () => {
    file("dep.ts", `export default function f(): number { return 1; }`);
    const entry = file("main.ts", `import g from "./dep";\nconsole.log(g());`);
    const mod = load(entry);
    expect(mod.functions.map((fn) => fn.name)).toContain("f");
    // `g()` resolves to the default-exported `f`.
    expect(mod.main[0]).toMatchObject({
      kind: "log",
      arg: { kind: "call", callee: "f" },
    });
  });

  it("resolves a namespace import's member access", () => {
    file("dep.ts", `export function ping(): number { return 7; }`);
    const entry = file(
      "main.ts",
      `import * as ns from "./dep";\nconsole.log(ns.ping());`,
    );
    const mod = load(entry);
    expect(mod.functions.map((f) => f.name)).toContain("ping");
    // `ns.ping()` resolves to a direct call of `ping` (no runtime namespace object).
    expect(mod.main[0]).toMatchObject({
      kind: "log",
      arg: { kind: "call", callee: "ping" },
    });
  });

  it("resolves names re-exported by a barrel (named `from` + star)", () => {
    file("a.ts", `export function one(): number { return 1; }`);
    file("b.ts", `export const two = 2;`);
    file(
      "barrel.ts",
      `export { one } from "./a";\nexport * from "./b";`,
    );
    const entry = file(
      "main.ts",
      `import { one, two } from "./barrel";\nconsole.log(one() + two);`,
    );
    const mod = load(entry);
    // `one` is a top-level function from a.ts; `two` is a record-field variable from
    // b.ts (a dependency module). Both reached through the barrel's re-exports.
    expect(mod.functions.map((f) => f.name)).toContain("one");
    const arg = (mod.main[0] as { arg: { left: unknown; right: unknown } }).arg;
    expect(arg.left).toMatchObject({ kind: "call", callee: "one" });
    expect(arg.right).toMatchObject({ kind: "member", name: "two" });
  });

  it("rejects a namespace re-export (export * as ns from)", () => {
    file("dep.ts", `export const x = 1;`);
    const entry = file(
      "main.ts",
      `export * as ns from "./dep";\nconsole.log(1);`,
    );
    expect(() => load(entry)).toThrow(/[Nn]amespace re-export/);
  });

  it("rejects `export =` (CommonJS export assignment)", () => {
    const entry = file("main.ts", `const x = 1;\nexport = x;`);
    expect(() => load(entry)).toThrow(/export =/);
  });
});
