import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadProgram } from "../src/frontend/modules";

// The module loader resolves the import graph, lowers each file, and merges
// everything into one IR Module. The e2e harness covers programs that compile
// and run; this file covers the loader's *structural* rejections — the cases
// that can't be expressed as a runnable .ts/.expected pair (cycles, cross-module
// name collisions, unsupported import forms, unresolvable specifiers).

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
    const entry = file("main.ts", `import { inc } from "./dep";\nconsole.log(inc(1));`);
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
    file("a.ts", `import { b } from "./b";\nexport function a(): number { return b(); }`);
    file("b.ts", `import { a } from "./a";\nexport function b(): number { return a(); }`);
    const entry = file("main.ts", `import { a } from "./a";\nconsole.log(a());`);
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
    const entry = file("main.ts", `import { x } from "./missing";\nconsole.log(x);`);
    expect(() => load(entry)).toThrow(/[Cc]annot resolve import/);
  });

  it("rejects non-relative (package) imports", () => {
    const entry = file("main.ts", `import { readFileSync } from "fs";\nconsole.log(1);`);
    expect(() => load(entry)).toThrow(/relative import/);
  });

  it("rejects default imports", () => {
    file("dep.ts", `export function f(): number { return 1; }`);
    const entry = file("main.ts", `import dflt from "./dep";\nconsole.log(1);`);
    expect(() => load(entry)).toThrow(/[Dd]efault import/);
  });

  it("rejects namespace imports", () => {
    file("dep.ts", `export function f(): number { return 1; }`);
    const entry = file("main.ts", `import * as ns from "./dep";\nconsole.log(1);`);
    expect(() => load(entry)).toThrow(/[Nn]amespace import/);
  });

  it("rejects import aliasing", () => {
    file("dep.ts", `export function f(): number { return 1; }`);
    const entry = file("main.ts", `import { f as g } from "./dep";\nconsole.log(1);`);
    expect(() => load(entry)).toThrow(/alias/);
  });

  it("rejects re-export statements", () => {
    file("dep.ts", `export function f(): number { return 1; }`);
    const entry = file("main.ts", `export { f } from "./dep";\nconsole.log(1);`);
    expect(() => load(entry)).toThrow(/[Rr]e-export|export-list/);
  });
});
