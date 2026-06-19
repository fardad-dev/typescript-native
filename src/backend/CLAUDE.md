# src/backend/ — compile + link (stage 4)

[clang.ts](clang.ts) takes the generated C++ and produces the native binary.

- `buildExecutable(cppPath, outPath)` shells out: `clang++ -std=c++17 <cppPath> -o <outPath>`
  (via `execFileSync`, inheriting stdio so clang++'s diagnostics reach the user).
- `clang++` compiles + links in one step (it drives the C++ frontend, optimizer, assembler,
  and linker), so there's no separate codegen/assemble/link tooling to manage here.

## Where the `.cpp` comes from

[../driver.ts](../driver.ts) writes the C++ to disk before calling this:
- with `--emit-cpp`: `<output>.cpp`, kept beside the binary for inspection;
- otherwise: a temp file that's deleted after a successful build.

## Notes

- We pin `-std=c++17` (the generated code uses `std::vector`, `std::string`, brace/aggregate
  init, `static_cast`).
- This stage is intentionally tiny. Future work (optimization flags `-O2`, choosing a compiler,
  linking extra runtime support) would live here.
