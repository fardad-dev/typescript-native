// Stage 3: lower our internal IR to C++ source text.
//
// C++ is a high-level target, so codegen is expression-based: emitExpr returns a
// C++ expression string (e.g. "(a + b)", "xs[i]", "p.x", "add(2, 3)") rather than
// breaking everything into temporaries. The C++ compiler (clang++) then does the
// real lowering to machine code, and enforces that non-void functions return
// (we pass -Werror=return-type in the backend).
//
// Type mapping (chosen to preserve the previous backend's observable behavior):
//   number  -> long long      (64-bit integer; integer division, as before)
//   boolean -> bool           (std::cout prints 1/0)
//   string  -> std::string    (literals are const char*, convert implicitly)
//   T[]     -> std::vector<T>  (heap-backed; .length -> .size())
//   { ... } -> a generated `struct` (one per distinct field shape)

import {
  Module,
  Expr,
  Stmt,
  BinaryOp,
  Type,
  Field,
  Func,
  RetType,
} from "../ir/nodes";

// C++ operator text for each IR binary op (=== / !== map to == / !=).
const CPP_OP: Record<BinaryOp, string> = {
  "+": "+",
  "-": "-",
  "*": "*",
  "/": "/",
  "%": "%",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
  "===": "==",
  "!==": "!=",
  "&&": "&&",
  "||": "||",
};

const ARITH = new Set<BinaryOp>(["+", "-", "*", "/", "%"]);
const RELATIONAL = new Set<BinaryOp>(["<", "<=", ">", ">="]);
const EQUALITY = new Set<BinaryOp>(["===", "!=="]);

type ArrayType = { kind: "array"; element: Type };
type ObjectType = { kind: "object"; fields: Field[] };

function isArray(t: Type): t is ArrayType {
  return typeof t === "object" && t.kind === "array";
}
function isObject(t: Type): t is ObjectType {
  return typeof t === "object" && t.kind === "object";
}
function isAggregate(t: Type): boolean {
  return isArray(t) || isObject(t);
}

function displayType(t: RetType): string {
  if (t === "void") return "void";
  if (isArray(t)) return `${displayType(t.element)}[]`;
  if (isObject(t)) {
    return `{ ${t.fields.map((f) => `${f.name}: ${displayType(f.type)}`).join("; ")} }`;
  }
  return t;
}

function sameType(a: Type, b: Type): boolean {
  if (isArray(a) && isArray(b)) return sameType(a.element, b.element);
  if (isObject(a) && isObject(b)) {
    if (a.fields.length !== b.fields.length) return false;
    // Structural, order-independent: match fields by name.
    return a.fields.every((fa) => {
      const fb = b.fields.find((f) => f.name === fa.name);
      return fb !== undefined && sameType(fa.type, fb.type);
    });
  }
  if (isAggregate(a) || isAggregate(b)) return false;
  return a === b;
}

// An emitted value: its C++ expression text and the tsn type it represents.
interface Value {
  code: string;
  type: Type;
}

interface Sig {
  params: Type[];
  ret: RetType;
}

export function emit(mod: Module): string {
  return new Emitter().emitModule(mod);
}

class Emitter {
  // Module-level state.
  private sigs = new Map<string, Sig>();
  private structDefs: string[] = []; // generated `struct ... { ... };` lines
  private structNames = new Map<string, string>(); // field-shape key -> struct name

  // Per-function scratch, reset by resetForFunction().
  private body: string[] = [];
  private vars = new Map<string, Type>();
  private curReturn: RetType = "void";
  private indent = "  ";

