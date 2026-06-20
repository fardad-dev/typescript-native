// Stage 1.5: module loading / linking.
//
// The backend compiles ONE C++ translation unit into ONE binary, so a multi-file
// program is resolved and *bundled* here: starting from the entry file we follow
// `import` statements, build the dependency graph, topologically sort it, lower
// every file with `lower()`, and merge the results into a single IR `Module`.
//
// MODULE MODEL. Each module is scoped independently:
//   - Functions and classes stay top-level C++ symbols (they can't be runtime
//     struct values). A name reused across modules is mangled apart
//     (`tsn_m<idx>_<name>`); a program-unique name is left verbatim.
//   - A *dependency* module (one imported by another) compiles to a memoized
//     `init()` that runs its top-level once and returns a record (struct) of its
//     module-level variables. A reference to such a variable — from the module's
//     own functions or from an importer — reads it back as `init().field`. So
//     module-private top-level code is encapsulated, and module variables don't
//     leak into a shared global namespace.
//   - The *entry* module keeps its top-level in `main()` with its own variables as
//     file-scope globals (no record needed — nothing imports the entry). A
//     single-file program is just an entry, so its codegen is exactly as before.
// `main()` runs each dependency's `init()` eagerly, in dependency order, before
// the entry's own top-level — so a module's top-level side effects run at import
// time (matching ES module semantics).
//
// The stage-0 TypeScript checker enforces real module semantics (you may only use
// what you export/import); this loader trusts that and focuses on wiring.
//
// Supported: `export` on a declaration (`export function`/`class`/`const`/`let`)
// and named imports `import { a, b } from "./relative/path"` (relative specifiers
// only, → `<spec>.ts`). Rejected cleanly: default imports, namespace imports
// (`import * as ns`), import aliasing (`{ a as b }`), re-export statements,
// non-relative/package specifiers, and circular imports.

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { lower } from "./lower";
import { Module, Func, ClassDecl, Stmt, Expr, Type } from "../ir/nodes";

// Resolve a relative import specifier to an absolute `.ts` file path. Only
// relative specifiers are supported; package/bare specifiers are out of subset.
function resolveImport(fromFile: string, spec: string): string {
  if (!spec.startsWith("./") && !spec.startsWith("../")) {
    throw new Error(
      `Only relative imports are supported (got '${spec}') — package/bare specifiers are out of subset`,
    );
  }
  const base = path.resolve(path.dirname(fromFile), spec);
  // Accept an explicit `.ts` extension or the extensionless TS convention.
  const candidates = base.endsWith(".ts") ? [base] : [`${base}.ts`, base];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  throw new Error(
    `Cannot resolve import '${spec}' from '${path.basename(fromFile)}'`,
  );
}

// Validate that an import declaration uses a supported form (named, non-aliased)
// and return its resolved dependency path. The graph follows every import (incl.
// `import type` and bare `import "./x"` side-effect imports) so the referenced
// module's declarations are merged in.
function importDependency(node: ts.ImportDeclaration, file: string): string {
  if (!ts.isStringLiteral(node.moduleSpecifier)) {
    throw new Error(
      `Import specifier must be a string literal in '${path.basename(file)}'`,
    );
  }
  const spec = node.moduleSpecifier.text;
  const clause = node.importClause;
  if (clause) {
    // `import dflt from "..."` — default import.
    if (clause.name) {
      throw new Error(
        `Default imports are not supported (v1) in '${path.basename(file)}' — use a named import`,
      );
    }
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) {
      throw new Error(
        `Namespace imports (import * as ns) are not supported (v1) in '${path.basename(file)}'`,
      );
    }
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        // `import { a as b }` — `propertyName` is the original, `name` the alias.
        if (el.propertyName) {
          throw new Error(
            `Import aliasing (import { ${el.propertyName.text} as ${el.name.text} }) is not supported (v1) in '${path.basename(file)}'`,
          );
        }
      }
    }
  }
  return resolveImport(file, spec);
}

// Parse a file (lightweight) just to list its resolved import dependencies, in
// source order. Re-export statements are rejected here (they would need their own
// graph edge and reference rewiring — out of subset).
function dependenciesOf(file: string, source: string): string[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
  );
  const deps: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      deps.push(importDependency(stmt, file));
      continue;
    }
    // `export { x } from "./y"` (re-export) or `export { x }` (export list).
    if (ts.isExportDeclaration(stmt)) {
      throw new Error(
        `Re-export / export-list statements are not supported (v1) in '${path.basename(file)}' — put 'export' on the declaration`,
      );
    }
  }
  return deps;
}

