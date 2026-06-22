import { describe, it, expect } from "vitest";
import { lower } from "../src/frontend/lower";

// Uninitialized declarations that COMPILE-AND-RUN (`let x: T;` then assign) are
// covered by the e2e harness (tests/cases/declare-uninit.ts). This file covers
// the sub-case the subset deliberately REJECTS at lowering: a declaration with
// neither an initializer NOR a type annotation has no source for its type (the
// subset has no `any`), so it must produce a clear `tsnc:` message.
//
// `const x;` is already a TS stage-0 error ("must be initialized"), so it never
// reaches lowering and is not covered here.

const FILE = "/virtual/case.ts";
const lowerSrc = (src: string) => lower(FILE, src);

describe("uninitialized declarations: subset rejections", () => {
  it("rejects a declaration with neither initializer nor annotation", () => {
    expect(() => lowerSrc(`let x;\nx = 5;`)).toThrow(/needs a type annotation/);
  });
});
