// Stage 3: lower our internal IR to textual LLVM IR.
//
// v1 representation: `number` and `boolean` are both i64 (booleans are 0/1).
// Mutable `let` bindings live in stack slots (alloca + load/store) rather than
// being kept in SSA registers by hand. See CLAUDE.md conventions.

import { Module, Expr, Stmt, BinaryOp } from "../ir/nodes";

const TARGET_TRIPLE = "arm64-apple-macosx15.0.0";

const OPCODE: Record<BinaryOp, string> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "sdiv",
  "%": "srem",
};

export function emit(mod: Module): string {
  return new Emitter().emitModule(mod);
}

class Emitter {
  private body: string[] = [];
  private temp = 0;
  private vars = new Map<string, string>(); // var name -> alloca pointer

  emitModule(mod: Module): string {
    for (const stmt of mod.stmts) this.emitStmt(stmt);

    return [
      `target triple = "${TARGET_TRIPLE}"`,
      ``,
      `@.fmt.int = private unnamed_addr constant [4 x i8] c"%d\\0A\\00"`,
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

  private emitStmt(stmt: Stmt): void {
    switch (stmt.kind) {
      case "let": {
        const ptr = `%${stmt.name}.addr`;
        this.body.push(`  ${ptr} = alloca i64`);
        const val = this.emitExpr(stmt.init);
        this.body.push(`  store i64 ${val}, ptr ${ptr}`);
        this.vars.set(stmt.name, ptr);
        return;
      }
      case "log": {
        const val = this.emitExpr(stmt.arg);
        const t = this.fresh();
        this.body.push(
          `  ${t} = call i32 (ptr, ...) @printf(ptr @.fmt.int, i64 ${val})`
        );
        return;
      }
    }
  }

  // Returns the LLVM value (an SSA temp like %t3, or a literal operand).
  private emitExpr(e: Expr): string {
    switch (e.kind) {
      case "num":
        return String(Math.trunc(e.value));
      case "bool":
        return e.value ? "1" : "0";
      case "var": {
        const ptr = this.vars.get(e.name);
        if (!ptr) throw new Error(`Unknown variable: ${e.name}`);
        const t = this.fresh();
        this.body.push(`  ${t} = load i64, ptr ${ptr}`);
        return t;
      }
      case "binary": {
        const l = this.emitExpr(e.left);
        const r = this.emitExpr(e.right);
        const t = this.fresh();
        this.body.push(`  ${t} = ${OPCODE[e.op]} i64 ${l}, ${r}`);
        return t;
      }
    }
  }
}