// A named import binding `{ local }` and the file it resolves to. (Aliasing
// `{ a as b }` is rejected by `importDependency`, so `local` is the export name.)
interface Binding {
  local: string;
  depFile: string;
}

// The named-import bindings of a file, used to wire each module's references to
// the exporting module's symbol. Import *forms* were already validated during the
// graph walk (`dependenciesOf`), so by here every import is a well-formed named
// import.
function importBindings(file: string, source: string): Binding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const bindings: Binding[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const nb = stmt.importClause.namedBindings;
    if (!nb || !ts.isNamedImports(nb)) continue;
    const depFile = resolveImport(
      file,
      (stmt.moduleSpecifier as ts.StringLiteral).text,
    );
    for (const el of nb.elements)
      bindings.push({ local: el.name.text, depFile });
  }
  return bindings;
}

// The "global C++ symbols" a module declares: functions and classes always (they
// stay top-level), plus — for the ENTRY module only — its top-level variables
// (which become file-scope globals). A dependency module's variables are NOT
// global symbols: they become fields of that module's record (addressed as
// `init().field`), so they never collide in the global namespace.
function globalSymbols(mod: Module, isEntry: boolean): string[] {
  const names: string[] = [];
  for (const f of mod.functions) names.push(f.name);
  for (const c of mod.classes) names.push(c.name);
  if (isEntry)
    for (const s of mod.main) if (s.kind === "let") names.push(s.name);
  return names;
}

// Per-module name mangling: a colliding global name is rewritten to a unique
// `tsn_m<idx>_<name>` so two modules can declare the same name without clashing.
function mangle(moduleIndex: number, name: string): string {
  return `tsn_m${moduleIndex}_${name}`;
}

// C++ identifiers a top-level (global) name must not collide with: `main` (the
// entry point) plus C++ keywords/built-in type names that are nonetheless valid
// TypeScript identifiers (so a user could name a function/class/variable one of
// them). Such a global is mangled like a cross-module collision. (TS-reserved
// words like `class`/`return` can't reach here — they're already syntax errors.)
const RESERVED = new Set([
  "main",
  "int",
  "char",
  "short",
  "long",
  "unsigned",
  "signed",
  "float",
  "double",
  "void",
  "bool",
  "wchar_t",
  "struct",
  "union",
  "enum",
  "class",
  "template",
  "typename",
  "namespace",
  "using",
  "operator",
  "friend",
  "virtual",
  "inline",
  "explicit",
  "mutable",
  "volatile",
  "register",
  "static",
  "extern",
  "const",
  "constexpr",
  "goto",
  "sizeof",
  "typedef",
  "nullptr",
  "and",
  "or",
  "not",
  "xor",
  "compl",
  "bitand",
  "bitor",
  "std",
  "NULL",
  "EOF",
]);

// The name of a dependency module's memoized init function.
function initName(moduleIndex: number): string {
  return `tsn_mod${moduleIndex}_init`;
}

// How a top-level name resolves: a plain (possibly mangled) rename for a function,
// class, or entry-module variable; or a dependency-module variable reached through
// that module's record — `init().field`.
type Resolution = string | { record: string; field: string };

// Rewrites a lowered module's declarations and references using a symbol table
// (`local name -> Resolution`). It is **scope-aware**: a local binding
// (parameter, function/nested `let`, loop variable) shadows a same-named
// top-level/imported symbol, so only genuine top-level references are rewritten.
// Member, method, field, and object-property *names* are never touched (they are
// not top-level symbols). A dependency-module variable reference is rewritten into
// a `member` on a call to that module's `init()`, reusing the existing
// object/member codegen. Type references to a class resolve through the table
// (types live in their own namespace, never shadowed by value locals).
class Renamer {
  constructor(
    private symtab: Map<string, Resolution>,
    private isEntry: boolean,
  ) {}

  run(mod: Module): void {
    for (const f of mod.functions) this.func(f);
    for (const c of mod.classes) this.cls(c);
    mod.main = this.topBody(mod.main);
  }

  // Resolve a value identifier to its replacement expression: a renamed `var`, or
  // a `member`-on-`init()` for a dependency-module variable. Locals are unchanged.
  private ref(name: string, locals: Set<string>): Expr {
    if (locals.has(name)) return { kind: "var", name };
    const r = this.symtab.get(name);
    if (r === undefined) return { kind: "var", name };
    if (typeof r === "string") return { kind: "var", name: r };
    return {
      kind: "member",
      obj: { kind: "call", callee: r.record, args: [] },
      name: r.field,
    };
  }