  emitModule(mod: Module): string {
    // First pass: collect signatures so calls can reference any function.
    for (const fn of mod.functions) {
      if (this.sigs.has(fn.name))
        throw new Error(`Duplicate function '${fn.name}'`);
      this.sigs.set(fn.name, {
        params: fn.params.map((p) => p.type),
        ret: fn.returnType,
      });
    }

    // Emit bodies first — this populates structDefs as object types are seen.
    const protos = mod.functions.map((fn) => this.prototype(fn));
    const defs = mod.functions.map((fn) => this.emitFunction(fn));
    const mainDef = this.emitMain(mod.main);

    return [
      `#include <array>`,
      `#include <cctype>`,
      `#include <charconv>`,
      `#include <cmath>`,
      `#include <iostream>`,
      `#include <string>`,
      `#include <vector>`,
      ``,
      // `number` is a double; print it JS-style (shortest round-trip, integers
      // without a trailing ".0") via std::to_chars.
      `static std::string tsn_num_to_string(double v) {`,
      `  std::array<char, 32> buf;`,
      `  auto res = std::to_chars(buf.data(), buf.data() + buf.size(), v);`,
      `  return std::string(buf.data(), res.ptr);`,
      `}`,
      ``,
      // JS `%` on an f64. Fast path: when both operands are integer-valued and in
      // the exactly-representable range, use the CPU's integer remainder (one
      // instruction) instead of std::fmod (a libm call that dominated hot loops).
      // The range guard makes the long long casts well-defined; the `== a` checks
      // confirm both operands were integral. Otherwise fall back to true fmod.
      // All three (int %, fmod, JS %) truncate toward zero, so results agree.
      `static inline double tsn_mod(double a, double b) {`,
      `  if (b != 0.0 && std::fabs(a) < 9007199254740992.0 &&`,
      `      std::fabs(b) < 9007199254740992.0) {`,
      `    long long ia = (long long)a, ib = (long long)b;`,
      `    if ((double)ia == a && (double)ib == b) return (double)(ia % ib);`,
      `  }`,
      `  return std::fmod(a, b);`,
      `}`,
      ``,
      // String methods, matching JS String.prototype semantics. Indices are JS
      // numbers (doubles): NaN (the sentinel an omitted optional arg lowers to)
      // means "default"; otherwise truncate toward zero, then clamp. substring
      // clamps negatives to 0 and swaps a start > end; slice counts negatives
      // from the end. indexOf returns a 0-based position or -1.
      `static std::string tsn_substring(const std::string& s, double startD, double endD) {`,
      `  long long len = (long long)s.size();`,
      `  long long start = std::isnan(startD) ? 0 : (long long)startD;`,
      `  long long end = std::isnan(endD) ? len : (long long)endD;`,
      `  if (start < 0) start = 0;`,
      `  if (end < 0) end = 0;`,
      `  if (start > len) start = len;`,
      `  if (end > len) end = len;`,
      `  if (start > end) { long long t = start; start = end; end = t; }`,
      `  return s.substr((std::size_t)start, (std::size_t)(end - start));`,
      `}`,
      ``,
      `static std::string tsn_slice(const std::string& s, double startD, double endD) {`,
      `  long long len = (long long)s.size();`,
      `  long long start = std::isnan(startD) ? 0 : (long long)startD;`,
      `  long long end = std::isnan(endD) ? len : (long long)endD;`,
      `  if (start < 0) start = len + start;`,
      `  if (end < 0) end = len + end;`,
      `  if (start < 0) start = 0;`,
      `  if (end < 0) end = 0;`,
      `  if (start > len) start = len;`,
      `  if (end > len) end = len;`,
      `  if (start >= end) return std::string();`,
      `  return s.substr((std::size_t)start, (std::size_t)(end - start));`,
      `}`,
      ``,
      `static double tsn_index_of(const std::string& s, const std::string& sub, double fromD) {`,
      `  long long from = std::isnan(fromD) ? 0 : (long long)fromD;`,
      `  if (from < 0) from = 0;`,
      `  if (from > (long long)s.size()) return sub.empty() ? (double)s.size() : -1.0;`,
      `  std::size_t pos = s.find(sub, (std::size_t)from);`,
      `  return pos == std::string::npos ? -1.0 : (double)pos;`,
      `}`,
      ``,
      `static std::string tsn_char_at(const std::string& s, double idxD) {`,
      `  long long i = std::isnan(idxD) ? 0 : (long long)idxD;`,
      `  if (i < 0 || i >= (long long)s.size()) return std::string();`,
      `  return std::string(1, s[(std::size_t)i]);`,
      `}`,
      ``,
      `static double tsn_char_code_at(const std::string& s, double idxD) {`,
      `  long long i = std::isnan(idxD) ? 0 : (long long)idxD;`,
      `  if (i < 0 || i >= (long long)s.size()) return NAN;`,
      `  return (double)(unsigned char)s[(std::size_t)i];`,
      `}`,
      ``,
      `static std::string tsn_to_upper(std::string s) {`,
      `  for (char& c : s) c = (char)std::toupper((unsigned char)c);`,
      `  return s;`,
      `}`,
      ``,
      `static std::string tsn_to_lower(std::string s) {`,
      `  for (char& c : s) c = (char)std::tolower((unsigned char)c);`,
      `  return s;`,
      `}`,
      ``,
      ...(this.structDefs.length ? [...this.structDefs, ``] : []),
      ...(protos.length ? [...protos, ``] : []),
      defs.join("\n\n"),
      ...(defs.length ? [``] : []),
      mainDef,
      ``,
    ].join("\n");
  }

