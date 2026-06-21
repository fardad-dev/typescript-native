# src/frontend/ — type-check + resolve + parse + lower (stages 0, 1 & 2)

The front of the pipeline: [check.ts](check.ts) type-checks (stage 0), [modules.ts](modules.ts)
resolves the import graph and drives lowering across files (stage 1), and [lower.ts](lower.ts) turns
one file's source into our IR ([../ir/nodes.ts](../ir/nodes.ts)) (stages 1 & 2).

- **Type-check (stage 0):** `typeCheck(fileName, source)` builds a real `ts.Program` + `TypeChecker`
  (in-memory source + an ambient `console`, ES2020 lib only, `strict: true`, `module: ESNext` +
  `moduleResolution: Bundler` so it resolves the whole import graph from disk) and **throws** formatted
  TS diagnostics on any type error, before we lower. It's a **gate** — it rejects type-erroneous
  programs (incl. cross-module ones) but does not yet feed inferred types into lowering.
- **Resolve + merge (stage 1):** `loadProgram(entryPath)` follows `import`s, topologically sorts the
  graph, lowers each file, and bundles the results into one IR `Module`. See *Modules*.
- **Parse:** `ts.createSourceFile(...)` gives a full AST with parent links — a second, lightweight
  parse that lowering walks.

Subset-specific rejections (`var`, parameter properties, …) happen during lowering, *after* the type
check — stage 0 only enforces TypeScript's semantics, not our subset's restrictions.

## Modules ([modules.ts](modules.ts))

The backend is one translation unit, so a module graph is **bundled** into one IR `Module`, each module
scoped independently:

1. **Resolve.** From the entry, parse each file to list its dependency edges: every `import`, plus a
   re-export *from* another module (`export { x } from "./y"`, `export * from "./y"`). `resolveImport`
   accepts relative specifiers only (`./x` → `<spec>.ts`). DFS post-order gives topological order
   (dependencies first, entry last); `onStack` detects circular imports.
