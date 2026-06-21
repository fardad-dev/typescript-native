// A default-exported function (a named declaration that is also the default),
// plus a named export alongside it. Imported by ../module-default.ts.
export default function square(n: number): number {
  return n * n;
}

export const LABEL = "sq";