  // --- type mapping -------------------------------------------------------

  private cppType(t: Type): string {
    if (isArray(t)) return `std::vector<${this.cppType(t.element)}>`;
    if (isObject(t)) return this.structName(t);
    if (t === "number") return "double";
    if (t === "boolean") return "bool";
    return "std::string"; // string
  }

  private retType(t: RetType): string {
    return t === "void" ? "void" : this.cppType(t);
  }

  // Generate (or reuse) a named struct for an object type. Keyed by field shape.
  private structName(o: ObjectType): string {
    const key = o.fields
      .map((f) => `${f.name}:${displayType(f.type)}`)
      .join(";");
    const existing = this.structNames.get(key);
    if (existing) return existing;
    const name = `tsn_Obj${this.structNames.size}`;
    this.structNames.set(key, name);
    const members = o.fields
      .map((f) => `${this.cppType(f.type)} ${f.name};`)
      .join(" ");
    this.structDefs.push(`struct ${name} { ${members} };`);
    return name;
  }

  // --- functions ----------------------------------------------------------

  private prototype(fn: Func): string {
    const params = fn.params.map((p) => this.cppType(p.type)).join(", ");
    return `${this.retType(fn.returnType)} ${fn.name}(${params});`;
  }

  private resetForFunction(ret: RetType): void {
    this.body = [];
    this.vars = new Map();
    this.curReturn = ret;
    this.indent = "  ";
  }

  private emitFunction(fn: Func): string {
    this.resetForFunction(fn.returnType);
    for (const p of fn.params) this.vars.set(p.name, p.type);
    for (const s of fn.body) this.emitStmt(s);

    const params = fn.params
      .map((p) => `${this.cppType(p.type)} ${p.name}`)
      .join(", ");
    return [
      `${this.retType(fn.returnType)} ${fn.name}(${params}) {`,
      ...this.body,
      `}`,
    ].join("\n");
  }

  private emitMain(stmts: Stmt[]): string {
    this.resetForFunction("void"); // top-level `return` is rejected during lowering
    for (const s of stmts) this.emitStmt(s);
    return [`int main() {`, ...this.body, `  return 0;`, `}`].join("\n");
  }

  // --- emission helpers ---------------------------------------------------

  private push(line: string): void {
    this.body.push(this.indent + line);
  }

  // Emit a nested `{ ... }` block of statements at one deeper indent level.
  private emitBlock(stmts: Stmt[]): void {
    const saved = this.indent;
    this.indent += "  ";
    for (const s of stmts) this.emitStmt(s);
    this.indent = saved;
  }

  // Emit a condition expression; it must be usable as a C++ condition.
  private condition(e: Expr): string {
    const v = this.emitExpr(e);
    if (v.type !== "number" && v.type !== "boolean") {
      throw new Error(
        `Condition must be a number or boolean, got '${displayType(v.type)}'`,
      );
    }
    return v.code;
  }

  // --- statements ---------------------------------------------------------

