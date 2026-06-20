// `finally` runs on *every* exit from the try — normal completion, an early
// `return`, or an exception unwinding through it.

// finally runs even though the try `return`s.
function withReturn(): number {
  try {
    return 1;
  } finally {
    console.log("cleanup"); // prints before the value is returned to the caller
  }
}
console.log(withReturn());

// finally runs after a caught exception.
function withCatch(): string {
  try {
    throw "boom";
  } catch (e) {
    console.log(e); // boom
    return "handled";
  } finally {
    console.log("finally"); // runs as the function returns
  }
}
console.log(withCatch());

// try/finally with no catch: finally still runs, then the throw propagates and is
// caught by the outer try.
try {
  try {
    throw "inner";
  } finally {
    console.log("inner-finally");
  }
} catch (e) {
  console.log(e); // inner
}
