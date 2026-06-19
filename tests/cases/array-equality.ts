// Reference equality on arrays: identity (same object), not structural contents.
let a: number[] = [1, 2, 3];
let b: number[] = [1, 2, 3];
let c = a;
console.log(a === b);
console.log(a === c);
console.log(a !== b);
console.log(a !== c);