  // A `let`/`assign` rendered as a C++ fragment without trailing `;` (also used
  // inline inside a `for (...)` header). `let` registers the variable.
  private inlineStmt(stmt: Stmt): string {
    if (stmt.kind === "let") {
      // Empty array literal: element type can't be inferred from `[]`, so take
      // it from the declared annotation (e.g. `let xs: number[] = []`).
      if (stmt.init.kind === "array" && stmt.init.elements.length === 0) {
        if (!stmt.type || !isArray(stmt.type)) {
          throw new Error("Empty array literal needs an array type annotation");
        }
        this.vars.set(stmt.name, stmt.type);
        return `${this.cppType(stmt.type)} ${stmt.name} = {}`;
      }
      // Unannotated integer literal -> infer C++ `int` from the actual value,
      // e.g. `const a = 12` -> `int a = 12`. (Annotated `: number` stays double.)
      if (
        stmt.type === undefined &&
        stmt.init.kind === "num" &&
        Number.isInteger(stmt.init.value)
      ) {
        this.vars.set(stmt.name, "number");
        return `int ${stmt.name} = ${stmt.init.value}`;
      }
      const init = this.emitExpr(stmt.init);
      // With an annotation, check assignability; without one, infer from the init.
      if (stmt.type !== undefined && !sameType(stmt.type, init.type)) {
        throw new Error(
          `Type '${displayType(init.type)}' is not assignable to '${displayType(stmt.type)}'`,
        );
      }
      // Bind the initializer's type (for aggregates, its field/element shape).
      this.vars.set(stmt.name, init.type);
      return `${this.cppType(init.type)} ${stmt.name} = ${init.code}`;
    }
    if (stmt.kind === "assign") {
      const target = this.emitLValue(stmt.target);
      const val = this.emitExpr(stmt.value);
      if (!sameType(target.type, val.type)) {
        throw new Error(
          `Type '${displayType(val.type)}' is not assignable to '${displayType(target.type)}'`,
        );
      }
      return `${target.code} = ${val.code}`;
    }
    throw new Error(`Statement '${stmt.kind}' is not valid here`);
  }

  // Emit an assignable lvalue: a variable, an array element, or an object field.
  // (`arr.length` and other non-assignable members are rejected.)
  private emitLValue(target: Expr): Value {
    switch (target.kind) {
      case "var": {
        const type = this.vars.get(target.name);
        if (!type)
          throw new Error(
            `Cannot assign to undeclared variable '${target.name}'`,
          );
        return { code: target.name, type };
      }
      case "index": {
        const arr = this.emitExpr(target.arr);
        if (!isArray(arr.type)) {
          throw new Error(
            `Cannot index a value of type '${displayType(arr.type)}'`,
          );
        }
        const idx = this.emitExpr(target.index);
        if (idx.type !== "number")
          throw new Error("Array index must be a number");
        return {
          code: `${arr.code}[static_cast<std::size_t>(${idx.code})]`,
          type: arr.type.element,
        };
      }
      case "member": {
        const obj = this.emitExpr(target.obj);
        if (!isObject(obj.type)) {
          throw new Error(
            `Cannot assign to property '${target.name}' of '${displayType(obj.type)}'`,
          );
        }
        const field = obj.type.fields.find((f) => f.name === target.name);
        if (!field) {
          throw new Error(
            `Property '${target.name}' does not exist on type '${displayType(obj.type)}'`,
          );
        }
        return { code: `(${obj.code}).${target.name}`, type: field.type };
      }
      default:
        throw new Error("Invalid assignment target");
    }
  }

