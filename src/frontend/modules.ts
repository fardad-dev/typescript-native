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
// Supported import/export forms (all relative specifiers, → `<spec>.ts`):
//   - `export` on a declaration (`export function`/`class`/`const`/`let`).
//   - named imports, incl. aliasing — `import { a, b as c } from "./d"`.
//   - default — `export default fn/class/<expr>`, `import d from "./d"`,
//     `import d, { a } from "./d"`. A `default` export is just an export named
//     "default"; an `export default <expr>` desugars (in `lower`) to a synthetic
//     module variable.
//   - namespace imports — `import * as ns from "./d"`. `ns` is virtual (no runtime
//     object): each `ns.x` / `ns.f(...)` / `new ns.C(...)` / type `ns.C` is resolved
//     against `./d`'s symbol table by the Renamer.
//   - export lists & re-exports — `export { a, b as c }`, `export { a } from "./d"`,
//     `export * from "./d"`. These extend a module's symbol table; a `from` re-export
//     also adds a dependency edge.
// Rejected cleanly: non-relative/package specifiers (external npm packages can't be
// compiled to native) and circular imports (the eager memoized-record init model
// would risk a silent miscompile under ES cycle/TDZ semantics) — both permanent
// limitations. Also rejected: namespace re-export (`export * as ns from`) and the
// CommonJS `export =`.

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { lower } from "./lower";
import { Module, Func, ClassDecl, Stmt, Expr, Type, Param } from "../ir/nodes";

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

// Return an import declaration's resolved dependency path. Every import *form* is
// accepted here — named (incl. aliasing `{ a as b }`), default (`import d from`),
// and namespace (`import * as ns`) — and wired later in `collectImports`. The graph
// follows every import (incl. `import type` and bare `import "./x"` side-effect
// imports) so the referenced module's declarations are merged in. The one rejected
// case is a non-relative specifier (handled by `resolveImport`).
function importDependency(node: ts.ImportDeclaration, file: string): string {
  if (!ts.isStringLiteral(node.moduleSpecifier)) {
    throw new Error(
      `Import specifier must be a string literal in '${path.basename(file)}'`,
    );
  }
  return resolveImport(file, node.moduleSpecifier.text);
}

// Parse a file (lightweight) just to list its resolved dependency edges, in source
// order: every `import`, plus a re-export *from* another module (`export { x } from
// "./y"`, `export * from "./y"`) — the re-exported module's top-level must run and
// its names are re-exported. A bare `export { x }` (no specifier) only affects the
// symbol table, so it adds no edge. A namespace re-export (`export * as ns from`) is
// rejected (it would need a namespace *value*).
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
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamespaceExport(stmt.exportClause)) {
        throw new Error(
          `Namespace re-export (export * as ns from ...) is not supported (v1) in '${path.basename(file)}'`,
        );
      }
      if (stmt.moduleSpecifier) {
        if (!ts.isStringLiteral(stmt.moduleSpecifier)) {
          throw new Error(
            `Export specifier must be a string literal in '${path.basename(file)}'`,
          );
        }
        deps.push(resolveImport(file, stmt.moduleSpecifier.text));
      }
      continue;
    }
  }
  return deps;
}

// A value import binding: `local` is the name in the importing module, `exportName`
// the name it resolves to in `depFile`. Covers named imports (`{ a }` → both equal),
// aliasing (`{ a as b }` → local `b`, export `a`), and default imports (`import d`
// → export `"default"`).
interface Binding {
  local: string;
  exportName: string;
  depFile: string;
}

// A namespace import `import * as ns from "./d"`: `ns` is virtual (no runtime
// object) — every `ns.x` is resolved against `./d`'s symbol table at rename time.
interface NsImport {
  nsLocal: string;
  depFile: string;
}

