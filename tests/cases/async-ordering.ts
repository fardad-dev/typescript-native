// The microtask-deferral signature: code after an `await` runs *after* the
// synchronous caller continues — matching Node/V8 exactly (not synchronously).
async function inner(): Promise<void> {
  console.log("inner");
}

async function outer(): Promise<void> {
  console.log("outer-before");
  await inner();
  console.log("outer-after");
}

console.log("script-start");
outer();
console.log("script-end");
