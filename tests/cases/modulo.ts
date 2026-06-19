// Guards tsn_mod against JS `%` semantics across its two paths:
//   - integer-valued operands -> fast hardware integer-remainder path
//   - a fractional operand     -> std::fmod fallback (5.5 % 2 === 1.5)
console.log(20 % 6);
console.log(10 % 2);
console.log(1000003 % 17);
console.log(5.5 % 2);
console.log(7 % 2.5);
