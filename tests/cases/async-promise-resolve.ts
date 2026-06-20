// `await Promise.resolve(x)` — a promise already fulfilled with x.
async function run(): Promise<void> {
  const n = await Promise.resolve(7);
  const s = await Promise.resolve("x");
  console.log(n + 1);
  console.log(s + "y");
}

run();
