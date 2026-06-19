// Round-trip the roadmap use case: tokenize a sentence, then reassemble it.
let sentence: string = "the quick brown fox";
let words: string[] = sentence.split(" ");
console.log(words.length);

let rejoined: string = words.join("_");
console.log(rejoined);

// mutate a token, then join back with the original separator
words[0] = "THE";
console.log(words.join(" "));