  private emitStmt(stmt: Stmt): void {
    switch (stmt.kind) {
      case "let":
      case "assign": {
        this.push(`${this.inlineStmt(stmt)};`);
        return;
      }
      case "log": {
        const val = this.emitExpr(stmt.arg);
        if (isArray(val.type)) {
          throw new Error(
            "console.log of an array is not supported yet (log elements individually)",
          );
        }
        if (isObject(val.type)) {
          throw new Error(
            "console.log of an object is not supported yet (log fields individually)",
          );
        }
        // Numbers (doubles) print JS-style; strings/booleans stream directly.
        const out =
          val.type === "number" ? `tsn_num_to_string(${val.code})` : val.code;
        this.push(`std::cout << ${out} << "\\n";`);
        return;
      }
      case "return": {
        if (this.curReturn === "void") {
          if (stmt.value)
            throw new Error("Cannot return a value from a void function");
          this.push(`return;`);
        } else {
          if (!stmt.value) throw new Error("Missing return value");
          const val = this.emitExpr(stmt.value);
          if (!sameType(val.type, this.curReturn)) {
            throw new Error(
              `Type '${displayType(val.type)}' is not assignable to return type '${displayType(this.curReturn)}'`,
            );
          }
          this.push(`return ${val.code};`);
        }
        return;
      }
      case "exprStmt": {
        // Evaluate for effect; discard any result. (Calls / method calls.)
        let code: string;
        if (stmt.expr.kind === "call") {
          code = this.emitCall(stmt.expr, /*asStatement*/ true).code;
        } else if (stmt.expr.kind === "methodCall") {
          code = this.emitMethodCall(stmt.expr, /*asStatement*/ true).code;
        } else {
          code = this.emitExpr(stmt.expr).code;
        }
        this.push(`${code};`);
        return;
      }
      case "if": {
        this.push(`if (${this.condition(stmt.cond)}) {`);
        this.emitBlock(stmt.then);
        if (stmt.else) {
          this.push(`} else {`);
          this.emitBlock(stmt.else);
        }
        this.push(`}`);
        return;
      }
      case "while": {
        this.push(`while (${this.condition(stmt.cond)}) {`);
        this.emitBlock(stmt.body);
        this.push(`}`);
        return;
      }
      case "for": {
        // init/cond/update are emitted inline into the C++ for-header; init
        // (when a `let`) registers the loop variable before cond/update/body.
        const init = stmt.init ? this.inlineStmt(stmt.init) : "";
        const cond = stmt.cond ? this.condition(stmt.cond) : "";
        const update = stmt.update ? this.inlineStmt(stmt.update) : "";
        this.push(`for (${init}; ${cond}; ${update}) {`);
        this.emitBlock(stmt.body);
        this.push(`}`);
        // A `let`-introduced loop variable is scoped to the loop in C++; drop it.
        if (stmt.init && stmt.init.kind === "let")
          this.vars.delete(stmt.init.name);
        return;
      }
    }
  }

  // --- expressions --------------------------------------------------------

