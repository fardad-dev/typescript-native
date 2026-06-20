// `throw` a string (the subset throws strings; `throw new Error(msg)` throws msg),
// caught by `catch (e)` where `e` is bound as a string.
function risky(n: number): string {
  if (n < 0) {
    throw "negative input";
  }
  return "ok";
}

try {
  console.log(risky(5)); // ok
  console.log(risky(-1)); // throws -> skips the rest of the try
  console.log("unreached");
} catch (e) {
  console.log(e); // negative input
}
console.log("after"); // execution continues after the try

// `throw new Error(msg)` is supported as a synonym for throwing the message.
try {
  throw new Error("boom");
} catch (e) {
  console.log(e); // boom
}
