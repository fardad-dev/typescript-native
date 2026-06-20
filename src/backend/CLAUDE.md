# src/backend/ — compile + link (stage 4)

[clang.ts](clang.ts) takes the generated C++ and produces the native binary.

- `buildExecutable(cppPath, outPath, extra?)` shells out: `clang++ -std=c++20 <cppPath> -o
  <outPath> <extra…>` (via `execFileSync`, inheriting stdio so clang++'s diagnostics reach the
  user). `extra` are extra trailing args — currently link libraries the program needs (the driver
  passes `["-lcurl"]` when it uses `fetch`, `[]` otherwise, so a non-fetch link line is unchanged).
- `clang++` compiles + links in one step (it drives the C++ frontend, optimizer, assembler,
  and linker), so there's no separate codegen/assemble/link tooling to manage here.

## Where the `.cpp` comes from

[../driver.ts](../driver.ts) writes the C++ to disk before calling this:
- with `--emit-cpp`: `<output>.cpp`, kept beside the binary for inspection;
- otherwise: a temp file that's deleted after a successful build.

## Notes

- We pin `-std=c++20` (was `-std=c++17`): besides `std::vector`/`std::string`/brace-init/
  `static_cast`, async/await compiles to **C++20 coroutines** (`co_await`/`co_return`, an async
  function's `tsn_promise<T>` return type with a `promise_type`). Apple clang 17 enables them under
  `-std=c++20` with no extra flag.
- This stage is intentionally tiny. Future work (optimization flags `-O2`, choosing a compiler,
  linking extra runtime support) would live here.