// A re-export / export-list entry. `{ exportName, localName, fromFile? }` covers
// `export { a as b }` (local `a` re-exported as `b`; no `fromFile`) and the same
// `from "./d"` form (resolve `a` in `./d`). `{ star: true, fromFile }` is
// `export * from "./d"` (re-export all of `./d`'s exports except its default).
type ReExport =
  | { exportName: string; localName: string; fromFile?: string }
  | { star: true; fromFile: string };

// The value/namespace imports of a file. Import *specifiers* were already resolved
// during the graph walk, so every specifier here is a well-formed relative path.
function collectImports(
  file: string,
  source: string,
): { bindings: Binding[]; namespaces: NsImport[] } {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const bindings: Binding[] = [];
  const namespaces: NsImport[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const depFile = resolveImport(
      file,
      (stmt.moduleSpecifier as ts.StringLiteral).text,
    );
    const clause = stmt.importClause;
    // `import dflt from "..."` / `import dflt, { ... } from "..."`.
    if (clause.name) {
      bindings.push({ local: clause.name.text, exportName: "default", depFile });
    }
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) {
      namespaces.push({ nsLocal: nb.name.text, depFile });
    } else if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        bindings.push({
          local: el.name.text,
          exportName: el.propertyName?.text ?? el.name.text,
          depFile,
        });
      }
    }
  }
  return { bindings, namespaces };
}

