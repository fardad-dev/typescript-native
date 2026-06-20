// A helper module: imported by ../module-function.ts. Lives in a subdirectory so
// the e2e harness (non-recursive readdirSync over cases/) does not treat it as a
// standalone case needing its own .expected.
export function add(a: number, b: number): number {
  return a + b;
}

export function mul(a: number, b: number): number {
  return a * b;
}
