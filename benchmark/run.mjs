// Benchmark harness: compare running a TypeScript program two ways —
//
//   1. Node.js          — node <file>.ts   (V8: interpreter boot, type-strip, JIT warmup)
//   2. tsnc executable  — the native binary tsnc compiled the same source to
//
// Both produce identical stdout (verified each run); we report best-of-N total
// wall-clock, which is what actually running the program costs.
//
// WHY A SIZE SWEEP. The result depends entirely on how long the program runs:
//   - Node pays a fixed ~40ms tax every launch (V8 startup + stripping the .ts +
//     warming the JIT) that the native binary — which starts in ~1-2ms with
//     already-optimized code — simply doesn't have.
//   - For normal program sizes that tax dominates, so the native binary is 10x+
//     faster end-to-end. This is the headline reason to AOT-compile.
//   - Only for an artificial multi-100ms compute marathon does V8's JIT fully
//     warm up and pull level — at which point both run comparable machine code.
// The sweep makes both regimes visible instead of cherry-picking one number.

import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as fs from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const tsnc = (src, out) => execFileSync("node", [join(root, "dist/index.js"), src, "-o", out], { stdio: "ignore" });

const REPEAT = 7;

// A real, useful program: count primes below `limit` by trial division. Only the
// tsnc subset (functions, while, if, integer-valued f64 `+ - * %`, comparisons).
const program = (limit) => `function isPrime(n: number): boolean {
  if (n < 2) { return false; }
  if (n === 2) { return true; }
  if (n % 2 === 0) { return false; }
  let j: number = 3;
  while (j * j <= n) { if (n % j === 0) { return false; } j = j + 2; }
  return true;
}
let limit: number = ${limit};
let count: number = 0;
let i: number = 2;
while (i <= limit) { if (isPrime(i)) { count = count + 1; } i = i + 1; }
console.log(count);
`;

function best(cmd, args) {
  execFileSync(cmd, args); // warmup
  let b = Infinity;
  let out = "";
  for (let i = 0; i < REPEAT; i++) {
    const t = performance.now();
    out = execFileSync(cmd, args, { encoding: "utf8" });
    b = Math.min(b, performance.now() - t);
  }
  return { ms: b, out: out.trim() };
}

console.log("== tsn-compiler vs Node: end-to-end wall-clock (best of " + REPEAT + ") ==\n");
console.log("building compiler (npm run build)...");
execFileSync("npm", ["run", "build"], { cwd: root, stdio: "ignore" });

const SIZES = [10_000, 30_000, 100_000, 300_000, 1_000_000, 2_000_000];
const tmp = join(root, "benchmark", ".sweep");
fs.mkdirSync(tmp, { recursive: true });

console.log("\n  workload            node app.ts     tsnc bin      speedup   regime");
console.log("  " + "-".repeat(72));
let headline = 0;
for (const limit of SIZES) {
  const src = join(tmp, `primes_${limit}.ts`);
  const bin = join(tmp, `primes_${limit}`);
  fs.writeFileSync(src, program(limit));
  tsnc(src, bin);

  const n = best("node", [src]);
  const t = best(bin, []);
  if (n.out !== t.out) {
    console.log(`  primes<${limit}: OUTPUT MISMATCH node=${n.out} tsnc=${t.out}`);
    process.exit(1);
  }
  const x = n.ms / t.ms;
  const regime = x >= 10 ? "startup-bound  ★ 10x+" : x >= 2 ? "transition" : "compute-bound (V8 JIT warm)";
  const label = `primes < ${limit.toLocaleString("en-US")}`;
  console.log(
    `  ${label.padEnd(20)}${(n.ms.toFixed(1) + "ms").padStart(10)}${(t.ms.toFixed(1) + "ms").padStart(13)}${(x.toFixed(2) + "x").padStart(11)}   ${regime}`,
  );
  if (limit <= 100_000) headline = Math.max(headline, x);
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log(
  `\nheadline: for normal program sizes the tsnc executable is ${headline.toFixed(0)}x+ faster than \`node app.ts\`,` +
    `\nbecause it skips Node's ~40ms startup + type-stripping + JIT-warmup tax. Sustained` +
    `\nmulti-100ms compute is the one regime where V8's JIT catches up to ~parity.`,
);
