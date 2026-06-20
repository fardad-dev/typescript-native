// Two helper modules (red, blue) each declare a top-level `const color` and a
// function that reads it. The names collide across modules but are scoped per
// module (mangled), and each function reads ITS OWN module's `color`.
const color = "red";

export function red(): string {
  return color;
}