  // A name in the type/declaration namespace (function/class names): always a
  // plain string resolution (functions/classes are never dependency records).
  private symName(name: string): string {
    const r = this.symtab.get(name);
    return typeof r === "string" ? r : name;
  }

  private func(f: Func): void {
    f.name = this.symName(f.name);
    for (const p of f.params) this.type(p.type);
    if (f.returnType !== "void") this.type(f.returnType);
    f.body = this.body(f.body, new Set(f.params.map((p) => p.name)));
  }

  private cls(c: ClassDecl): void {
    c.name = this.symName(c.name);
    for (const fld of c.fields) this.type(fld.type);
    for (const p of c.ctor.params) this.type(p.type);
    c.ctor.body = this.body(
      c.ctor.body,
      new Set(c.ctor.params.map((p) => p.name)),
    );
    for (const m of c.methods) {
      for (const p of m.params) this.type(p.type);
      if (m.returnType !== "void") this.type(m.returnType);
      m.body = this.body(m.body, new Set(m.params.map((p) => p.name)));
    }
  }

  // Top-level statements of a module. A direct `let`/`const` declares a module
  // variable: in the ENTRY it is a global (its name resolved/mangled); in a
  // dependency it is a record field (name kept — it IS the field name; reads
  // resolve through the table to `init().field`). Neither is added to `locals`.
  private topBody(stmts: Stmt[]): Stmt[] {
    const locals = new Set<string>();
    return stmts.map((s) => {
      if (s.kind === "let") {
        s.init = this.expr(s.init, locals);
        if (s.type) this.type(s.type);
        if (this.isEntry) s.name = this.symName(s.name);
        return s;
      }
      return this.stmt(s, locals);
    });
  }

  private body(stmts: Stmt[], locals: Set<string>): Stmt[] {
    return stmts.map((s) => this.stmt(s, locals));
  }

  private stmt(s: Stmt, locals: Set<string>): Stmt {
    switch (s.kind) {
      case "let":
        s.init = this.expr(s.init, locals);
        if (s.type) this.type(s.type);
        locals.add(s.name); // a true local from here on (shadows the table)
        return s;
      case "assign":
        s.target = this.expr(s.target, locals);
        s.value = this.expr(s.value, locals);
        return s;
      case "return":
        if (s.value) s.value = this.expr(s.value, locals);
        return s;
      case "log":
        s.arg = this.expr(s.arg, locals);
        return s;
      case "exprStmt":
        s.expr = this.expr(s.expr, locals);
        return s;
      case "if":
        s.cond = this.expr(s.cond, locals);
        s.then = this.body(s.then, new Set(locals));
        if (s.else) s.else = this.body(s.else, new Set(locals));
        return s;
      case "while":
        s.cond = this.expr(s.cond, locals);
        s.body = this.body(s.body, new Set(locals));
        return s;
      case "for": {
        const inner = new Set(locals);
        if (s.init) s.init = this.stmt(s.init, inner);
        if (s.cond) s.cond = this.expr(s.cond, inner);
        if (s.update) s.update = this.stmt(s.update, inner);
        s.body = this.body(s.body, new Set(inner));
        return s;
      }
    }
  }

  private expr(e: Expr, locals: Set<string>): Expr {
    switch (e.kind) {
      case "var":
        return this.ref(e.name, locals);
      case "call":
        if (!locals.has(e.callee)) e.callee = this.symName(e.callee);
        e.args = e.args.map((a) => this.expr(a, locals));
        return e;
      case "new":
        e.className = this.symName(e.className);
        e.args = e.args.map((a) => this.expr(a, locals));
        return e;
      case "binary":
        e.left = this.expr(e.left, locals);
        e.right = this.expr(e.right, locals);
        return e;
      case "unary":
        e.operand = this.expr(e.operand, locals);
        return e;
      case "ternary":
        e.cond = this.expr(e.cond, locals);
        e.whenTrue = this.expr(e.whenTrue, locals);
        e.whenFalse = this.expr(e.whenFalse, locals);
        return e;
      case "array":
        e.elements = e.elements.map((el) => this.expr(el, locals));
        return e;
      case "object":
        e.properties = e.properties.map((p) => ({
          name: p.name,
          value: this.expr(p.value, locals),
        }));
        return e;
      case "index":
        e.arr = this.expr(e.arr, locals);
        e.index = this.expr(e.index, locals);
        return e;
      case "member":
        e.obj = this.expr(e.obj, locals); // not e.name (field / .length)
        return e;
      case "methodCall":
        e.receiver = this.expr(e.receiver, locals); // not e.method
        e.args = e.args.map((a) => this.expr(a, locals));
        return e;
      case "jsonStringify":
        e.arg = this.expr(e.arg, locals);
        return e;
      case "jsonParse":
        e.text = this.expr(e.text, locals);
        this.type(e.type); // resolve any class type-ref (codegen rejects it later)
        return e;
      default:
        return e; // num / bool / str / this
    }
  }

