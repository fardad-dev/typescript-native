// A `throw` inside an async function rejects its promise; awaiting a rejected
// promise re-throws, caught by an ordinary try/catch (and finally still runs).
async function failing(): Promise<number> {
  throw "nope";
}

async function run(): Promise<void> {
  try {
    const v = await failing();
    console.log("unreachable " + v);
  } catch (e) {
    console.log("caught " + e);
  } finally {
    console.log("cleanup");
  }
}

run();
