// Post-build step: copy the fixed C++ runtime (src/codegen/cpp/) into dist.
//
// `tsc` only transpiles .ts (tsconfig `include: ["src/**/*.ts"]`), so the
// hand-written C++ header never reaches dist on its own. The emitter resolves
// the header relative to its own location (`${__dirname}/cpp/tsn_runtime.h`, see
// src/codegen/emit.ts), so the installed CLI running from dist needs the folder
// mirrored there. The published package ships only `dist` (package.json
// `files`), so this is also what makes the runtime available to consumers.
import { cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "codegen", "cpp");
const dst = join(root, "dist", "codegen", "cpp");

cpSync(src, dst, { recursive: true });
console.log(`copied runtime: ${src} -> ${dst}`);
