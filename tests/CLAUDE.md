# tests/ — end-to-end suite

The tests exercise the **whole pipeline**: compile a `.ts` program to a real native binary,
run it, and diff its stdout against an expected file. There are no unit tests — a green case
means the source actually compiled and executed correctly.

## Layout

```
tests/
  e2e.test.ts        # the harness (vitest)
  cases/
    <name>.ts        # a complete tsn program
    <name>.expected  # its exact expected stdout
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