  // Returns a C++ expression string plus the tsn type it represents.
  private emitExpr(e: Expr): Value {
    switch (e.kind) {
      case "num": {
        // Emit a C++ double literal: "2" -> "2.0", but keep "2.5" / "1e21" as-is.
        const s = String(e.value);
        return { code: /[.eE]/.test(s) ? s : `${s}.0`, type: "number" };
      }
      case "bool":
        return { code: e.value ? "true" : "false", type: "boolean" };
      case "str":
        return { code: cppStringLiteral(e.value), type: "string" };
      case "var": {
        const type = this.vars.get(e.name);
        if (!type) throw new Error(`Unknown variable: ${e.name}`);
        return { code: e.name, type };
      }
      case "binary":
        return this.emitBinary(e);
      case "unary": {
        const v = this.emitExpr(e.operand);
        if (e.op === "!") {
          if (v.type !== "boolean")
            throw new Error("Operator '!' expects a boolean");
          return { code: `(!${v.code})`, type: "boolean" };
        }
        // unary `-` / `+` — numeric negation / identity.
        if (v.type !== "number")
          throw new Error(`Operator '${e.op}' expects a number`);
        return { code: `(${e.op}${v.code})`, type: "number" };
      }
      case "array": {
        if (e.elements.length === 0) {
          throw new Error(
            "Empty array literals are not supported (element type cannot be inferred)",
          );
        }
        const vals = e.elements.map((el) => this.emitExpr(el));
        const element = vals[0].type;
        for (const val of vals) {
          if (!sameType(val.type, element)) {
            throw new Error("All array elements must have the same type");
          }
        }
        const arrType: ArrayType = { kind: "array", element };
        const items = vals.map((v) => v.code).join(", ");
        return { code: `${this.cppType(arrType)}{${items}}`, type: arrType };
      }
      case "object": {
        const props = e.properties.map((p) => ({
          name: p.name,
          value: this.emitExpr(p.value),
        }));
        const seen = new Set<string>();
        for (const p of props) {
          if (seen.has(p.name))
            throw new Error(`Duplicate property '${p.name}'`);
          seen.add(p.name);
          if (typeof p.value.type !== "string") {
            throw new Error(
              "Object fields must be number, boolean, or string (v1)",
            );
          }
        }
        const objType: ObjectType = {
          kind: "object",
          fields: props.map((p) => ({ name: p.name, type: p.value.type })),
        };
        const items = props.map((p) => p.value.code).join(", ");
        return { code: `${this.structName(objType)}{${items}}`, type: objType };
      }
      case "index": {
        const arr = this.emitExpr(e.arr);
        if (!isArray(arr.type) && arr.type !== "string") {
          throw new Error(
            `Cannot index a value of type '${displayType(arr.type)}'`,
          );
        }
        const idx = this.emitExpr(e.index);
        if (idx.type !== "number") {
          throw new Error("Array index must be a number");
        }
        // `number` is a double; operator[] needs an integer index.
        const at = `${arr.code}[static_cast<std::size_t>(${idx.code})]`;
        // `s[i]` on a string yields a one-char string (JS has no char type).
        if (arr.type === "string") {
          return { code: `std::string(1, ${at})`, type: "string" };
        }
        return { code: at, type: arr.type.element };
      }
      case "member": {
        const obj = this.emitExpr(e.obj);
        // `arr.length` — std::vector::size() as a number (double).
        if (isArray(obj.type)) {
          if (e.name === "length") {
            return {
              code: `static_cast<double>((${obj.code}).size())`,
              type: "number",
            };
          }
          throw new Error(`Arrays have no property '${e.name}'`);
        }
        // `str.length` — std::string::size() as a number (double). A bare string
        // literal is a `const char*`, which has no `.size()`; wrap it so the call
        // resolves. (Any other string-typed expression is already a std::string.)
        if (obj.type === "string") {
          if (e.name === "length") {
            const s = e.obj.kind === "str" ? `std::string(${obj.code})` : `(${obj.code})`;
            return { code: `static_cast<double>(${s}.size())`, type: "number" };
          }
          throw new Error(`Strings have no property '${e.name}'`);
        }
        // `obj.field`
        if (isObject(obj.type)) {
          const field = obj.type.fields.find((f) => f.name === e.name);
          if (!field) {
            throw new Error(
              `Property '${e.name}' does not exist on type '${displayType(obj.type)}'`,
            );
          }
          return { code: `(${obj.code}).${e.name}`, type: field.type };
        }
        throw new Error(
          `Type '${displayType(obj.type)}' has no property '${e.name}'`,
        );
      }
      case "call": {
        const val = this.emitCall(e, /*asStatement*/ false);
        return { code: val.code, type: val.type as Type };
      }
      case "methodCall": {
        const val = this.emitMethodCall(e, /*asStatement*/ false);
        return { code: val.code, type: val.type as Type };
      }
    }
  }

