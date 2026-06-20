// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  // Files ESLint never looks at.
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src/codegen/cpp/**", // C++ runtime header
      "tests/cases/**", // compiler input fixtures (intentional TS-subset programs)
      "examples/**", // sample programs
    ],
  },

  // Base JS + TypeScript recommended rules.
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Compiler source and test suite (TypeScript, run on Node).
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Plain ESM scripts (no TypeScript-specific rules apply).
  {
    files: ["scripts/**/*.mjs", "benchmark/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Must come last: disables stylistic rules that would conflict with Prettier.
  prettier,
);
