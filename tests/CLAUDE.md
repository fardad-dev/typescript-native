# tests/ — end-to-end suite

The tests exercise the **whole pipeline**: compile a `.ts` program to a real native binary, run it,
and diff its stdout against an expected file. There are no unit tests — a green case means the source
actually compiled and executed correctly.

## Layout

```
tests/
  e2e.test.ts          the harness (vitest)
  typecheck.test.ts    stage-0 checker: type-erroneous programs are rejected
  modules.test.ts      module loader: graph rejections (cycles, collisions, …)
  fetch.test.ts        fetch: compile+run against a localhost server (network-hermetic)
  union.test.ts        union types: subset rejections (optional object fields, …)
  closures.test.ts     closures: subset rejections (async arrow, this-in-closure, …)
  destructure.test.ts  destructuring/spread/rest/default: subset rejections (object rest, …)
  cases/
    <name>.ts          a complete tsn program (the entry)
    <name>.expected    its exact expected stdout
    modlib/            helper modules imported by cases/ (see Multi-file cases)
```

## How the harness works ([e2e.test.ts](e2e.test.ts))

For every `cases/*.ts` it (1) compiles via `driver.compileAsync` (clang++ runs as a non-blocking child),
(2) runs the binary with async `execFile`, (3) asserts stdout `===` the matching `.expected`, (4) cleans
up. Cases are auto-discovered — **adding a pair is adding a test**. They use `it.concurrent`, so several
compile at once (cap in [../vitest.config.ts](../vitest.config.ts)); temp paths embed the case name so
concurrent runs never collide.

## Adding a case

- Drop `cases/<name>.ts` and `cases/<name>.expected`.
- `.expected` must match stdout **exactly, including the trailing newline** (`console.log` emits
  `std::cout << expr << "\n"`, so `console.log(4)` expects `"4\n"`).
- Keep each case focused on one feature; name it after the feature.

## Multi-file (module) cases

`readdirSync(cases/)` is **non-recursive**, so a multi-file case is an entry `cases/<name>.ts`
(discovered, with its `.expected`) that imports helper modules in **`cases/modlib/`** (not discovered →
never run standalone, no `.expected` needed). Relative specifiers resolve from the importing file's
folder. The compiled entry's stdout (incl. dependency top-level output, in dependency order) is diffed
against `<name>.expected`. The `module-*` cases exercise the model end to end. Structural *rejections*
(cycles, unsupported import forms) can't be runnable pairs, so they live in
[modules.test.ts](modules.test.ts), which writes temp files and asserts `loadProgram`'s behavior.

## Network cases (`fetch`)

`fetch` hits the network, so a fixed pair would be flaky. [fetch.test.ts](fetch.test.ts) stands up a
localhost `http.Server` on an ephemeral port (`listen(0)`), then per scenario writes a small program
(interpolating the URL), compiles + runs it, and asserts stdout — fully hermetic. It covers
status/`ok`/`text()`, `json()` parsing, an HTTP-error status *resolving* with `ok === false`, a
transport error *rejecting*, and the bare-`res.json()` clean error. Generous timeouts — a fetch program
`#include`s `<curl/curl.h>`, so clang takes a moment.

## TDD loop (how this project is built)

1. Write the failing case first → `npm run test:watch` shows it **red**.
2. Implement across [../src/ir/nodes.ts](../src/ir/nodes.ts) → [../src/frontend/lower.ts](../src/frontend/lower.ts)
   → [../src/codegen/emit.ts](../src/codegen/emit.ts) until it's **green**.
3. The existing cases guard against regressions.

## Commands

```bash
npm test            # run once (vitest run)
npm run test:watch  # watch mode
```