  private emitBinary(e: { op: BinaryOp; left: Expr; right: Expr }): Value {
    const l = this.emitExpr(e.left);
    const r = this.emitExpr(e.right);
    const code = `(${l.code} ${CPP_OP[e.op]} ${r.code})`;

    // String comparison (relational + equality). A bare string literal is a
    // `const char*`, so two literals would compare pointers; wrapping the left
    // literal forces std::string's lexicographic operators (a mixed
    // `const char* OP std::string` already resolves the right way).
    const stringCmp = () => {
      const left = e.left.kind === "str" ? `std::string(${l.code})` : l.code;
      return `(${left} ${CPP_OP[e.op]} ${r.code})`;
    };

    if (ARITH.has(e.op)) {
      // `+` with a string operand is concatenation (numbers coerce via the same
      // JS-style formatter; std::string(...) on the left makes operator+ resolve
      // even when both operands are bare `const char*` literals).
      if (e.op === "+" && (l.type === "string" || r.type === "string")) {
        const okConcat = (t: Type) => t === "string" || t === "number";
        if (!okConcat(l.type) || !okConcat(r.type)) {
          throw new Error(
            `Cannot concatenate '${displayType(l.type)}' and '${displayType(r.type)}'`,
          );
        }
        const strForm = (v: Value) =>
          v.type === "number" ? `tsn_num_to_string(${v.code})` : v.code;
        return {
          code: `(std::string(${strForm(l)}) + ${strForm(r)})`,
          type: "string",
        };
      }
      if (l.type !== "number" || r.type !== "number") {
        throw new Error(`Operator '${e.op}' expects numbers`);
      }
      // `number` is a double, so `%` can't use C++ integer `%`. tsn_mod takes a
      // fast hardware-remainder path for integer-valued operands and falls back
      // to std::fmod otherwise — both match JS `%`. (Plain std::fmod here was the
      // hot spot in modulo-heavy loops: a libm call per iteration.)
      const arithCode = e.op === "%" ? `tsn_mod(${l.code}, ${r.code})` : code;
      return { code: arithCode, type: "number" };
    }
    if (RELATIONAL.has(e.op)) {
      // Lexicographic ordering on strings (std::string compares this way).
      if (l.type === "string" && r.type === "string") {
        return { code: stringCmp(), type: "boolean" };
      }
      if (l.type !== "number" || r.type !== "number") {
        throw new Error(`Operator '${e.op}' expects numbers or strings`);
      }
      return { code, type: "boolean" };
    }
    if (EQUALITY.has(e.op)) {
      if (
        isAggregate(l.type) ||
        isAggregate(r.type) ||
        !sameType(l.type, r.type)
      ) {
        throw new Error(
          `Cannot compare '${displayType(l.type)}' and '${displayType(r.type)}' with '${e.op}'`,
        );
      }
      // Value comparison for strings (not the `const char*` pointer compare).
      if (l.type === "string") {
        return { code: stringCmp(), type: "boolean" };
      }
      return { code, type: "boolean" };
    }
    // logical && ||
    if (l.type !== "boolean" || r.type !== "boolean") {
      throw new Error(`Operator '${e.op}' expects booleans`);
    }
    return { code, type: "boolean" };
  }

  // Emit a function call. In statement position a void call is allowed; in value
  // position a void call is an error.
  private emitCall(
    e: { callee: string; args: Expr[] },
    asStatement: boolean,
  ): { code: string; type: RetType } {
    const sig = this.sigs.get(e.callee);
    if (!sig) throw new Error(`Unknown function: ${e.callee}`);
    if (e.args.length !== sig.params.length) {
      throw new Error(
        `Function '${e.callee}' expects ${sig.params.length} argument(s), got ${e.args.length}`,
      );
    }
    const args = e.args.map((a, i) => {
      const val = this.emitExpr(a);
      if (!sameType(val.type, sig.params[i])) {
        throw new Error(
          `Argument ${i + 1} of '${e.callee}': type '${displayType(val.type)}' is not assignable to '${displayType(sig.params[i])}'`,
        );
      }
      return val.code;
    });
    if (sig.ret === "void" && !asStatement) {
      throw new Error(
        `'${e.callee}' returns void and cannot be used as a value`,
      );
    }
    return { code: `${e.callee}(${args.join(", ")})`, type: sig.ret };
  }

  // Emit a method call: `array.push(v)` (statement-only, → push_back) or one of
  // the string methods (substring/slice/indexOf/charAt/toUpperCase/toLowerCase).
  private emitMethodCall(
    e: { receiver: Expr; method: string; args: Expr[] },
    asStatement: boolean,
  ): { code: string; type: RetType } {
    const recv = this.emitExpr(e.receiver);
    if (recv.type === "string") {
      return this.emitStringMethod(recv, e);
    }
    if (isArray(recv.type)) {
      if (e.method === "push") {
        if (e.args.length !== 1) {
          throw new Error(`'push' expects 1 argument, got ${e.args.length}`);
        }
        const arg = this.emitExpr(e.args[0]);
        if (!sameType(arg.type, recv.type.element)) {
          throw new Error(
            `Cannot push '${displayType(arg.type)}' onto '${displayType(recv.type)}'`,
          );
        }
        if (!asStatement) {
          throw new Error(
            "'push' result cannot be used as a value yet (call it as a statement)",
          );
        }
        return { code: `${recv.code}.push_back(${arg.code})`, type: "void" };
      }
      throw new Error(`Unsupported array method '${e.method}'`);
    }
    throw new Error(
      `Type '${displayType(recv.type)}' has no method '${e.method}'`,
    );
  }

