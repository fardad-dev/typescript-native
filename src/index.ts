#!/usr/bin/env node
// tsnc — the `tsn` native compiler CLI.
//   tsnc <file.ts> [-o out] [--emit-cpp]

import * as path from "path";
import { Command } from "commander";
import { compile } from "./driver";

const program = new Command();

program
  .name("tsnc")
  .description("tsn native compiler: a TypeScript subset -> native executable")
  .argument("<file>", "TypeScript source file to compile")
  .option("-o, --output <path>", "output executable path (defaults to the source basename)")
  .option("--emit-cpp", "also write the generated C++ source alongside the binary", false)
  .action((file: string, opts: { output?: string; emitCpp: boolean }) => {
    const output = opts.output ?? path.basename(file, path.extname(file));
    try {
      compile({ input: file, output, emitCpp: opts.emitCpp });
    } catch (err) {
      console.error(`tsnc: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program.parse();
