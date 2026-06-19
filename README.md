# tsnc

An **ahead-of-time (AOT) compiler** that turns a subset of **TypeScript** into a standalone
**native executable** — the way C++ or Rust do. There's no Node, V8, or JIT at runtime: the
output is a self-contained binary.

```
.ts source ──▶ native executable
```

> This is a learning-oriented compiler. It favors a clear, working end-to-end pipeline over
> feature breadth. See the [language scope](#supported-language) below for exactly what compiles.

## Requirements

- **macOS on Apple Silicon (arm64)** — the compiler emits the `arm64-apple-macosx` target only.
- **Node.js ≥ 22**
- **`clang`** on your `PATH` — install the Xcode Command Line Tools if you don't have it:
  ```bash
  xcode-select --install
  ```
  `clang` does the final assemble + link step (no separate `llc`/`opt` needed).

## Usage

Run it without installing anything via `npx` (use the package name, `tsn-compiler`):

```bash
npx tsn-compiler <file.ts> [-o <output>] [--emit-llvm]
```

Or install it globally — the command it installs is `tsnc`:

```bash
npm install -g tsn-compiler
tsnc <file.ts>
```

### Options

| Option                | Description                                                       |
| --------------------- | ----------------------------------------------------------------- |
| `-o, --output <path>` | Output executable path. Defaults to the source file's basename.   |
| `--emit-llvm`         | Also write the generated LLVM IR to `<output>.ll` for inspection. |
| `-h, --help`          | Show help.                                                        |

## Quick start

Create `hello.ts`:

```ts
console.log(20 + 22);
```

Compile and run it:

```bash
npx tsn-compiler hello.ts -o hello
./hello
# 42
```

Want to see the generated LLVM IR? Add `--emit-llvm`:

```bash
npx tsn-compiler hello.ts -o hello --emit-llvm
cat hello.ll
```

## Supported language

The goal is a small but complete pipeline. These features compile and run today:

- **Types:** `number`, `boolean`, `string`, number/string **arrays** (`T[]`), and object
  literals with typed fields (`{ x: number; y: number }`).
- **`console.log(...)`** for numbers, booleans, and strings.
- **Arithmetic:** `+ - * / %`
- **Comparisons & logic:** `< <= > >= === !==`, `&& || !`
- **Variables:** `let` / `const`, assignment
- **Control flow:** `if` / `else`, `while`, `for`
- **Functions:** top-level, typed params + return type, `return`, and calls
- **Arrays:** literals, indexing (`xs[i]`, including computed indices), `.length`
- **Objects:** literals and field access (`p.x`)

```ts
function square(n: number): number {
  return n * n;
}
function sumOfSquares(a: number, b: number): number {
  return square(a) + square(b);
}
console.log(sumOfSquares(3, 4)); // 25

let xs: number[] = [10, 20, 30];
console.log(xs[0]); // 10
console.log(xs.length); // 3

let p: { x: number; y: number } = { x: 3, y: 4 };
console.log(p.x + p.y); // 7
```

> `console.log` currently takes **exactly one argument**, and `let`/`const` declarations whose
> initializer isn't a `number` need an explicit type annotation.

### Notes & limitations

- **`number` is a 64-bit integer (`i64`)**, not IEEE `double`. This is a deliberate v1
  simplification, so integer division truncates — e.g. `20 / 6` prints `3`, not `3.333…`.
- **Out of scope for now:** `null`/`undefined`, classes, closures, exceptions, `async`,
  modules, generics, union/`any` types, and garbage collection.
- **Target is macOS arm64 only.** Other platforms aren't supported yet.

## How it works

The compiler runs four stages (see [`src/`](src/)):

1. **Parse** — the official `typescript` package parses your source into a TypeScript AST.
2. **Lower** — that AST is lowered into a small, typed internal IR ([`src/ir/nodes.ts`](src/ir/nodes.ts)).
3. **Codegen** — the IR is emitted as textual **LLVM IR** ([`src/codegen/emit.ts`](src/codegen/emit.ts)), using opaque pointers.
4. **Build** — `clang` assembles + links the `.ll` into a native executable ([`src/backend/clang.ts`](src/backend/clang.ts)).

## Development

```bash
git clone https://github.com/fardad-dev/typescript-native.git
cd typescript-native
npm install          # also builds dist/ via the prepare script

npm run build        # compile the compiler (tsc -> dist/)
npm test             # compile each tests/cases/*.ts, run it, diff against *.expected

# run the local build directly without a global install
node dist/index.js examples/test1.ts -o out --emit-llvm && ./out
```

Each language feature has a `tests/cases/<name>.ts` input paired with a `<name>.expected`
stdout file; [`tests/e2e.test.ts`](tests/e2e.test.ts) compiles, runs, and diffs them.

## License

MIT — see [LICENSE](LICENSE).
