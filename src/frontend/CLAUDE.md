# src/frontend/ — type-check + resolve + parse + lower (stages 0, 1 & 2)

This folder owns the front of the pipeline: [check.ts](check.ts) type-checks (stage 0),
[modules.ts](modules.ts) resolves the import graph and drives lowering across files (stage 1), and
[lower.ts](lower.ts) turns one file's source into our internal IR ([../ir/nodes.ts](../ir/nodes.ts)).

- **Type-check (stage 0):** [check.ts](check.ts)'s `typeCheck(fileName, source)` builds a real
  `ts.Program` + `TypeChecker` (over an in-memory copy of the source + an ambient `console`, ES2020
  lib only, `strict: true`, plus `module: ESNext` + `moduleResolution: Bundler` so it resolves and
  checks the **whole import graph** from disk) and **throws** formatted TypeScript diagnostics on any
  type error, before we lower or emit. This is a *gate*: it rejects type-erroneous programs (incl.
  cross-module ones — use-of-non-exported, missing members, mismatched arg types across files) but
  does not (yet) feed inferred types into lowering.
- **Resolve + merge (stage 1):** [modules.ts](modules.ts)'s `loadProgram(entryPath)` follows
  `import`s from the entry to build the dependency graph, topologically sorts it, lowers each file,
  and **bundles** the results into one IR `Module`. See _Modules_ below.
- **Parse:** `ts.createSourceFile(...)` from the official `typescript` package gives a full
  AST (with parent links) — a second, lightweight parse that lowering walks.
- **Lower:** walk the AST and emit IR nodes.

Subset-specific rejections (e.g. `var`, parameter properties) still happen during lowering, *after*
the type check — stage 0 only enforces TypeScript's own semantics, not our subset's restrictions.

## Modules ([modules.ts](modules.ts))

`loadProgram(entryPath): Module` is the multi-file front-end. The backend is one translation unit /
one binary, so a module graph is **bundled** into a single IR `Module`, with each module **scoped
independently**:

1. **Resolve.** From the entry, parse each file (lightweight `ts.createSourceFile`) just to list its
   `import` dependencies. `resolveImport` accepts relative specifiers only (`./x` / `../x` →
   `<spec>.ts`). A DFS post-order produces topological order (dependencies first, **entry last**);
   `onStack` detects **circular imports** (clean error with the cycle trace).
