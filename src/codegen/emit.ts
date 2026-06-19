// Stage 3: lower our internal IR to textual LLVM IR.
//
// v1 representation:
//   number, boolean -> i64 (booleans are 0/1)
//   string          -> ptr to a private global byte array (a NUL-terminated C string)
//   T[]             -> ptr to a stack buffer (`alloca [N x repr(T)]`), compile-time-sized
//   { ... }         -> ptr to a stack struct (`alloca { repr(f0), repr(f1), ... }`)
//
// Each tsn function becomes one LLVM `define`; top-level statements become @main.
// Params and locals both live in stack slots (alloca + load/store) for a uniform
// variable model. Every emitted value carries its IR type (and, for arrays, a
// compile-time length) so we know its representation, store/load width, printf
// format, and how to index/project/return it.

import { Module, Expr, Stmt, BinaryOp, Type, Field, Func, RetType } from "../ir/nodes";

const TARGET_TRIPLE = "arm64-apple-macosx15.0.0";

const OPCODE: Record<BinaryOp, string> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "sdiv",
  "%": "srem",
};

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

// The LLVM type used to represent a tsn value. Aggregates and strings are pointers.
function reprOf(t: Type): "i64" | "ptr" {
  return typeof t === "object" || t === "string" ? "ptr" : "i64";
}
function retRepr(t: RetType): string {
  return t === "void" ? "void" : reprOf(t);
}

