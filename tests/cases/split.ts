let s: string = "a,b,c";
let parts: string[] = s.split(",");
console.log(parts.length);
console.log(parts[0]);
console.log(parts[1]);
console.log(parts[2]);

// empty separator -> single characters
let cs: string[] = "hi".split("");
console.log(cs.length);
console.log(cs[0]);

// separator not found -> one-element array of the whole string
let nf: string[] = "abc".split("x");
console.log(nf.length);
console.log(nf[0]);

// consecutive separators -> empty pieces
let cc: string[] = "a,,b".split(",");
console.log(cc.length);
console.log(cc[1]);

// limit caps the number of pieces
let lim: string[] = "1 2 3 4".split(" ", 2);
console.log(lim.length);
console.log(lim[1]);
