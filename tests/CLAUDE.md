# tests/ — end-to-end suite

The tests exercise the **whole pipeline**: compile a `.ts` program to a real native binary,
run it, and diff its stdout against an expected file. There are no unit tests — a green case
means the source actually compiled and executed correctly.

## Layout

```
tests/
  e2e.test.ts        # the harness (vitest)
  typecheck.test.ts  # stage-0 checker: asserts type-erroneous programs are rejected
  modules.test.ts    # module loader: asserts graph rejections (cycles, collisions, …)
  fetch.test.ts      # fetch: compile+run against a localhost server (network-hermetic)
  cases/
    <name>.ts        # a complete tsn program (the entry)
    <name>.expected  # its exact expected stdout
    modlib/          # helper modules imported by cases/ (see Multi-file cases)
```

## How the harness works ([e2e.test.ts](e2e.test.ts))

For every `cases/*.ts`, it:
1. compiles via `driver.compileAsync({ input, output, emitCpp: false })` (the async twin of the
   CLI's `compile` — clang++ runs as a non-blocking child process),
2. runs the produced binary with async `execFile`,
3. asserts stdout `===` the matching `.expected`,
4. cleans up the temp binary.

Cases are auto-discovered — **adding a pair is adding a test**, no harness edits needed.

### Parallelism

Cases use `it.concurrent`, and because the slow steps (clang++ + running the binary) are async
child processes, several cases compile at once instead of blocking the event loop one at a time.
The per-file cap is set in [../vitest.config.ts](../vitest.config.ts) (`maxConcurrency`). Temp
paths embed the case name, so concurrent runs never collide. (This roughly halved the suite —
~12s → ~5s.)

## Adding a case

- Drop `cases/<name>.ts` and `cases/<name>.expected`.
- `.expected` must match stdout **exactly, including the trailing newline** — `console.log`
  emits `std::cout << expr << "\n"`, so a single `console.log(4)` expects `"4\n"`.
- Keep each case focused on one feature; name it after the feature.

## Multi-file (module) cases

The harness's `readdirSync(cases/)` is **non-recursive** and only discovers top-level `*.ts`, so
a multi-file case is: an entry `cases/<name>.ts` (discovered, with its `.expected`) that
`import`s helper modules living in the **`cases/modlib/`** subdirectory (not discovered → never run
as standalone cases, no `.expected` needed). Relative specifiers resolve from the importing file's
folder, e.g. the entry's `import { add } from "./modlib/math"` → `cases/modlib/math.ts`, and a
helper's `import { base } from "./base"` → `cases/modlib/base.ts`. The compiled entry's stdout
(which includes any top-level output from its dependencies, in dependency order) is diffed against
`<name>.expected` like any other case. The `module-*` cases exercise the model end to end: imported
functions/classes/consts, transitive chains, dependency-module top-level side effects, same-name
symbols scoped across modules (`module-scope` / `module-funcname`), and the memoized record with a
module-private variable read by the module's own function (`module-record`). Structural *rejections*
(cycles, unsupported import forms) and shape assertions (e.g. a collision is mangled apart, not
rejected) can't be runnable pairs, so they live in [modules.test.ts](modules.test.ts), which writes
temp files and asserts `loadProgram`'s behavior.

## Network cases (`fetch`)

`fetch` hits the network, so a fixed `cases/*.ts` + `.expected` pair would be flaky and
non-hermetic. Instead [fetch.test.ts](fetch.test.ts) stands up a localhost `http.Server` on an
**ephemeral port** (`listen(0)`) in `beforeAll`, then for each scenario writes a small program
(interpolating the server URL), compiles it via `driver.compileAsync`, runs the native binary,
and asserts stdout — fully hermetic (no real network). It covers status/`ok`/`text()`, `json()`
parsing (`await res.json() as T`), an HTTP-error status *resolving* with `ok === false` (not
rejecting), a transport error *rejecting* (caught by `try`/`catch`), and the bare-`res.json()`
clean error (`compileAsync` rejects). Each test allows a generous timeout — a fetch program
`#include`s `<curl/curl.h>`, so clang takes a moment.

## TDD loop (how this project is built)

1. Write the failing case first → `npm run test:watch` shows it **red**.
2. Implement across [../src/ir/nodes.ts](../src/ir/nodes.ts) →
   [../src/frontend/lower.ts](../src/frontend/lower.ts) →
   [../src/codegen/emit.ts](../src/codegen/emit.ts) until it's **green**.
3. The existing cases guard against regressions (they've already caught real ones).

## Commands

```bash
npm test            # run once (vitest run)
npm run test:watch  # watch mode
```