// The LLVM struct type literal for an object, e.g. `{ i64, ptr }`.
function structType(o: ObjectType): string {
  if (o.fields.length === 0) return "{}";
  return `{ ${o.fields.map((f) => reprOf(f.type)).join(", ")} }`;
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

// An emitted value: its LLVM operand text, the tsn type it represents, and —
// for arrays — its compile-time element count.
interface Value {
  v: string;
  type: Type;
  length?: number;
}

interface Sig {
  params: Type[];
  ret: RetType;
}

export function emit(mod: Module): string {
  return new Emitter().emitModule(mod);
}

class Emitter {
  // Module-level state, shared across functions.
  private globals: string[] = []; // string-literal constants
  private strCount = 0;
  private sigs = new Map<string, Sig>();

  // Per-function scratch, reset by emitBody().
  private body: string[] = [];
  private temp = 0;
  private vars = new Map<string, { ptr: string; type: Type; length?: number }>();
  private curReturn: RetType = "void";
  private terminated = false;

  emitModule(mod: Module): string {
    // First pass: collect signatures so calls can reference any function
    // (including ones declared later, and recursion).
    for (const fn of mod.functions) {
      if (this.sigs.has(fn.name)) throw new Error(`Duplicate function '${fn.name}'`);
      this.sigs.set(fn.name, { params: fn.params.map((p) => p.type), ret: fn.returnType });
    }

    // Emit bodies first — this populates `globals` with any string constants.
    const defs = mod.functions.map((fn) => this.emitFunction(fn));
    defs.push(this.emitMain(mod.main));

    return [
      `target triple = "${TARGET_TRIPLE}"`,
      ``,
      `@.fmt.int = private unnamed_addr constant [4 x i8] c"%d\\0A\\00"`,
      `@.fmt.str = private unnamed_addr constant [4 x i8] c"%s\\0A\\00"`,
      ...this.globals,
      ``,
      `declare i32 @printf(ptr, ...)`,
      ``,
      defs.join("\n\n"),
      ``,
    ].join("\n");
  }

  private resetForFunction(ret: RetType): void {
    this.body = [];
    this.temp = 0;
    this.vars = new Map();
    this.curReturn = ret;
    this.terminated = false;
  }

  private emitFunction(fn: Func): string {
    this.resetForFunction(fn.returnType);

    const paramList = fn.params.map((p) => `${reprOf(p.type)} %${p.name}`).join(", ");
    // Spill each param into a stack slot so it behaves like any other local.
    for (const p of fn.params) {
      const r = reprOf(p.type);
      const ptr = `%${p.name}.addr`;
      this.body.push(`  ${ptr} = alloca ${r}`);
      this.body.push(`  store ${r} %${p.name}, ptr ${ptr}`);
      this.vars.set(p.name, { ptr, type: p.type });
    }

    for (const s of fn.body) {
      if (this.terminated) break; // ignore code after a `return` (no control flow yet)
      this.emitStmt(s);
    }
    if (!this.terminated) {
      if (fn.returnType === "void") this.body.push("  ret void");
      else throw new Error(`Function '${fn.name}' must return a value`);
    }

    return [
      `define ${retRepr(fn.returnType)} @${fn.name}(${paramList}) {`,
      `entry:`,
      ...this.body,
      `}`,
    ].join("\n");
  }

  private emitMain(stmts: Stmt[]): string {
    this.resetForFunction("void"); // top-level `return` is rejected during lowering
    for (const s of stmts) this.emitStmt(s);
    return [
      `define i32 @main() {`,
      `entry:`,
      ...this.body,
      `  ret i32 0`,
      `}`,
    ].join("\n");
  }

  private fresh(): string {
    return `%t${this.temp++}`;
  }

  // Register a string literal as a private global and return its symbol (a ptr).
  private internString(value: string): string {
    const { text, length } = encodeCString(value);
    const name = `@.str.${this.strCount++}`;
    this.globals.push(
      `${name} = private unnamed_addr constant [${length} x i8] c"${text}"`
    );
    return name;
  }

  private emitStmt(stmt: Stmt): void {
    switch (stmt.kind) {
      case "let": {
        const init = this.emitExpr(stmt.init);
        if (!sameType(stmt.type, init.type)) {
          throw new Error(
            `Type '${displayType(init.type)}' is not assignable to '${displayType(stmt.type)}'`
          );
        }
        // Aggregates reuse the buffer their literal already allocated. We bind
        // the *literal's* type, whose field/element order matches the layout.
        if (isAggregate(stmt.type)) {
          this.vars.set(stmt.name, { ptr: init.v, type: init.type, length: init.length });
          return;
        }
        const r = reprOf(stmt.type);
        const ptr = `%${stmt.name}.addr`;
        this.body.push(`  ${ptr} = alloca ${r}`);
        this.body.push(`  store ${r} ${init.v}, ptr ${ptr}`);
        this.vars.set(stmt.name, { ptr, type: stmt.type });
        return;
      }
      case "log": {
        const val = this.emitExpr(stmt.arg);
        if (isArray(val.type)) {
          throw new Error(
            "console.log of an array is not supported yet (log elements individually)"
          );
        }
        if (isObject(val.type)) {
          throw new Error(
            "console.log of an object is not supported yet (log fields individually)"
          );
        }
        const t = this.fresh();
        if (reprOf(val.type) === "ptr") {
          this.body.push(`  ${t} = call i32 (ptr, ...) @printf(ptr @.fmt.str, ptr ${val.v})`);
        } else {
          this.body.push(`  ${t} = call i32 (ptr, ...) @printf(ptr @.fmt.int, i64 ${val.v})`);
        }
        return;
      }
      case "return": {
        if (this.curReturn === "void") {
          if (stmt.value) throw new Error("Cannot return a value from a void function");
          this.body.push(`  ret void`);
        } else {
          if (!stmt.value) throw new Error("Missing return value");
          const val = this.emitExpr(stmt.value);
          if (!sameType(val.type, this.curReturn)) {
            throw new Error(
              `Type '${displayType(val.type)}' is not assignable to return type '${displayType(this.curReturn)}'`
            );
          }
          this.body.push(`  ret ${reprOf(this.curReturn)} ${val.v}`);
        }
        this.terminated = true;
        return;
      }
      case "exprStmt": {
        // Evaluate for effect; discard any result. (Today only calls reach here.)
        if (stmt.expr.kind === "call") {
          this.emitCall(stmt.expr, /*asStatement*/ true);
        } else {
          this.emitExpr(stmt.expr);
        }
        return;
      }
    }
  }

  // Returns the LLVM operand (an SSA temp, a literal, or a global symbol) plus its type.
  private emitExpr(e: Expr): Value {
    switch (e.kind) {
      case "num":
        return { v: String(Math.trunc(e.value)), type: "number" };
      case "bool":
        return { v: e.value ? "1" : "0", type: "boolean" };
      case "str":
        return { v: this.internString(e.value), type: "string" };
      case "var": {
        const slot = this.vars.get(e.name);
        if (!slot) throw new Error(`Unknown variable: ${e.name}`);
        // Aggregates are passed around as their buffer pointer — no load.
        if (isAggregate(slot.type)) {
          return { v: slot.ptr, type: slot.type, length: slot.length };
        }
        const r = reprOf(slot.type);
        const t = this.fresh();
        this.body.push(`  ${t} = load ${r}, ptr ${slot.ptr}`);
        return { v: t, type: slot.type };
      }
      case "binary": {
        const l = this.emitExpr(e.left);
        const r = this.emitExpr(e.right);
        if (l.type === "string" || r.type === "string") {
          throw new Error(
            "String concatenation is not supported yet (needs a heap/runtime)"
          );
        }
        if (isAggregate(l.type) || isAggregate(r.type)) {
          throw new Error("Arithmetic on arrays/objects is not supported");
        }
        const t = this.fresh();
        this.body.push(`  ${t} = ${OPCODE[e.op]} i64 ${l.v}, ${r.v}`);
        return { v: t, type: "number" };
      }
      case "array": {
        if (e.elements.length === 0) {
          throw new Error(
            "Empty array literals are not supported (element type cannot be inferred)"
          );
        }
        const vals = e.elements.map((el) => this.emitExpr(el));
        const element = vals[0].type;
        for (const val of vals) {
          if (!sameType(val.type, element)) {
            throw new Error("All array elements must have the same type");
          }
        }
        const er = reprOf(element);
        const n = vals.length;
        const arr = this.fresh();
        this.body.push(`  ${arr} = alloca [${n} x ${er}]`);
        vals.forEach((val, i) => {
          const p = this.fresh();
          this.body.push(`  ${p} = getelementptr ${er}, ptr ${arr}, i64 ${i}`);
          this.body.push(`  store ${er} ${val.v}, ptr ${p}`);
        });
        return { v: arr, type: { kind: "array", element }, length: n };
      }
      case "object": {
        const props = e.properties.map((p) => ({ name: p.name, value: this.emitExpr(p.value) }));
        const seen = new Set<string>();
        for (const p of props) {
          if (seen.has(p.name)) throw new Error(`Duplicate property '${p.name}'`);
          seen.add(p.name);
          if (typeof p.value.type !== "string") {
            throw new Error("Object fields must be number, boolean, or string (v1)");
          }
        }
        const objType: ObjectType = {
          kind: "object",
          fields: props.map((p) => ({ name: p.name, type: p.value.type })),
        };
        const st = structType(objType);
        const obj = this.fresh();
        this.body.push(`  ${obj} = alloca ${st}`);
        props.forEach((p, i) => {
          const gp = this.fresh();
          this.body.push(`  ${gp} = getelementptr ${st}, ptr ${obj}, i64 0, i32 ${i}`);
          this.body.push(`  store ${reprOf(p.value.type)} ${p.value.v}, ptr ${gp}`);
        });
        return { v: obj, type: objType };
      }
      case "index": {
        const arr = this.emitExpr(e.arr);
        if (!isArray(arr.type)) {
          throw new Error(`Cannot index a value of type '${displayType(arr.type)}'`);
        }
        const idx = this.emitExpr(e.index);
        if (idx.type !== "number") {
          throw new Error("Array index must be a number");
        }
        const er = reprOf(arr.type.element);
        const p = this.fresh();
        this.body.push(`  ${p} = getelementptr ${er}, ptr ${arr.v}, i64 ${idx.v}`);
        const t = this.fresh();
        this.body.push(`  ${t} = load ${er}, ptr ${p}`);
        return { v: t, type: arr.type.element };
      }
      case "member": {
        const obj = this.emitExpr(e.obj);
        // `arr.length` — a compile-time constant.
        if (isArray(obj.type)) {
          if (e.name === "length" && obj.length !== undefined) {
            return { v: String(obj.length), type: "number" };
          }
          throw new Error(`Arrays have no property '${e.name}'`);
        }
        // `obj.field`
        if (isObject(obj.type)) {
          const idx = obj.type.fields.findIndex((f) => f.name === e.name);
          if (idx < 0) {
            throw new Error(
              `Property '${e.name}' does not exist on type '${displayType(obj.type)}'`
            );
          }
          const fieldType = obj.type.fields[idx].type;
          const st = structType(obj.type);
          const gp = this.fresh();
          this.body.push(`  ${gp} = getelementptr ${st}, ptr ${obj.v}, i64 0, i32 ${idx}`);
          const t = this.fresh();
          this.body.push(`  ${t} = load ${reprOf(fieldType)}, ptr ${gp}`);
          return { v: t, type: fieldType };
        }
        throw new Error(`Type '${displayType(obj.type)}' has no property '${e.name}'`);
      }
      case "call": {
        const val = this.emitCall(e, /*asStatement*/ false);
        // emitCall throws for void in value position, so val is non-null here.
        return val!;
      }
    }
  }

  // Emit a function call. In statement position a void call is allowed and its
  // result (if any) discarded; in value position a void call is an error.
  private emitCall(e: { callee: string; args: Expr[] }, asStatement: boolean): Value | null {
    const sig = this.sigs.get(e.callee);
    if (!sig) throw new Error(`Unknown function: ${e.callee}`);
    if (e.args.length !== sig.params.length) {
      throw new Error(
        `Function '${e.callee}' expects ${sig.params.length} argument(s), got ${e.args.length}`
      );
    }
    const args = e.args.map((a, i) => {
      const val = this.emitExpr(a);
      if (!sameType(val.type, sig.params[i])) {
        throw new Error(
          `Argument ${i + 1} of '${e.callee}': type '${displayType(val.type)}' is not assignable to '${displayType(sig.params[i])}'`
        );
      }
      return `${reprOf(sig.params[i])} ${val.v}`;
    });
    const argList = args.join(", ");

    if (sig.ret === "void") {
      if (!asStatement) {
        throw new Error(`'${e.callee}' returns void and cannot be used as a value`);
      }
      this.body.push(`  call void @${e.callee}(${argList})`);
      return null;
    }
    const t = this.fresh();
    this.body.push(`  ${t} = call ${reprOf(sig.ret)} @${e.callee}(${argList})`);
    return { v: t, type: sig.ret };
  }
}

// Encode a JS string as the body of an LLVM `c"..."` constant (UTF-8 bytes,
// non-printable / quote / backslash escaped as \XX), plus the trailing NUL.
// `length` includes that NUL terminator.
function encodeCString(s: string): { text: string; length: number } {
  const bytes = Buffer.from(s, "utf8");
  let text = "";
  for (const b of bytes) {
    if (b >= 0x20 && b <= 0x7e && b !== 0x22 /* " */ && b !== 0x5c /* \ */) {
      text += String.fromCharCode(b);
    } else {
      text += "\\" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return { text: text + "\\00", length: bytes.length + 1 };
}