2. **Resolve names + rewrite.** Each module gets a symbol table (`Map<name, Resolution>`), the union of:
   its own declarations; its `default` export (just an export named `"default"`); its named/default/
   aliased imports (wired to the dep's resolution by `exportName`); and its re-exports / export lists
   (an exported-as name resolves like its source; `export *` copies a dep's exports minus its default).
   A scope-aware `Renamer` then rewrites the IR in place:
   - **functions / classes** → a plain name, **mangled** (`tsn_m<idx>_<name>`) only on a cross-module
     collision or a reserved C++ identifier (`mustMangle`); they stay top-level.
   - an **entry-module variable** → a (possibly mangled) file-scope global.
   - a **dependency-module variable** → `member` on a call to that module's `init()` — reusing the
     existing object/member codegen.
   - a **namespace import** (`import * as ns`) is virtual: `ns` adds no table entry; the Renamer
     resolves each `ns.x` / `ns.f(...)` / `new ns.C(...)` / type `ns.C` against the dep's table at the
     access site (a member read, a direct `call`/`callValue`, or the real class name).
   The `Renamer` is scope-aware (a param/local/loop var shadows the table); member/method/field/
   property *names* are never touched.
3. **Merge.** Entry top-level → `Module.main`; each dependency → a `Module.modules` entry (a
   `DepModule` the emitter turns into a memoized `init()`); functions/classes are top-level.

So module-private state is encapsulated (a dependency variable lives in its record, never a global),
yet a function can read its module's variables (via the record). The stage-0 checker enforces real
module semantics, so an importer can't reach a module's private variables.

**Permanently rejected** (clean `tsnc:` errors, not roadmap): non-relative / package specifiers
(external npm packages can't compile to native) and circular imports (the eager-record `init()` model
would risk a silent miscompile under ES cycle/TDZ semantics). Also rejected: namespace re-export
(`export * as ns from`) and CommonJS `export =`. `lower` skips `import`/`export`-declaration
statements (an `export` modifier on a declaration lowers transparently); an anonymous `export default`
or `export default <expr>` is desugared to a synthetic module variable (`tsn_default`) whose name the
loader maps to the `"default"` export.

## Entry point & shape

`lower(fileName, source): Module` lowers one file and splits its top-level statements:
- `import`/`export`(-list/re-export) declarations → skipped (the loader owns them)
- `class` → `lowerClass` → `Module.classes`
- `function` → `lowerFunction` → `Module.functions`
- `export default <expr>` (an `ExportAssignment`) → a synthetic `let tsn_default = <expr>` in `main`
- a `default`-modified function/class → lowered normally (anonymous ones get the `tsn_default` name);
  the default target's local name is recorded in `Module.defaultExport`
- everything else → `lowerStatement` → `Module.main`
- a top-level `return`, and CommonJS `export =`, are rejected.

A multi-file program is assembled from per-file `lower` results by `loadProgram`.

## Internal helpers (one concern each)

- `lowerFunction` / `lowerClass` — functions (name, typed params, return type, `async`) and classes
  (typed fields, one constructor, methods; rejects inheritance/`static`/accessors/parameter
  properties/field initializers/missing constructor; ignores access modifiers). Each takes an optional
  `nameOverride` so an anonymous `export default function`/`class` gets the synthetic `tsn_default` name.
- `lowerParams` — shared typed-parameter lowering (functions/methods/constructors/closures); returns
  `{ params, prelude }`. An **optional param** `a?: T` → `T | undefined`; a **default param** keeps
  `type = T` and carries `default`; a **rest param** `...xs: T[]` carries `rest: true`. A
  **destructuring param** becomes a synthetic param + desugared `let`s pushed into `prelude` (callers
  prepend it to the body).
- `lowerStatement` — `let`/`const` (via `lowerVarDeclInto`, handles destructuring), `return`,
  `console.log` (→ `log`), bare calls (`exprStmt`), and all control flow: `if`, `while`, `do…while`,
  `for`, `for…of`/`for…in` (simple identifier only — destructuring there deferred), `switch`,
  `break`/`continue`, labeled loops (rejects labeling a non-loop), `try`/`throw` (`throw new Error(msg)`
  lowers to throwing `msg`).
- `lowerVarDeclInto` / `lowerVarDecl` — a `let`/`const`. A simple identifier → one `let` (also the home
  of `const x: T = JSON.parse(text)` and `= await res.json()`). A **destructuring** binding is desugared
  into a once-evaluated source temp + per-binding `let`s; array defaults use a length-check ternary,
  rest uses `.slice(i)`, holes are skipped; object rename/nesting read fields; object rest is deferred.
- `lowerType` — TS `TypeNode` → IR `Type`: keywords (incl. `null`/`undefined`), `T[]`/`Array<T>`,
  `Map<K,V>`/`Set<T>`, `Promise<T>`, `Response`, object type literals, **function types** `(a: T) => R`,
  and **union types** via `canonicalizeUnion`. A bare identifier that isn't a known primitive/built-in
  → a `class` instance type (existence checked later in the emitter); a **qualified name** `ns.Cls`
  (namespace import) → a `class` type named `"ns.Cls"` for the loader's renamer to resolve. An optional
  object field (`{ x?: T }`) is a clean error (deferred).
- `lowerExpr` — TS `Expression` → IR `Expr`: literals (incl. `null`/`undefined`, `typeof e`),
  identifiers, binary, ternary, unary, array/object literals, indexing, member, calls, `new C(...)`
  (and `new ns.Cls(...)` → a `new` whose className carries the `ns.` qualifier for the loader),
  `this`, the non-null assertion `e!` (transparent), template literals (desugared to a `+`-chain),
  the `JSON.*`/`Math.*`/`Promise.*` builtins, `new Map`/`new Set`, `fetch(url)`, and `await e`.
  **Arrows / function expressions** → a `closure` node (`lowerClosure`; param annotations required,
  return type inferred at codegen if unannotated; async arrows are clean errors). A **call** → a
  `methodCall` for `recv.m(...)`, a `call` for a bare-identifier `f(...)`, or a `callValue` for any
  other callee. A **spread** `...arg` in an array literal / argument list → a `spread` node; a value
  array **hole** is a clean error.
- The `as`-expression branch accepts only `JSON.parse(text) as T` and `await res.json() as T` (a general
  type assertion is rejected). `new Promise(executor)` is a clean error.

## Conventions / gotchas

- **Boxed wrappers are primitives here:** `Number`/`Boolean`/`String` annotations lower to
  `number`/`boolean`/`string`.
- **Aggregates nest:** `lowerType` recurses with no scalar-field check.
- **Class type-refs are open:** any bare identifier that isn't a known primitive/built-in → a class
  instance type *without* checking it exists — the emitter validates that. The built-in generics
  `Array`/`Map`/`Set`/`Promise` are special-cased; any other generic ref keeps its "Unsupported type
  annotation" error.
- **String values come pre-decoded:** use `node.text` (TS resolved escapes); codegen re-encodes.
- **Fail loud:** unsupported syntax throws `Error("Unsupported …")`. Keep messages specific — they
  surface as `tsnc: <message>`.

## Adding syntax

A new branch here, plus a matching IR node in [../ir/nodes.ts](../ir/nodes.ts) and a `case` in
[../codegen/emit.ts](../codegen/emit.ts).
