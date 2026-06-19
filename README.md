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

- **macOS on Apple Silicon (arm64)** — the only configuration that's tested.
- **Node.js ≥ 22**
- **`clang++`** on your `PATH` — install the Xcode Command Line Tools if you don't have it:
  ```bash
  xcode-select --install
  ```
  The compiler emits C++; `clang++` compiles + links it into the final binary.

## Usage

Run it without installing anything via `npx` (use the package name, `tsn-compiler`):

```bash
npx tsn-compiler <file.ts> [-o <output>] [--emit-cpp]
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
| `--emit-cpp`          | Also write the generated C++ to `<output>.cpp` for inspection.    |
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

Want to see the generated C++? Add `--emit-cpp`:

```bash
npx tsn-compiler hello.ts -o hello --emit-cpp
cat hello.cpp
```

## Supported language

The goal is a small but complete pipeline. These features compile and run today:

- **Types:** `number`, `boolean`, `string`, number/string **arrays** (`T[]`), and object
  literals with typed fields (`{ x: number; y: number }`).
- **`console.log(...)`** for numbers, booleans, and strings.
- **Arithmetic:** `+ - * / %` (`number` is IEEE double, so `5 / 2 === 2.5`)
- **Comparisons & logic:** `< <= > >= === !==`, `&& || !`
- **Strings:** literals and concatenation (`"a" + b`; numbers coerce, e.g. `"n=" + 5`)
- **Variables:** `let` / `const` (the type is inferred when you omit the annotation; `var` is
  not supported), assignment (`x = e`, `a[i] = e`, `obj.f = e`, `+=`, `i++`)
- **Control flow:** `if` / `else`, `while`, `for`
- **Functions:** top-level, typed params + return type, `return`, and calls (recursion works)
- **Arrays:** literals (incl. empty `[]`), indexing (`xs[i]`, computed indices), `.length`, `.push(v)`
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

> `console.log` currently takes **exactly one argument**. A `let`/`const` without a type
> annotation infers its type from the initializer — an integer literal like `const a = 12`
> compiles to `int a = 12`, a decimal to `double`, and so on.

### Notes & limitations

- **`number` is an IEEE `double`** (printed JS-style, shortest round-trip) — e.g. `20 / 6`
  prints `3.3333333333333335`. Functions and object fields still accept **scalars only**
  (`number`/`boolean`/`string`) — arrays/objects can't be passed or returned yet.
- **`var` is not supported** (and never will be) — use `let` or `const`.
- **Out of scope for now:** `null`/`undefined`, classes, closures, exceptions, `async`,
  modules, generics, union/`any` types, and garbage collection.
- **Target is macOS arm64 only.** Other platforms aren't supported yet.

## How it works

The compiler runs four stages (see [`src/`](src/)):

1. **Parse** — the official `typescript` package parses your source into a TypeScript AST.
2. **Lower** — that AST is lowered into a small, typed internal IR ([`src/ir/nodes.ts`](src/ir/nodes.ts)).
3. **Codegen** — the IR is emitted as **C++ source** ([`src/codegen/emit.ts`](src/codegen/emit.ts)).
4. **Build** — `clang++` compiles + links the `.cpp` into a native executable ([`src/backend/clang.ts`](src/backend/clang.ts)).

## Development

```bash
git clone https://github.com/fardad-dev/typescript-native.git
cd typescript-native
npm install          # also builds dist/ via the prepare script

npm run build        # compile the compiler (tsc -> dist/)
npm test             # compile each tests/cases/*.ts, run it, diff against *.expected

# run the local build directly without a global install
node dist/index.js examples/test1.ts -o out --emit-cpp && ./out
```

Each language feature has a `tests/cases/<name>.ts` input paired with a `<name>.expected`
stdout file; [`tests/e2e.test.ts`](tests/e2e.test.ts) compiles, runs, and diffs them.

## License

MIT — see [LICENSE](LICENSE).