// The re-export / export-list entries of a file, used to extend its symbol table
// with names it exports indirectly. `export type { ... }` is type-only (erased), so
// it carries no runtime wiring. A namespace re-export was rejected in the graph walk.
function reExportsOf(file: string, source: string): ReExport[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: ReExport[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt) || stmt.isTypeOnly) continue;
    const fromFile =
      stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
        ? resolveImport(file, stmt.moduleSpecifier.text)
        : undefined;
    const clause = stmt.exportClause;
    if (!clause) {
      // `export * from "./d"` — the parser guarantees a specifier here.
      if (fromFile) out.push({ star: true, fromFile });
      continue;
    }
    if (ts.isNamespaceExport(clause)) continue; // rejected earlier
    for (const el of clause.elements) {
      // `export { a as b }` — `name` is the export (`b`), `propertyName` the local.
      out.push({
        exportName: el.name.text,
        localName: el.propertyName?.text ?? el.name.text,
        fromFile,
      });
    }
  }
  return out;
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
    // local namespace name (`import * as ns`) -> that dependency's symbol table.
    private namespaces: Map<string, Map<string, Resolution>>,
  ) {}

  run(mod: Module): void {
    for (const f of mod.functions) this.func(f);
    for (const c of mod.classes) this.cls(c);
    mod.main = this.topBody(mod.main);
  }

  // A Resolution as an expression: a renamed `var`, or a `member`-on-`init()` read
  // for a dependency-module variable (reusing the object/member codegen).
  private resolutionExpr(r: Resolution): Expr {
    if (typeof r === "string") return { kind: "var", name: r };
    return {
      kind: "member",
      obj: { kind: "call", callee: r.record, args: [] },
      name: r.field,
    };
  }

  // If `e` is an unshadowed reference to a namespace import, its dependency's symbol
  // table (so `ns.x` can resolve `x`); otherwise undefined.
  private nsOf(
    e: Expr,
    locals: Set<string>,
  ): Map<string, Resolution> | undefined {
    if (e.kind === "var" && !locals.has(e.name))
      return this.namespaces.get(e.name);
    return undefined;
  }

  // Resolve a value identifier to its replacement expression: a renamed `var`, or
  // a `member`-on-`init()` for a dependency-module variable. Locals are unchanged.
  // A bare namespace name used as a value (not `ns.x`) is a clean error.
  private ref(name: string, locals: Set<string>): Expr {
    if (locals.has(name)) return { kind: "var", name };
    if (this.namespaces.has(name)) {
      throw new Error(
        `Namespace import '${name}' can only be used via member access (e.g. ${name}.x) — using it as a value is not supported`,
      );
    }
    const r = this.symtab.get(name);
    if (r === undefined) return { kind: "var", name };
    return this.resolutionExpr(r);
  }

  // Resolve a class/type name that may be namespace-qualified ("ns.Cls"). A plain
  // name resolves through the symbol table (functions/classes are plain strings); a
  // qualified name resolves its member through the namespace's table.
  private resolveTypeName(name: string): string {
    const dot = name.indexOf(".");
    if (dot < 0) return this.symName(name);
    const ns = this.namespaces.get(name.slice(0, dot));
    const r = ns?.get(name.slice(dot + 1));
    return typeof r === "string" ? r : name;
  }

  // A name in the type/declaration namespace (function/class names): always a
  // plain string resolution (functions/classes are never dependency records).
  private symName(name: string): string {
    const r = this.symtab.get(name);
    return typeof r === "string" ? r : name;
  }

  // Resolve a parameter list's type references and (default-param) initializer
  // expressions, returning the set of parameter names (locals for the body). A
  // default expression is rewritten with the param names as locals — it runs in
  // the body's scope, so it may reference earlier params (left unrewritten).
  private params(params: Param[]): Set<string> {
    const locals = new Set(params.map((p) => p.name));
    for (const p of params) {
      this.type(p.type);
      if (p.default !== undefined) p.default = this.expr(p.default, locals);
    }
    return locals;
  }

  private func(f: Func): void {
    f.name = this.symName(f.name);
    const locals = this.params(f.params);
    if (f.returnType !== "void") this.type(f.returnType);
    f.body = this.body(f.body, locals);
  }

  private cls(c: ClassDecl): void {
    c.name = this.symName(c.name);
    for (const fld of c.fields) this.type(fld.type);
    c.ctor.body = this.body(c.ctor.body, this.params(c.ctor.params));
    for (const m of c.methods) {
      const locals = this.params(m.params);
      if (m.returnType !== "void") this.type(m.returnType);
      m.body = this.body(m.body, locals);
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
        if (s.init) s.init = this.expr(s.init, locals);
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
        if (s.init) s.init = this.expr(s.init, locals);
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
      case "doWhile":
        s.body = this.body(s.body, new Set(locals));
        s.cond = this.expr(s.cond, locals);
        return s;
      case "forOf": {
        s.iterable = this.expr(s.iterable, locals); // outer scope (name not bound)
        const inner = new Set(locals);
        inner.add(s.name); // the loop variable shadows the table in the body
        s.body = this.body(s.body, inner);
        return s;
      }
      case "forIn": {
        s.target = this.expr(s.target, locals);
        const inner = new Set(locals);
        inner.add(s.name);
        s.body = this.body(s.body, inner);
        return s;
      }
      case "switch":
        s.disc = this.expr(s.disc, locals);
        for (const c of s.cases) {
          if (c.test) c.test = this.expr(c.test, locals);
          c.body = this.body(c.body, new Set(locals));
        }
        return s;
      case "break":
      case "continue":
        return s; // labels are not symbols — nothing to rewrite
      case "labeled":
        s.body = this.stmt(s.body, locals);
        return s;
      case "throw":
        s.value = this.expr(s.value, locals);
        return s;
      case "try": {
        s.block = this.body(s.block, new Set(locals));
        if (s.catchBody) {
          const inner = new Set(locals);
          if (s.catchName) inner.add(s.catchName); // the caught binding shadows
          s.catchBody = this.body(s.catchBody, inner);
        }
        if (s.finallyBody)
          s.finallyBody = this.body(s.finallyBody, new Set(locals));
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
        // className may be namespace-qualified ("ns.Cls") from `new ns.Cls(...)`.
        e.className = this.resolveTypeName(e.className);
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
      case "member": {
        // `ns.x` on a namespace import resolves to `x`'s definition in the dep.
        const r = this.nsOf(e.obj, locals)?.get(e.name);
        if (r !== undefined) return this.resolutionExpr(r);
        e.obj = this.expr(e.obj, locals); // not e.name (field / .length)
        return e;
      }
      case "methodCall": {
        // `ns.fn(args)` on a namespace import — a call of the dep's `fn` (a function
        // → a direct `call`; a function-valued variable → a `callValue`).
        const r = this.nsOf(e.receiver, locals)?.get(e.method);
        if (r !== undefined) {
          const args = e.args.map((a) => this.expr(a, locals));
          return typeof r === "string"
            ? { kind: "call", callee: r, args }
            : { kind: "callValue", callee: this.resolutionExpr(r), args };
        }
        e.receiver = this.expr(e.receiver, locals); // not e.method
        e.args = e.args.map((a) => this.expr(a, locals));
        return e;
      }
      case "jsonStringify":
      case "promiseResolve":
      case "promiseAll":
        e.arg = this.expr(e.arg, locals);
        return e;
      case "closure": {
        // A closure introduces its own scope: its parameters shadow the table, so
        // only genuinely free references in its body (and default expressions) are
        // rewritten.
        const inner = new Set(locals);
        for (const p of e.params) {
          this.type(p.type);
          inner.add(p.name);
        }
        for (const p of e.params) {
          if (p.default !== undefined) p.default = this.expr(p.default, inner);
        }
        if (e.returnType && e.returnType !== "void") this.type(e.returnType);
        e.body = this.body(e.body, inner);
        return e;
      }
      case "callValue":
        e.callee = this.expr(e.callee, locals);
        e.args = e.args.map((a) => this.expr(a, locals));
        return e;
      case "spread":
        e.arg = this.expr(e.arg, locals);
        return e;
      case "await":
        e.expr = this.expr(e.expr, locals);
        return e;
      case "typeof":
        e.operand = this.expr(e.operand, locals);
        return e;
      case "mathCall":
        e.args = e.args.map((a) => this.expr(a, locals));
        return e;
      case "mapNew":
        this.type(e.key); // resolve any class type-ref in the key/value type
        this.type(e.value);
        return e;
      case "setNew":
        this.type(e.element);
        if (e.init) e.init = this.expr(e.init, locals);
        return e;
      case "jsonParse":
        e.text = this.expr(e.text, locals);
        this.type(e.type); // resolve any class type-ref (codegen rejects it later)
        return e;
      case "fetch":
        e.url = this.expr(e.url, locals);
        return e;
      case "responseJson":
        e.receiver = this.expr(e.receiver, locals);
        this.type(e.type); // resolve any class type-ref (codegen rejects it later)
        return e;
      default:
        return e; // num / bool / str / this
    }
  }

  private type(t: Type): void {
    if (typeof t !== "object") return; // primitive keyword
    if (t.kind === "class") t.name = this.resolveTypeName(t.name); // may be ns.Cls
    else if (t.kind === "array") this.type(t.element);
    else if (t.kind === "map") {
      this.type(t.key);
      this.type(t.value);
    } else if (t.kind === "set") this.type(t.element);
    else if (t.kind === "promise") {
      if (t.value) this.type(t.value); // resolve a class type-ref in Promise<C>
    } else if (t.kind === "response")
      return; // built-in, no nested type-refs
    else if (t.kind === "union")
      for (const m of t.members) this.type(m); // resolve class refs in members
    else if (t.kind === "function") {
      for (const p of t.params) this.type(p); // resolve class refs in params/ret
      if (t.ret !== "void") this.type(t.ret);
    } else for (const f of t.fields) this.type(f.type);
  }
}