  private type(t: Type): void {
    if (typeof t !== "object") return; // primitive keyword
    if (t.kind === "class") t.name = this.symName(t.name);
    else if (t.kind === "array") this.type(t.element);
    else for (const f of t.fields) this.type(f.type);
  }
}

// Resolve the import graph from `entryPath`, lower every reachable file, scope
// names across modules, and merge into one IR Module. The entry module's
// top-level becomes `main`; each *dependency* module becomes a memoized record
// (`Module.modules`). Functions and classes stay top-level (mangled on
// collision); dependency-module variables are reached through their record.
export function loadProgram(entryPath: string): Module {
  const entry = path.resolve(entryPath);
  const sources = new Map<string, string>();
  const read = (file: string): string => {
    let s = sources.get(file);
    if (s === undefined) {
      s = fs.readFileSync(file, "utf8");
      sources.set(file, s);
    }
    return s;
  };

  // Depth-first post-order walk → topological order (a file is appended only
  // after all its dependencies). `onStack` detects cycles. The entry is visited
  // first but appended LAST, so it is the final element.
  const order: string[] = [];
  const done = new Set<string>();
  const onStack = new Set<string>();
  const visit = (file: string, stack: string[]): void => {
    if (done.has(file)) return;
    if (onStack.has(file)) {
      const start = stack.indexOf(file);
      const cycle = [...stack.slice(start), file]
        .map((f) => path.basename(f))
        .join(" -> ");
      throw new Error(`Circular import: ${cycle}`);
    }
    onStack.add(file);
    for (const dep of dependenciesOf(file, read(file))) {
      visit(dep, [...stack, file]);
    }
    onStack.delete(file);
    done.add(file);
    order.push(file);
  };
  visit(entry, []);

  // Lower each module (topo order ⇒ index reflects dependency order; entry last).
  const modules = order.map((file, index) => ({
    file,
    index,
    isEntry: file === entry,
    mod: lower(file, read(file)),
  }));

  // Which global names (functions, classes, entry vars) appear in more than one
  // module → those collide and must be mangled per module.
  const nameCount = new Map<string, number>();
  for (const m of modules) {
    for (const name of globalSymbols(m.mod, m.isEntry)) {
      nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
    }
  }
  // A global name must be mangled if it is reused across modules OR would clash
  // with a C++ reserved identifier (e.g. an entry variable or function `main`).
  const mustMangle = (name: string) =>
    (nameCount.get(name) ?? 0) > 1 || RESERVED.has(name);

  // Build each module's symbol table (own declarations + imported bindings) in
  // topo order, so an importer always finds its dependency's table ready, then
  // rewrite that module's IR in place.
  const symtabs = new Map<string, Map<string, Resolution>>();
  for (const m of modules) {
    const symtab = new Map<string, Resolution>();
    const claim = (name: string) =>
      mustMangle(name) ? mangle(m.index, name) : name;
    for (const f of m.mod.functions) symtab.set(f.name, claim(f.name));
    for (const c of m.mod.classes) symtab.set(c.name, claim(c.name));
    for (const s of m.mod.main) {
      if (s.kind !== "let") continue;
      symtab.set(
        s.name,
        m.isEntry
          ? claim(s.name) // entry var -> (mangled) file-scope global
          : { record: initName(m.index), field: s.name }, // dep var -> record
      );
    }
    for (const { local, depFile } of importBindings(m.file, read(m.file))) {
      const resolved = symtabs.get(depFile)?.get(local);
      if (resolved !== undefined) symtab.set(local, resolved);
    }
    symtabs.set(m.file, symtab);
    new Renamer(symtab, m.isEntry).run(m.mod);
  }

  // Merge: entry top-level → main; each dependency → a record module; functions
  // and classes from every module are top-level.
  const merged: Module = { classes: [], functions: [], main: [], modules: [] };
  for (const m of modules) {
    merged.classes.push(...m.mod.classes);
    merged.functions.push(...m.mod.functions);
    if (m.isEntry) merged.main.push(...m.mod.main);
    else merged.modules.push({ index: m.index, body: m.mod.main });
  }
  return merged;
}
