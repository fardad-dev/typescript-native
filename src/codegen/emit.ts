// Stage 3: lower our internal IR to C++ source text.
//
// C++ is a high-level target, so codegen is expression-based: emitExpr returns a
// C++ expression string (e.g. "(a + b)", "xs[i]", "p.x", "add(2, 3)") rather than
// breaking everything into temporaries. The C++ compiler (clang++) then does the
// real lowering to machine code.
//
// Type mapping (chosen to preserve the previous backend's observable behavior):
//   number  -> long long      (64-bit integer; integer division, as before)
//   boolean -> bool           (std::cout prints 1/0)
//   string  -> std::string    (literals are const char*, convert implicitly)
//   T[]     -> std::vector<T>  (heap-backed; .length -> .size())
//   { ... } -> a generated `struct` (one per distinct field shape)

import { Module, Expr, Stmt, BinaryOp, Type, Field, Func, RetType } from "../ir/nodes";

const OPCODE: Record<BinaryOp, string> = {
  "+": "+",
  "-": "-",
  "*": "*",
  "/": "/",
  "%": "%",
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
  private terminated = false;

  emitModule(mod: Module): string {
    // First pass: collect signatures so calls can reference any function.
    for (const fn of mod.functions) {
      if (this.sigs.has(fn.name)) throw new Error(`Duplicate function '${fn.name}'`);
      this.sigs.set(fn.name, { params: fn.params.map((p) => p.type), ret: fn.returnType });
    }

    // Emit bodies first — this populates structDefs as object types are seen.
    const protos = mod.functions.map((fn) => this.prototype(fn));
    const defs = mod.functions.map((fn) => this.emitFunction(fn));
    const mainDef = this.emitMain(mod.main);

    return [
      `#include <cstdint>`,
      `#include <iostream>`,
      `#include <string>`,
      `#include <vector>`,
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
    if (t === "number") return "long long";
    if (t === "boolean") return "bool";
    return "std::string"; // string
  }

  private retType(t: RetType): string {
    return t === "void" ? "void" : this.cppType(t);
  }

  // Generate (or reuse) a named struct for an object type. Keyed by field shape.
  private structName(o: ObjectType): string {
    const key = o.fields.map((f) => `${f.name}:${displayType(f.type)}`).join(";");
    const existing = this.structNames.get(key);
    if (existing) return existing;
    const name = `tsn_Obj${this.structNames.size}`;
    this.structNames.set(key, name);
    const members = o.fields.map((f) => `${this.cppType(f.type)} ${f.name};`).join(" ");
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
    this.terminated = false;
  }

  private emitFunction(fn: Func): string {
    this.resetForFunction(fn.returnType);
    for (const p of fn.params) this.vars.set(p.name, p.type);

    for (const s of fn.body) {
      if (this.terminated) break; // ignore code after a `return` (no control flow yet)
      this.emitStmt(s);
    }
    if (!this.terminated && fn.returnType !== "void") {
      throw new Error(`Function '${fn.name}' must return a value`);
    }

    const params = fn.params.map((p) => `${this.cppType(p.type)} ${p.name}`).join(", ");
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

  // --- statements ---------------------------------------------------------

  private emitStmt(stmt: Stmt): void {
    switch (stmt.kind) {
      case "let": {
        const init = this.emitExpr(stmt.init);
        if (!sameType(stmt.type, init.type)) {
          throw new Error(
            `Type '${displayType(init.type)}' is not assignable to '${displayType(stmt.type)}'`
          );
        }
        // Bind the initializer's type (for aggregates, its field/element shape).
        this.body.push(`  ${this.cppType(init.type)} ${stmt.name} = ${init.code};`);
        this.vars.set(stmt.name, init.type);
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
        this.body.push(`  std::cout << ${val.code} << "\\n";`);
        return;
      }
      case "return": {
        if (this.curReturn === "void") {
          if (stmt.value) throw new Error("Cannot return a value from a void function");
          this.body.push(`  return;`);
        } else {
          if (!stmt.value) throw new Error("Missing return value");
          const val = this.emitExpr(stmt.value);
          if (!sameType(val.type, this.curReturn)) {
            throw new Error(
              `Type '${displayType(val.type)}' is not assignable to return type '${displayType(this.curReturn)}'`
            );
          }
          this.body.push(`  return ${val.code};`);
        }
        this.terminated = true;
        return;
      }
      case "exprStmt": {
        // Evaluate for effect; discard any result. (Today only calls reach here.)
        const code =
          stmt.expr.kind === "call"
            ? this.emitCall(stmt.expr, /*asStatement*/ true).code
            : this.emitExpr(stmt.expr).code;
        this.body.push(`  ${code};`);
        return;
      }
    }
  }

  // --- expressions --------------------------------------------------------

  // Returns a C++ expression string plus the tsn type it represents.
  private emitExpr(e: Expr): Value {
    switch (e.kind) {
      case "num":
        return { code: `${Math.trunc(e.value)}LL`, type: "number" };
      case "bool":
        return { code: e.value ? "true" : "false", type: "boolean" };
      case "str":
        return { code: cppStringLiteral(e.value), type: "string" };
      case "var": {
        const type = this.vars.get(e.name);
        if (!type) throw new Error(`Unknown variable: ${e.name}`);
        return { code: e.name, type };
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
        return { code: `(${l.code} ${OPCODE[e.op]} ${r.code})`, type: "number" };
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
        const arrType: ArrayType = { kind: "array", element };
        const items = vals.map((v) => v.code).join(", ");
        return { code: `${this.cppType(arrType)}{${items}}`, type: arrType };
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
        const items = props.map((p) => p.value.code).join(", ");
        return { code: `${this.structName(objType)}{${items}}`, type: objType };
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
        return { code: `${arr.code}[${idx.code}]`, type: arr.type.element };
      }
      case "member": {
        const obj = this.emitExpr(e.obj);
        // `arr.length` — std::vector::size() (cast unsigned -> long long).
        if (isArray(obj.type)) {
          if (e.name === "length") {
            return { code: `static_cast<long long>((${obj.code}).size())`, type: "number" };
          }
          throw new Error(`Arrays have no property '${e.name}'`);
        }
        // `obj.field`
        if (isObject(obj.type)) {
          const field = obj.type.fields.find((f) => f.name === e.name);
          if (!field) {
            throw new Error(
              `Property '${e.name}' does not exist on type '${displayType(obj.type)}'`
            );
          }
          return { code: `(${obj.code}).${e.name}`, type: field.type };
        }
        throw new Error(`Type '${displayType(obj.type)}' has no property '${e.name}'`);
      }
      case "call": {
        const val = this.emitCall(e, /*asStatement*/ false);
        return { code: val.code, type: val.type as Type };
      }
    }
  }

  // Emit a function call. In statement position a void call is allowed; in value
  // position a void call is an error.
  private emitCall(
    e: { callee: string; args: Expr[] },
    asStatement: boolean
  ): { code: string; type: RetType } {
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
      return val.code;
    });
    if (sig.ret === "void" && !asStatement) {
      throw new Error(`'${e.callee}' returns void and cannot be used as a value`);
    }
    return { code: `${e.callee}(${args.join(", ")})`, type: sig.ret };
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
