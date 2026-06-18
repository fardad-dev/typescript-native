#!/usr/bin/env node
// tsnc — the `tsn` native compiler CLI.
//   tsnc <file.ts> [-o out] [--emit-llvm]

import * as path from "path";
import { compile, Options } from "./driver";

function parseArgs(argv: string[]): Options {
  let input: string | undefined;
  let output: string | undefined;
  let emitLlvm = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o") {
      output = argv[++i];
    } else if (a === "--emit-llvm") {
      emitLlvm = true;
    } else if (!a.startsWith("-")) {
      input = a;
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }

  if (!input) {
    console.error("usage: tsnc <file.ts> [-o out] [--emit-llvm]");
    process.exit(1);
  }
  if (!output) {
    output = path.basename(input, path.extname(input));
  }
  return { input, output, emitLlvm };
}

function main(): void {
  try {
    compile(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(`tsnc: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
