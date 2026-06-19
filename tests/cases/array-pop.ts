let xs: number[] = [10, 20, 30];
let last = xs.pop();
console.log(last); // 30
console.log(xs.length); // 2
xs.pop(); // statement form: discards 20
console.log(xs.length); // 1
console.log(xs[0]); // 10

let words: string[] = ["a", "b", "c"];
let w = words.pop();
console.log(w); // c
console.log(words.length); // 2

const obj = { name: "1" };

const arr: { name: string }[] = [{ name: "3" }, { name: "2" }, obj];
let lastObj = arr.pop();
console.log(lastObj === obj);
let middleObj = arr.pop();
console.log(middleObj === obj);