  // Emit a string method call. Each maps to a tsn_* runtime helper that mirrors
  // the matching String.prototype semantics; an omitted optional numeric arg is
  // passed as NAN, which the helper reads as "default". recv may be a bare
  // `const char*` literal — every helper takes `const std::string&`/`std::string`,
  // so it converts implicitly.
  private emitStringMethod(
    recv: Value,
    e: { method: string; args: Expr[] },
  ): { code: string; type: RetType } {
    const s = recv.code;
    const argv = e.args.map((a) => this.emitExpr(a));

    // Require `lo..hi` args, all numbers; returns their codes (NAN-padded to hi).
    const numArgs = (lo: number, hi: number): string[] => {
      if (argv.length < lo || argv.length > hi) {
        const want = lo === hi ? `${lo}` : `${lo}-${hi}`;
        throw new Error(
          `'${e.method}' expects ${want} argument(s), got ${argv.length}`,
        );
      }
      for (const a of argv) {
        if (a.type !== "number") {
          throw new Error(`'${e.method}' arguments must be numbers`);
        }
      }
      return Array.from({ length: hi }, (_, i) => argv[i]?.code ?? "NAN");
    };

    switch (e.method) {
      case "toUpperCase":
        numArgs(0, 0);
        return { code: `tsn_to_upper(${s})`, type: "string" };
      case "toLowerCase":
        numArgs(0, 0);
        return { code: `tsn_to_lower(${s})`, type: "string" };
      case "charAt": {
        const [i] = numArgs(1, 1);
        return { code: `tsn_char_at(${s}, ${i})`, type: "string" };
      }
      case "charCodeAt": {
        const [i] = numArgs(1, 1);
        return { code: `tsn_char_code_at(${s}, ${i})`, type: "number" };
      }
      case "substring": {
        const [start, end] = numArgs(1, 2);
        return { code: `tsn_substring(${s}, ${start}, ${end})`, type: "string" };
      }
      case "slice": {
        const [start, end] = numArgs(1, 2);
        return { code: `tsn_slice(${s}, ${start}, ${end})`, type: "string" };
      }
      case "indexOf": {
        if (argv.length < 1 || argv.length > 2) {
          throw new Error(
            `'indexOf' expects 1-2 argument(s), got ${argv.length}`,
          );
        }
        if (argv[0].type !== "string") {
          throw new Error("'indexOf' search argument must be a string");
        }
        if (argv.length === 2 && argv[1].type !== "number") {
          throw new Error("'indexOf' fromIndex must be a number");
        }
        const from = argv.length === 2 ? argv[1].code : "NAN";
        return {
          code: `tsn_index_of(${s}, ${argv[0].code}, ${from})`,
          type: "number",
        };
      }
      default:
        throw new Error(`Unsupported string method '${e.method}'`);
    }
  }
}

// Encode a JS string as a C++ double-quoted string literal: printable ASCII is
// kept verbatim (except " and \), common controls use named escapes, and any
// other byte uses a 3-digit octal escape (\ooo is bounded, unlike \x).
function cppStringLiteral(s: string): string {
  const bytes = Buffer.from(s, "utf8");
  let out = '"';
  for (const b of bytes) {
    if (b === 0x22) out += '\\"';
    else if (b === 0x5c) out += "\\\\";
    else if (b === 0x0a) out += "\\n";
    else if (b === 0x09) out += "\\t";
    else if (b === 0x0d) out += "\\r";
    else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else out += "\\" + b.toString(8).padStart(3, "0");
  }
  return out + '"';
}
