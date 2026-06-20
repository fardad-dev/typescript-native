// Broader String.prototype methods: search, padding, trimming, repeat, replace.
const s = "Hello, World";
console.log(s.includes("World"));
console.log(s.includes("xyz"));
console.log(s.startsWith("Hello"));
console.log(s.endsWith("World"));
console.log(s.lastIndexOf("o"));
console.log("ab".repeat(3));
console.log("  trim me  ".trim());
console.log("  left".trimStart());
console.log("right  ".trimEnd());
console.log("5".padStart(3, "0"));
console.log("5".padEnd(3, "0"));
console.log("42".padStart(5));
console.log("a-b-c".replace("-", "+"));
console.log("a-b-c".replaceAll("-", "+"));
console.log("foo".concat("bar", "baz"));