2. **Resolve names + rewrite.** Each module gets a symbol table built in topo order, then a
   scope-aware `Renamer` rewrites its IR in place. How a top-level name resolves:
   - **functions / classes** → a plain name, **mangled** (`tsn_m<idx>_<name>`) only if it collides
     across modules or hits a reserved C++ identifier (`mustMangle`); otherwise kept verbatim. They
     stay top-level (called/constructed directly).
   - an **entry-module variable** → a (possibly mangled) **file-scope global**.
   - a **dependency-module variable** → `{ record: initName(idx), field }`; the `Renamer` rewrites
     every reference to it (in the module's own functions *or* an importer) into a `member` on a call
     to that module's `init()` — reusing the existing object/member codegen.
   The `Renamer` is **scope-aware**: a parameter / local `let` / loop var shadows the table, so only
   genuine top-level references are rewritten. Member, method, field, and object-property *names* are
   never touched.
3. **Merge.** The **entry** module's top-level → `Module.main`; each **dependency** module → a
   `Module.modules` entry (a `DepModule { index, body }` the emitter turns into a memoized `init()`
   returning a record of its variables); functions and classes from every module are top-level.

So module-private top-level state is encapsulated (a dependency variable lives in its record, never a
global), yet a function **can** read its module's variables (via the record). The stage-0 checker
(`module: ESNext` + `moduleResolution: Bundler`, in [check.ts](check.ts)) resolves the graph from disk
and enforces real module semantics — so an importer can't reach a module's private variables even
though the module's own functions can.

Rejected forms (clean `tsnc:` errors, raised in `importDependency`/`dependenciesOf`): default imports,
namespace imports (`import * as`), import aliasing (`{ a as b }`), re-export statements, and
non-relative specifiers. `lower` skips `import`/`export`-declaration statements (the loader handles
graph/semantics; an `export` modifier on a declaration is otherwise ignored and lowers transparently).

## Entry point & shape

`lower(fileName, source): Module` lowers **one file** and splits its top-level statements:
- `import` / `export` declarations → skipped (the module loader owns them; an `export` modifier on a
  declaration is ignored, so `export function`/`class`/`const` lower transparently)
- `class` declarations → `lowerClass` → `Module.classes`
- `function` declarations → `lowerFunction` → `Module.functions`
- everything else → `lowerStatement` → `Module.main` (the body of `@main`)
- a top-level `return` is rejected (only valid inside a function).

A multi-file program is assembled from per-file `lower` results by `loadProgram` (see _Modules_).

## Internal helpers (one concern each)

- `lowerFunction(fn)` — name, typed params, return type (incl. `void`), body statements.
- `lowerClass(cls)` — fields (typed, no initializers), one constructor, methods. Rejects
  inheritance, `static`, accessors, parameter properties, field initializers, and a missing
  constructor; **ignores** access modifiers (public/private/…). Bodies lower via `lowerStatement`.
- `lowerParams(params)` — shared typed-parameter lowering (functions, methods, constructors);
  also rejects parameter-properties (`constructor(private x: ...)`).
- `lowerStatement(node, out)` — `let`/`const`, `return`, `console.log(...)` (special-cased to a
  `log` stmt), and bare call expressions (`exprStmt`).
- `lowerVarDecl(decl)` — a single `let`/`const` binding; initializer is required. Also the home of
  the `const x: T = JSON.parse(text)` idiom: when annotated and the initializer is a `JSON.parse`
  call, the annotation supplies the parse target type (→ a `jsonParse` node).
- `lowerType(node)` — TS `TypeNode` → IR `Type` (keywords, `T[]`, `Array<T>`, object type literals;
  a **bare identifier** that isn't a known primitive/`Array` → a `class` instance type).
- `lowerExpr(node)` — TS `Expression` → IR `Expr` (literals, identifiers, binary, array/object
  literals, indexing, member access, calls, `new C(...)`, `this`). Also recognizes the `JSON.*`
  builtins (`tryLowerJsonCall`) and the `JSON.parse(text) as T` assertion (the one `as`-expression
  form the subset accepts — a general type assertion is rejected).
- `lowerBinaryOp(kind)` — operator token → `BinaryOp`.
- `isConsoleLog(expr)` — recognizes the `console.log` callee.
- `tryLowerJsonCall(node)` / `isJsonParseCall(node)` / `jsonParseNode(call, type)` — recognize and
  lower the `JSON.stringify` / `JSON.parse` builtins. `JSON.stringify(x)` lowers directly; a bare
  `JSON.parse(x)` (no `as T` / annotation, so no target type) is a clear error.

## Conventions / gotchas

- **Boxed wrappers are primitives here:** `Number`/`Boolean`/`String` annotations lower to
  `number`/`boolean`/`string`. (Strict TS would reject e.g. arithmetic on `Number`; our dialect
  has one of each.)
- **Aggregate function boundaries:** function params and returns may lower to **any** supported
  type — scalars, arrays, or objects (`lowerFunction` no longer rejects aggregates). How aggregates
  cross the boundary (const& params, by-value returns, the read-only-param rule) is a codegen
  concern — see [../codegen/CLAUDE.md](../codegen/CLAUDE.md).
- **Aggregates nest:** object fields and array element types may themselves be aggregates.
  `lowerType` recurses with no scalar-field check, so `{ pts: number[] }`, `{ inner: { x: number } }`,
  `number[][]`, and `{ x: number }[]` all lower to the right nested `Type`.
- **Class type-refs are open:** `lowerType` maps any bare identifier that isn't a known
  primitive/`Array` to `{ kind: "class", name }` *without* checking the class exists — the emitter
  validates that (and reports `Unknown class: X`). Generic refs (with type arguments) still fall
  through to the "Unsupported type annotation" throw, so e.g. `Map<K, V>` keeps its clear error.
- **String values come pre-decoded:** use `node.text` for string/template literals (TS already
  resolved escapes); codegen re-encodes them as C++ string literals.
- **Fail loud:** any unsupported syntax throws `Error("Unsupported ... ")`. Keep messages
  specific — they surface to the user as `tsnc: <message>`.

## Adding syntax

New surface syntax usually means: a new branch here **plus** a matching IR node in
[../ir/nodes.ts](../ir/nodes.ts) and a `case` in [../codegen/emit.ts](../codegen/emit.ts).
