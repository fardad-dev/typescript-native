// Strings are immutable. Copying one shares its ref-counted buffer under the
// hood (see tsn_str in codegen), so this checks that deriving a new value from a
// copy never mutates the original it was copied from — i.e. the sharing is
// invisible and value semantics hold.

// 1) copy a variable, then rebind the source to a derived value.
let a: string = "hello";
let b: string = a; // b copies a (aliases the same buffer)
a = a + " world"; // a is rebound to a NEW string; b must be untouched
console.log(a); // hello world
console.log(b); // hello

// 2) a method returns a new string; the receiver is unchanged.
let original: string = "Title";
let shout: string = original.toUpperCase();
console.log(shout); // TITLE
console.log(original); // Title

// 3) same guarantee for an element copied out of an array.
let words: string[] = ["alpha", "beta"];
let kept: string = words[0]; // copy of element 0
words[0] = words[0] + "!"; // the slot is rebound to a new string
console.log(words[0]); // alpha!
console.log(kept); // alpha
