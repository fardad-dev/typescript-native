// An exported async function, imported by the `module-async` case.
export async function asyncAdd(a: number, b: number): Promise<number> {
  return a + b;
}

export async function asyncDouble(n: number): Promise<number> {
  const sum = await asyncAdd(n, n);
  return sum;
}
