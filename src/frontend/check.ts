// Stage 0: semantic type-checking with a real `ts.Program` + TypeChecker.
//
// Before we lower the AST (which only reads annotations) and emit C++, we run
// the official TypeScript checker over the program and abort on any type error.
// This catches the mistakes our emitter's local checks miss — wrong assignment
// types, undeclared identifiers, bad argument counts/types, property access on
// the wrong type — and reports them with TypeScript-quality diagnostics, rather
// than emitting bad C++ or surfacing a cryptic `tsnc:` message late.
//
// We build the Program over an in-memory copy of the source (the driver already
// read it) plus a tiny ambient declaration of `console`. We deliberately load
// only the ES2020 lib — NOT the DOM lib — so the hundreds of DOM globals can't
// shadow a user's top-level names; `console` is the one global the subset needs.

import * as ts from "typescript";

// A virtual file declaring the globals the tsn subset relies on. `log` takes any
// args so `console.log(x)` type-checks for every value type in the subset.
const GLOBALS_FILE = "__tsn_globals__.d.ts";
const GLOBALS_SOURCE = `declare var console: { log(...data: any[]): void; };\n`;

// Strict checking on the ES2020 lib. `strict` turns on the full suite of sound
// checks (noImplicitAny, strictNullChecks, …); the unused-local/parameter checks
// are intentionally left off (not part of `strict`), since focused example
// programs routinely leave a binding unused.
const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2020,
  lib: ["lib.es2020.d.ts"],
  types: [],
  noEmit: true,
  strict: true,
  skipLibCheck: true,
  // Multi-file programs: resolve relative `import`s (`./x` -> `x.ts`) so the
  // checker pulls in and type-checks the whole module graph from disk. Bundler
  // resolution accepts the extensionless TS convention; allowImportingTsExtensions
  // (legal under noEmit) also accepts an explicit `./x.ts`.
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
};

// Type-check `source` (already read for `fileName`). Throws on the first batch of
// diagnostics with a formatted, line/column-annotated message; returns normally
// when the program is type-clean. Subset-specific rejections (e.g. `var`) still
// happen later, in lowering — this stage only enforces TypeScript's semantics.
export function typeCheck(fileName: string, source: string): void {
  const host = ts.createCompilerHost(OPTIONS, /*setParentNodes*/ true);

  // Serve the in-memory globals + source for their virtual/real names; delegate
  // everything else (the lib files) to the default on-disk host.
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
    if (name === GLOBALS_FILE)
      return ts.createSourceFile(name, GLOBALS_SOURCE, languageVersion, true);
    if (name === fileName)
      return ts.createSourceFile(name, source, languageVersion, true);
    return getSourceFile(name, languageVersion, onError, shouldCreate);
  };
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) =>
    name === GLOBALS_FILE || name === fileName || fileExists(name);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) =>
    name === GLOBALS_FILE
      ? GLOBALS_SOURCE
      : name === fileName
        ? source
        : readFile(name);

  const program = ts.createProgram([GLOBALS_FILE, fileName], OPTIONS, host);
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => !d.file || d.file.fileName !== GLOBALS_FILE);

  if (diagnostics.length > 0) {
    const formatHost: ts.FormatDiagnosticsHost = {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
      getNewLine: () => "\n",
    };
    const formatted = ts
      .formatDiagnosticsWithColorAndContext(diagnostics, formatHost)
      .trimEnd();
    throw new Error(`type error(s):\n${formatted}`);
  }
}
