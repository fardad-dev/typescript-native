// Two-step async functions awaited in sequence: each suspends at its internal
// await (Promise.resolve), so the continuation interleaves with the synchronous
// top-level exactly as V8 schedules it.
async function tick(label: string): Promise<void> {
  console.log(label + "-1");
  await Promise.resolve(0);
  console.log(label + "-2");
}

async function run(): Promise<void> {
  await tick("a");
  await tick("b");
}

run();
console.log("sync");