// One reachable file, lowered: its path, position in dependency order, whether
// it is the entry, and its (pre-rename) IR Module.
interface LoadedModule {
  file: string;
  index: number;
  isEntry: boolean;
  mod: Module;
}

// Depth-first post-order over the import graph from `entry` → topological order
// (a file is appended only after all its dependencies, so the entry — visited
// first — is appended LAST). `onStack` detects cycles (thrown with the trace).
function topoSort(entry: string, read: (file: string) => string): string[] {
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
  return order;
}

// Build each module's symbol table in topo order — so an importer always finds its
// dependency's table ready — then rewrite that module's IR *in place* via the
// scope-aware Renamer. A global name (function, class, entry var) is mangled when it
// collides across modules or clashes with a reserved C++ identifier (e.g. an entry
// variable or function `main`). Each table is the union of: the module's own
// declarations; its `default` export; its named/default imports; and its re-exports
// (which point at another module's resolution). Namespace imports don't add table
// entries — they are resolved per-access by the Renamer against the dep's table.
function resolveAndRename(
  modules: LoadedModule[],
  read: (file: string) => string,
): void {
  const nameCount = new Map<string, number>();
  for (const m of modules) {
    for (const name of globalSymbols(m.mod, m.isEntry)) {
      nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
    }
  }
  const mustMangle = (name: string) =>
    (nameCount.get(name) ?? 0) > 1 || RESERVED.has(name);

  const symtabs = new Map<string, Map<string, Resolution>>();
  for (const m of modules) {
    const symtab = new Map<string, Resolution>();
    const mangleIfNeeded = (name: string) =>
      mustMangle(name) ? mangle(m.index, name) : name;
    // 1. Own declarations: functions/classes (top-level symbols) and module
    //    variables (entry → file-scope global; dependency → record field).
    for (const f of m.mod.functions) symtab.set(f.name, mangleIfNeeded(f.name));
    for (const c of m.mod.classes) symtab.set(c.name, mangleIfNeeded(c.name));
    for (const s of m.mod.main) {
      if (s.kind !== "let") continue;
      symtab.set(
        s.name,
        m.isEntry
          ? mangleIfNeeded(s.name) // entry var -> (mangled) file-scope global
          : { record: initName(m.index), field: s.name }, // dep var -> record
      );
    }
    // 2. `export default` → the synthetic `default` export name (resolves to the
    //    default target's own resolution, already in the table from step 1).
    if (m.mod.defaultExport !== undefined) {
      const r = symtab.get(m.mod.defaultExport);
      if (r !== undefined) symtab.set("default", r);
    }
    // 3. Named / default / aliased imports → the exporting module's resolution.
    const { bindings, namespaces } = collectImports(m.file, read(m.file));
    for (const b of bindings) {
      const resolved = symtabs.get(b.depFile)?.get(b.exportName);
      if (resolved !== undefined) symtab.set(b.local, resolved);
    }
    // 4. Re-exports / export lists → make an exported-as name resolve like its
    //    source (a local decl, or a name in the `from` module). `export *` copies a
    //    dependency's exports, except its default and any name already present
    //    (a local declaration / explicit re-export wins).
    for (const re of reExportsOf(m.file, read(m.file))) {
      if ("star" in re) {
        const depTab = symtabs.get(re.fromFile);
        if (!depTab) continue;
        for (const [name, res] of depTab) {
          if (name !== "default" && !symtab.has(name)) symtab.set(name, res);
        }
      } else {
        const src = re.fromFile
          ? symtabs.get(re.fromFile)?.get(re.localName)
          : symtab.get(re.localName);
        if (src !== undefined) symtab.set(re.exportName, src);
      }
    }
    symtabs.set(m.file, symtab);
    // 5. Namespace imports: bind each `ns` to its dependency's (now complete) table
    //    so the Renamer can resolve `ns.x` accesses.
    const nsTabs = new Map<string, Map<string, Resolution>>();
    for (const ns of namespaces) {
      const depTab = symtabs.get(ns.depFile);
      if (depTab) nsTabs.set(ns.nsLocal, depTab);
    }
    new Renamer(symtab, m.isEntry, nsTabs).run(m.mod);
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

  // Lower each reachable file in dependency order (topo sort ⇒ index reflects
  // dependency order, entry last), then resolve names across modules.
  const modules: LoadedModule[] = topoSort(entry, read).map((file, index) => ({
    file,
    index,
    isEntry: file === entry,
    mod: lower(file, read(file)),
  }));
  resolveAndRename(modules, read);

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
