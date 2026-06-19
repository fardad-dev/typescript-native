// Stage 3: lower our internal IR to textual LLVM IR.
//
// v1 representation:
//   number, boolean -> i64 (booleans are 0/1)
//   string          -> ptr to a private global byte array (a NUL-terminated C string)
//
// Every emitted value carries its IR type so we know its LLVM representation
// (i64 vs ptr), which store/load width to use, and which printf format to pick.
// Mutable `let` bindings live in stack slots (alloca + load/store).

import { Module, Expr, Stmt, BinaryOp, Type } from "../ir/nodes";

const TARGET_TRIPLE = "arm64-apple-macosx15.0.0";

const OPCODE: Record<BinaryOp, string> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "sdiv",
  "%": "srem",
};

// The LLVM type used to represent a tsn value.
function reprOf(t: Type): "i64" | "ptr" {
  return t === "string" ? "ptr" : "i64";
}

// An emitted value: its LLVM operand text and the tsn type it represents.
interface Value {
  v: string;
  type: Type;
}

export function emit(mod: Module): string {
  return new Emitter().emitModule(mod);
}

class Emitter {
  private body: string[] = [];
  private globals: string[] = []; // string-literal constants
  private temp = 0;
  private strCount = 0;
  private vars = new Map<string, { ptr: string; type: Type }>();

  emitModule(mod: Module): string {
    for (const stmt of mod.stmts) this.emitStmt(stmt);

    return [
      `target triple = "${TARGET_TRIPLE}"`,
      ``,
      `@.fmt.int = private unnamed_addr constant [4 x i8] c"%d\\0A\\00"`,
      `@.fmt.str = private unnamed_addr constant [4 x i8] c"%s\\0A\\00"`,
      ...this.globals,
      ``,
      `declare i32 @printf(ptr, ...)`,
      ``,
      `define i32 @main() {`,
      `entry:`,
      ...this.body,
      `  ret i32 0`,
      `}`,
      ``,
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
        if (reprOf(stmt.type) !== reprOf(init.type)) {
          throw new Error(
            `Type '${init.type}' is not assignable to '${stmt.type}'`
          );
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
        const t = this.fresh();
        if (reprOf(val.type) === "ptr") {
          this.body.push(
            `  ${t} = call i32 (ptr, ...) @printf(ptr @.fmt.str, ptr ${val.v})`
          );
        } else {
          this.body.push(
            `  ${t} = call i32 (ptr, ...) @printf(ptr @.fmt.int, i64 ${val.v})`
          );
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
        const t = this.fresh();
        this.body.push(`  ${t} = ${OPCODE[e.op]} i64 ${l.v}, ${r.v}`);
        return { v: t, type: "number" };
      }
    }
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
