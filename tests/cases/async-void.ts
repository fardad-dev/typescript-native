// A Promise<void> async function (no resolved value), awaited for its side effects.
async function greet(name: string): Promise<void> {
  console.log("hello " + name);
}

async function run(): Promise<void> {
  await greet("a");
  await greet("b");
  console.log("done");
}

run();
