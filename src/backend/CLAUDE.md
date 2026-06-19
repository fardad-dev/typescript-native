# src/backend/ — assemble + link (stage 4)

[clang.ts](clang.ts) takes the generated LLVM IR and produces the native binary.

- `buildExecutable(llPath, outPath)` shells out: `clang <llPath> -o <outPath>` (via
  `execFileSync`, inheriting stdio so clang's diagnostics reach the user).
- **`clang` compiles `.ll` directly** — it runs the LLVM backend + system assembler/linker
  itself, so there is **no separate `llc` or `opt` step** (and `llc` isn't installed here).

## Where the `.ll` comes from

[../driver.ts](../driver.ts) writes the IR to disk before calling this:
- with `--emit-llvm`: `<output>.ll`, kept beside the binary for inspection;
- otherwise: a temp file that's deleted after a successful build.

## Notes

- The emitted IR sets its own `target triple`, so clang needs no extra target flags. (It will
  warn `-Woverride-module` only if the triple mismatches the host — the emitted triple matches.)
- This stage is intentionally tiny. Future work (optimization levels, separate assemble vs link,
  linking a runtime once we have a heap) would live here.
