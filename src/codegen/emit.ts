// Stage 3: lower our internal IR to C++ source text.
//
// C++ is a high-level target, so codegen is expression-based: emitExpr returns a
// C++ expression string (e.g. "(a + b)", "xs[i]", "p.x", "add(2, 3)") rather than
// breaking everything into temporaries. The C++ compiler (clang++) then does the
// real lowering to machine code, and enforces that non-void functions return
// (we pass -Werror=return-type in the backend).
//
// Type mapping:
//   number  -> double OR long long   (see repr.ts: integer-valued numbers use a
//                                      64-bit integer rep, "i64"; the rest f64)
//   boolean -> bool           (std::cout prints 1/0)
//   string  -> tsn_str        (ref-counted immutable string; see prelude)
//   T[]     -> std::vector<T>  (heap-backed; .length -> .size())
//   { ... } -> a generated `struct` (one per distinct field shape)
//
// A `number` value carries a representation ("i64" / "f64") alongside its type;
// repr.ts infers, per variable/parameter/return, which one is sound to use. The
// emitter consults that table for slot declarations and combines reps locally
// for expressions (see emitBinary). Object fields and array elements always use
// the f64 rep, so aggregates are unaffected.

import * as path from "path";
import {
  Module,
  Expr,
  Stmt,
  BinaryOp,
  Type,
  Field,
  Func,
  RetType,
  Param,
  ClassDecl,
  Method,
  DepModule,
} from "../ir/nodes";
import { analyze, RepTable, Rep, litRep, combineRep, MAIN_KEY } from "./repr";

// Absolute path to the fixed C++ runtime header every generated program
// #includes (see emitModule). It lives as real C++ under src/codegen/cpp/; the
// build copies that folder to dist/codegen/cpp/ (scripts/copy-runtime.mjs), so
// `${__dirname}/cpp` resolves whether the emitter runs from src (the vitest
// suite imports ../src/driver) or from dist (the installed CLI). Embedding an
// absolute path keeps the emitted .cpp self-contained: it recompiles by hand
// with a plain `clang++ file.cpp`, no -I needed.
const RUNTIME_HEADER = path.join(__dirname, "cpp", "tsn_runtime.h");

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
type ClassType = { kind: "class"; name: string };

function isArray(t: Type): t is ArrayType {
  return typeof t === "object" && t.kind === "array";
}
function isObject(t: Type): t is ObjectType {
  return typeof t === "object" && t.kind === "object";
}
// A class instance is a *reference* type, deliberately NOT an "aggregate": those
// (array/object) are value types passed by const& and read-only, whereas an
// instance is a shared_ptr passed by value and freely mutable (see paramType).
function isClass(t: Type): t is ClassType {
  return typeof t === "object" && t.kind === "class";
}
function isAggregate(t: Type): boolean {
  return isArray(t) || isObject(t);
}

function displayType(t: RetType): string {
  if (t === "void") return "void";
  if (isClass(t)) return t.name;
  if (isArray(t)) return `${displayType(t.element)}[]`;
  if (isObject(t)) {
    return `{ ${t.fields.map((f) => `${f.name}: ${displayType(f.type)}`).join("; ")} }`;
  }
  return t;
}

function sameType(a: Type, b: Type): boolean {
  // Class instances are nominal: equal iff they name the same class.
  if (isClass(a) || isClass(b)) return isClass(a) && isClass(b) && a.name === b.name;
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
// For `number` values, `rep` records the C++ representation ("i64" / "f64") of
// the expression, so callers can pick integer vs floating operations.
interface Value {
  code: string;
  type: Type;
  rep?: Rep;
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
  private classes = new Map<string, ClassDecl>(); // class name -> declaration
  private structDefs: string[] = []; // generated `struct ... { ... };` lines
  private structNames = new Map<string, string>(); // field-shape key -> struct name
  // Struct name -> its fields, in declaration order. Used to generate the
  // per-struct `tsn_inspect` (JS-style printing) once every struct is known.
  private structFields = new Map<string, Field[]>();

  // Representation table (number i64/f64), inferred up front by repr.ts.
  private reps!: RepTable;

  // Module-level globals: each direct top-level `let`/`const` in `main` is
  // promoted to a file-scope global so function/method bodies can reference it
  // (top-level locals can't be seen from a separate C++ function). `globals` maps
  // the (program-unique) name to its type; `globalDecls` are the namespace-scope
  // declarations. Populated while emitting `main` (which runs before the function
  // and class bodies that read it).
  private globals = new Map<string, Type>();
  private globalDecls: string[] = [];

  // Per-function scratch, reset by resetForFunction().
  private body: string[] = [];
  private vars = new Map<string, Type>();
  private curReturn: RetType = "void";
  private funcKey: string = MAIN_KEY; // scope key for repr lookups
  // The class whose method/constructor body is being emitted (so `this` resolves);
  // undefined inside free functions and main.
  private currentClass?: ClassDecl;
  private indent = "  ";

  emitModule(mod: Module): string {
    this.reps = analyze(mod); // decide each number slot's representation

    // First pass: collect class declarations and function signatures so any
    // construct can reference any class/function regardless of source order.
    for (const cls of mod.classes) {
      if (this.classes.has(cls.name))
        throw new Error(`Duplicate class '${cls.name}'`);
      this.classes.set(cls.name, cls);
    }
    for (const fn of mod.functions) {
      if (this.sigs.has(fn.name))
        throw new Error(`Duplicate function '${fn.name}'`);
      this.sigs.set(fn.name, {
        params: fn.params.map((p) => p.type),
        ret: fn.returnType,
      });
    }

    // Emit bodies first — this populates structDefs as object types are seen.
    // `main` is emitted BEFORE the function/class bodies: it promotes top-level
    // `let`/`const` to file-scope globals (populating `this.globals` + the
    // declarations), which the function and method bodies then reference. Struct
    // definitions still come before their out-of-line method/ctor bodies; all
    // populate structDefs.
    const classStructs = mod.classes.map((c) => this.emitClassStruct(c));
    const protos = mod.functions.map((fn) => this.prototype(fn));
    // Dependency module inits BEFORE main/functions: each registers a synthetic
    // `tsn_modN_init` signature (returning its exports record) that main and the
    // function/method bodies reference when reading a module variable.
    const depInits = mod.modules.map((dm) => this.emitDepInit(dm));
    const mainDef = this.emitMain(mod.main, mod.modules); // populates this.globals
    const classDefs = mod.classes.flatMap((c) => this.emitClassDefs(c));
    const defs = mod.functions.map((fn) => this.emitFunction(fn));
    // Forward-declare every class and object struct so any type can reference any
    // other (or itself) through `std::shared_ptr<…>` (a pointer to an incomplete
    // type is fine). With reference-typed aggregates, struct *members* are also
    // shared_ptrs, so struct order no longer needs inner-before-outer.
    const classFwd = mod.classes.map((c) => `struct ${c.name};`);
    const structFwd = [...this.structNames.values()].map((n) => `struct ${n};`);
    // Per-type `tsn_inspect` overloads (computed after all structs are known, so
    // every aggregate/instance type is covered) — see the JS-style printing block.
    const inspectFwd = this.inspectFwdDecls();
    const inspectDefs = this.aggregateInspectDefs();

    return [
      // The fixed C++ runtime (tsn_str, JS-semantics numeric/string/array helpers,
      // and the scalar + array `tsn_inspect` overloads) lives as real C++ in
      // src/codegen/cpp/tsn_runtime.h and is #included instead of inlined here, so
      // the generated .cpp holds only what's program-specific. RUNTIME_HEADER is an
      // absolute path resolved at emit time, so the emitted .cpp also recompiles
      // by hand (`clang++ file.cpp`) without extra -I flags. See RUNTIME_HEADER.
      `#include "${RUNTIME_HEADER}"`,
      ``,
      // Ordering matters for C++: forward-declare every class and object struct,
      // then the per-type tsn_inspect overloads (a shared_ptr to an incomplete
      // type is fine in a declaration), then the full struct/class definitions,
      // then the per-type inspect definitions (now every type is complete), then
      // out-of-line class method/ctor bodies, functions, and main. The scalar +
      // array-template tsn_inspect come from the runtime header (included above);
      // an array of objects/instances resolves its element overload via ADL here.
      ...(classFwd.length || structFwd.length
        ? [...classFwd, ...structFwd, ``]
        : []),
      ...(inspectFwd.length ? [...inspectFwd, ``] : []),
      ...(this.structDefs.length ? [...this.structDefs, ``] : []),
      ...(classStructs.length ? [classStructs.join("\n\n"), ``] : []),
      ...(inspectDefs.length ? [inspectDefs.join("\n\n"), ``] : []),
      // Module-level globals (promoted top-level `let`/`const`) — declared after
      // the struct/class definitions and before the function/method bodies and
      // main that read them. A shared_ptr global only needs a forward decl, but
      // these come after the full definitions, so any type is fine here.
      ...(this.globalDecls.length
        ? [`// module-level globals`, ...this.globalDecls, ``]
        : []),
      // Dependency module init prototypes, then their definitions — both before
      // the function/method bodies and main that call `tsn_modN_init()`.
      ...(depInits.length ? [...depInits.map((d) => d.proto), ``] : []),
      ...(depInits.length ? [depInits.map((d) => d.def).join("\n\n"), ``] : []),
      ...(classDefs.length ? [classDefs.join("\n\n"), ``] : []),
      ...(protos.length ? [...protos, ``] : []),
      defs.join("\n\n"),
      ...(defs.length ? [``] : []),
      mainDef,
      ``,
    ].join("\n");
  }

  // --- type mapping -------------------------------------------------------

  // The *value* representation of a tsn type. Arrays, objects and class instances
  // are all *reference* types — a `std::shared_ptr` to a heap value — so copy/assign
  // aliases the same value (JS reference semantics) and `===` is pointer identity.
  // The pointee (the `std::vector<T>` / generated `struct`) is what `vecType` /
  // `structName` return.
  private cppType(t: Type): string {
    if (isArray(t)) return `std::shared_ptr<${this.vecType(t)}>`;
    if (isObject(t)) return `std::shared_ptr<${this.structName(t)}>`;
    if (isClass(t)) return `std::shared_ptr<${t.name}>`; // reference-typed instance
    if (t === "number") return "double"; // f64 rep — the default for nested aggregates
    if (t === "boolean") return "bool";
    return "tsn_str"; // string — a ref-counted immutable string (see prelude)
  }

  // The pointee vector type for an array reference (`std::vector<T>`), e.g. for
  // `make_shared` and slice results. `cppType` wraps this in a `shared_ptr`.
  private vecType(t: ArrayType): string {
    return `std::vector<${this.cppType(t.element)}>`;
  }

  // C++ type for a number with a known representation.
  private cppNumType(rep: Rep): string {
    return rep === "i64" ? "long long" : "double";
  }

  // C++ type for a variable/parameter slot, honoring its number representation.
  private slotType(t: Type, rep: Rep): string {
    return t === "number" ? this.cppNumType(rep) : this.cppType(t);
  }

  // Return type of a function, honoring its number return representation.
  private retSlotType(fnName: string, t: RetType): string {
    if (t === "void") return "void";
    if (t === "number") return this.cppNumType(this.reps.retRep(fnName));
    return this.cppType(t);
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
    this.structFields.set(name, o.fields);
    const members = o.fields
      .map((f) => `${this.cppType(f.type)} ${f.name};`)
      .join(" ");
    this.structDefs.push(`struct ${name} { ${members} };`);
    return name;
  }

  // --- JS-style value printing (console.log) ------------------------------
  //
  // console.log routes booleans, arrays, objects and class instances through
  // `tsn_inspect`, which mirrors Node's `util.inspect` single-line format:
  // booleans `true`/`false`, arrays `[ e0, e1 ]`, objects `{ k: v, ... }`, class
  // instances `Name { k: v, ... }`, and strings *quoted* (`'x'`) when nested
  // (top-level strings/numbers keep their bare form — see the `log` statement).
  //
  // The program-INDEPENDENT half — `tsn_quote`, the scalar `tsn_inspect`
  // overloads, and the array-inspect template — lives in the runtime header
  // (src/codegen/cpp/tsn_runtime.h). What stays here are the program-DEPENDENT
  // overloads: one `tsn_inspect` per generated object struct / class, since they
  // need the field names. The array template resolves an object/class element
  // via ADL at its instantiation point in this generated code.

  // `tsn_inspect(const std::shared_ptr<NAME>&)` forward declarations, one per
  // generated object struct and per class (a shared_ptr to an incomplete type is
  // fine in a declaration, so these can precede the full type definitions).
  private inspectFwdDecls(): string[] {
    const names = [...this.structFields.keys(), ...this.classes.keys()];
    return names.map(
      (n) => `static std::string tsn_inspect(const std::shared_ptr<${n}>& v);`,
    );
  }

  // The `tsn_inspect` definitions for every object struct and class instance.
  // Object literals print `{ k: v, ... }`; class instances print `Name { k: v }`.
  private aggregateInspectDefs(): string[] {
    const defs: string[] = [];
    for (const [name, fields] of this.structFields) {
      defs.push(this.inspectBody(name, fields, ""));
    }
    for (const cls of this.classes.values()) {
      defs.push(this.inspectBody(cls.name, cls.fields, `${cls.name} `));
    }
    return defs;
  }

  // One `tsn_inspect` body. `prefix` is the class name + space for an instance,
  // empty for an object literal. Each field value recurses through `tsn_inspect`
  // (so nested strings are quoted, nested aggregates bracketed).
  private inspectBody(name: string, fields: Field[], prefix: string): string {
    if (fields.length === 0) {
      return [
        `static std::string tsn_inspect(const std::shared_ptr<${name}>& v) {`,
        `  if (!v) return "null";`,
        `  return "${prefix}{}";`,
        `}`,
      ].join("\n");
    }
    const lines = [
      `static std::string tsn_inspect(const std::shared_ptr<${name}>& v) {`,
      `  if (!v) return "null";`,
      `  std::string out = "${prefix}{ ";`,
    ];
    fields.forEach((f, i) => {
      const sep = i === 0 ? "" : ", ";
      lines.push(
        `  out += "${sep}${f.name}: "; out += tsn_inspect(v->${f.name});`,
      );
    });
    lines.push(`  out += " }";`);
    lines.push(`  return out;`);
    lines.push(`}`);
    return lines.join("\n");
  }

  // --- functions ----------------------------------------------------------

  // C++ type of a parameter. Every parameter passes **by value**: scalars are
  // cheap copies (a `tsn_str` copy is just a refcount bump), and arrays/objects/
  // class instances are reference types — a `shared_ptr` copy (another refcount
  // bump) that aliases the caller's value, so mutating through the param is
  // visible to the caller, matching JS reference semantics. (Only `number` needs
  // the rep table to pick `long long` vs `double`.)
  private paramType(fnName: string, p: { name: string; type: Type }): string {
    return this.slotType(p.type, this.reps.varRep(fnName, p.name));
  }

  // `type name` declarators for a parameter list (used in definitions).
  private declParams(funcKey: string, params: Param[]): string {
    return params.map((p) => `${this.paramType(funcKey, p)} ${p.name}`).join(", ");
  }

  // Register parameters as local variables. Every parameter is mutable now —
  // arrays/objects are reference types (a `shared_ptr` alias), so a callee
  // mutation is visible to the caller, exactly like JS.
  private bindParams(params: Param[]): void {
    for (const p of params) this.vars.set(p.name, p.type);
  }

  private prototype(fn: Func): string {
    return `${this.retSlotType(fn.name, fn.returnType)} ${fn.name}(${this.declParams(fn.name, fn.params)});`;
  }

  private resetForFunction(ret: RetType, funcKey: string): void {
    this.body = [];
    this.vars = new Map();
    this.curReturn = ret;
    this.funcKey = funcKey;
    this.currentClass = undefined;
    this.indent = "  ";
  }

  private emitFunction(fn: Func): string {
    this.resetForFunction(fn.returnType, fn.name);
    this.bindParams(fn.params);
    for (const s of fn.body) this.emitStmt(s);
    return [
      `${this.retSlotType(fn.name, fn.returnType)} ${fn.name}(${this.declParams(fn.name, fn.params)}) {`,
      ...this.body,
      `}`,
    ].join("\n");
  }

  // --- classes ------------------------------------------------------------
  //
  // A class `C` compiles to `struct C { fields; C(ctor); methods; }` and an
  // instance to `std::shared_ptr<C>` (see cppType). Methods/ctor are analyzed by
  // repr.ts under the scope keys below, so their number params/locals/returns get
  // the same i64/f64 treatment as free functions; the emitter uses the same keys.
  private methodKey(className: string, method: string): string {
    return `${className}#${method}`;
  }
  private ctorKey(className: string): string {
    return `${className}#$ctor`;
  }

  // The struct: field members, a constructor declaration, and method
  // declarations. Definitions are emitted out-of-line (emitClassDefs) so a method
  // body can reference any class. Calling cppType on field types here also lazily
  // generates any object structs the fields need (into structDefs).
  private emitClassStruct(cls: ClassDecl): string {
    const members = cls.fields.map((f) => `  ${this.cppType(f.type)} ${f.name};`);
    const ctorDecl = `  ${cls.name}(${this.declParams(this.ctorKey(cls.name), cls.ctor.params)});`;
    const methodDecls = cls.methods.map((m) => {
      const key = this.methodKey(cls.name, m.name);
      return `  ${this.retSlotType(key, m.returnType)} ${m.name}(${this.declParams(key, m.params)});`;
    });
    return [`struct ${cls.name} {`, ...members, ctorDecl, ...methodDecls, `};`].join("\n");
  }

  // Out-of-line constructor and method definitions for one class.
  private emitClassDefs(cls: ClassDecl): string[] {
    return [this.emitCtorDef(cls), ...cls.methods.map((m) => this.emitMethodDef(cls, m))];
  }

  private emitCtorDef(cls: ClassDecl): string {
    const key = this.ctorKey(cls.name);
    this.resetForFunction("void", key);
    this.currentClass = cls;
    this.bindParams(cls.ctor.params);
    for (const s of cls.ctor.body) this.emitStmt(s);
    return [
      `${cls.name}::${cls.name}(${this.declParams(key, cls.ctor.params)}) {`,
      ...this.body,
      `}`,
    ].join("\n");
  }

  private emitMethodDef(cls: ClassDecl, m: Method): string {
    const key = this.methodKey(cls.name, m.name);
    this.resetForFunction(m.returnType, key);
    this.currentClass = cls;
    this.bindParams(m.params);
    for (const s of m.body) this.emitStmt(s);
    return [
      `${this.retSlotType(key, m.returnType)} ${cls.name}::${m.name}(${this.declParams(key, m.params)}) {`,
      ...this.body,
      `}`,
    ].join("\n");
  }

  // The receiver of a member access / method call. `this` resolves to the current
  // class instance (a raw `C*` in a member-function body); everything else is a
  // normal expression. Both `shared_ptr<C>` and `C*` use `->`, so member/method
  // access is uniformly `(code)->name` regardless of which one the receiver is.
  private thisValue(): Value {
    if (!this.currentClass) {
      throw new Error("'this' is only valid inside a method or constructor");
    }
    return { code: "this", type: { kind: "class", name: this.currentClass.name } };
  }
  private emitReceiver(e: Expr): Value {
    return e.kind === "this" ? this.thisValue() : this.emitExpr(e);
  }

  private emitMain(stmts: Stmt[], deps: DepModule[]): string {
    // top-level `return` is rejected during lowering
    this.resetForFunction("void", MAIN_KEY);
    // Run each dependency's init() eagerly, in dependency order, before the
    // entry's own top-level — so a module's top-level side effects happen at
    // "import time" (matching ES module semantics). init() is memoized, so a
    // later module-variable read just returns the cached record.
    for (const d of deps) this.push(`${this.depInitName(d)}();`);
    for (const s of stmts) this.emitTopLevel(s);
    return [`int main() {`, ...this.body, `  return 0;`, `}`].join("\n");
  }

  // --- dependency modules (records + memoized init) -----------------------
  //
  // A dependency module compiles to a memoized `init()` that runs its top-level
  // once and returns a record (an object struct) of its module variables. A
  // reference to such a variable was rewritten by the loader into a
  // `member`-on-`init()` call, so reading it reuses the object/member codegen; we
  // just have to emit the init and register its synthetic signature so those
  // member accesses type-check.
  private depInitName(d: DepModule): string {
    return `tsn_mod${d.index}_init`;
  }

  private emitDepInit(d: DepModule): { proto: string; def: string } {
    const fn = this.depInitName(d);
    // funcKey for nested-local reps (matches repr.ts's `$dep<idx>` key).
    this.resetForFunction("void", `$dep${d.index}`);
    // Build the record type incrementally: after each top-level `let`, register
    // (a growing) signature `fn: () -> { fields... }` so a later statement that
    // reads an earlier field resolves through it.
    const fields: Field[] = [];
    for (const s of d.body) {
      if (s.kind === "let") {
        const init = this.emitExpr(s.init);
        if (s.type !== undefined && !sameType(s.type, init.type)) {
          throw new Error(
            `Type '${displayType(init.type)}' is not assignable to '${displayType(s.type)}'`,
          );
        }
        fields.push({ name: s.name, type: init.type });
        this.sigs.set(fn, { params: [], ret: { kind: "object", fields: [...fields] } });
        // Record fields are object fields (f64 for numbers), so cast an i64 init.
        this.push(`rec->${s.name} = ${this.f64SlotCode(init)};`);
      } else {
        this.emitStmt(s);
      }
    }
    const recordType: ObjectType = { kind: "object", fields };
    this.sigs.set(fn, { params: [], ret: recordType });
    const ptr = this.cppType(recordType); // std::shared_ptr<tsn_ObjN>
    const struct = this.structName(recordType);
    const def = [
      `${ptr} ${fn}() {`,
      `  static ${ptr} rec;`,
      `  if (rec) return rec;`, // memoized — runs the body exactly once
      `  rec = std::make_shared<${struct}>();`,
      ...this.body,
      `  return rec;`,
      `}`,
    ].join("\n");
    return { proto: `${ptr} ${fn}();`, def };
  }

  // A top-level statement of `main`. A direct `let`/`const` is promoted to a
  // file-scope global (declared at namespace scope, assigned here) so it is
  // visible to function/method bodies, which are separate C++ functions and can't
  // see `main`'s locals. Every other statement — including a nested `let` inside
  // a top-level loop/`if` — is emitted normally (those stay true locals).
  private emitTopLevel(s: Stmt): void {
    if (s.kind === "let") {
      this.emitGlobalLet(s);
      return;
    }
    this.emitStmt(s);
  }

  private emitGlobalLet(stmt: {
    kind: "let";
    name: string;
    type?: Type;
    init: Expr;
  }): void {
    // Empty array literal: take the element type from the annotation (as locals).
    if (stmt.init.kind === "array" && stmt.init.elements.length === 0) {
      if (!stmt.type || !isArray(stmt.type)) {
        throw new Error("Empty array literal needs an array type annotation");
      }
      this.globals.set(stmt.name, stmt.type);
      this.globalDecls.push(`${this.cppType(stmt.type)} ${stmt.name};`);
      this.push(
        `${stmt.name} = std::make_shared<${this.vecType(stmt.type)}>();`,
      );
      return;
    }
    const init = this.emitExpr(stmt.init);
    if (stmt.type !== undefined && !sameType(stmt.type, init.type)) {
      throw new Error(
        `Type '${displayType(init.type)}' is not assignable to '${displayType(stmt.type)}'`,
      );
    }
    this.globals.set(stmt.name, init.type);
    // The global's C++ type follows its inferred number rep (a safe-integer global
    // never assigned a fraction stays `long long`); an i64 initializer widens
    // harmlessly into a demoted (double) global.
    const declType = this.slotType(init.type, this.reps.globalRep(stmt.name));
    this.globalDecls.push(`${declType} ${stmt.name};`);
    this.push(`${stmt.name} = ${init.code};`);
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
        // A reference-typed array is a heap-allocated empty vector.
        return `${this.cppType(stmt.type)} ${stmt.name} = std::make_shared<${this.vecType(stmt.type)}>()`;
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
      // The variable's C++ type follows its inferred number representation (a
      // safe-integer initializer that's never assigned a fraction stays i64); an
      // i64 init code widens harmlessly into a demoted (double) slot.
      const cpp = this.slotType(init.type, this.reps.varRep(this.funcKey, stmt.name));
      return `${cpp} ${stmt.name} = ${init.code}`;
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

  // Code for a value stored in an f64 slot — an array element or object field,
  // which are always `double`. An i64-rep number needs an explicit cast: a
  // brace-init list (`std::vector<double>{x}`, `Obj{x}`) narrows a non-constant
  // `long long`→`double`, which clang rejects (-Wc++11-narrowing). A constant
  // (`3LL`) narrows legally, so literal-only aggregates never tripped this.
  private f64SlotCode(v: Value): string {
    return v.type === "number" && v.rep === "i64"
      ? `static_cast<double>(${v.code})`
      : v.code;
  }

  // Emit an assignable lvalue: a variable, an array element, or an object field.
  // (`arr.length` and other non-assignable members are rejected.)
  private emitLValue(target: Expr): Value {
    switch (target.kind) {
      case "var": {
        // Locals shadow globals; fall back to a module-level global otherwise.
        const type = this.vars.get(target.name) ?? this.globals.get(target.name);
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
        // Dereference the shared_ptr to reach the vector, then index it.
        return {
          code: `(*(${arr.code}))[static_cast<std::size_t>(${idx.code})]`,
          type: arr.type.element,
        };
      }
      case "member": {
        const obj = this.emitReceiver(target.obj);
        // `instance.field = …` — mutating through a class reference is fine (the
        // shared_ptr aliases shared storage, so JS reference semantics hold).
        if (isClass(obj.type)) {
          return this.classField(obj, target.name);
        }
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
        // Write through the shared_ptr (aliases see the mutation — JS semantics).
        return { code: `(${obj.code})->${target.name}`, type: field.type };
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
        // Top-level strings print bare (no surrounding quotes) and numbers print
        // JS-style (f64 via to_chars; i64 streams directly). Everything else —
        // booleans (`true`/`false`) and arrays/objects/class instances (JS-style)
        // — goes through `tsn_inspect`, matching Node's `console.log`.
        let out: string;
        if (val.type === "string") {
          out = val.code;
        } else if (val.type === "number") {
          out = val.rep === "i64" ? val.code : `tsn_num_to_string(${val.code})`;
        } else {
          out = `tsn_inspect(${val.code})`;
        }
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
        const s = String(e.value);
        // A safe-integer literal is an i64 (`2` -> `2LL`); anything fractional or
        // beyond 2^53 is a C++ double literal ("2.5" / "1e21" as-is, "2" -> "2.0").
        if (litRep(e.value) === "i64") {
          return { code: `${s}LL`, type: "number", rep: "i64" };
        }
        return {
          code: /[.eE]/.test(s) ? s : `${s}.0`,
          type: "number",
          rep: "f64",
        };
      }
      case "bool":
        return { code: e.value ? "true" : "false", type: "boolean" };
      case "str":
        return { code: `tsn_str(${cppStringLiteral(e.value)})`, type: "string" };
      case "var": {
        // A local binding shadows a same-named global, so check `vars` first.
        const local = this.vars.get(e.name);
        if (local !== undefined) {
          const rep =
            local === "number" ? this.reps.varRep(this.funcKey, e.name) : undefined;
          return { code: e.name, type: local, rep };
        }
        // Otherwise it may be a module-level global (a promoted top-level var),
        // visible here even from inside a function/method body.
        const global = this.globals.get(e.name);
        if (global !== undefined) {
          const rep =
            global === "number" ? this.reps.globalRep(e.name) : undefined;
          return { code: e.name, type: global, rep };
        }
        throw new Error(`Unknown variable: ${e.name}`);
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
        // unary `-` / `+` — numeric negation / identity; rep is preserved.
        if (v.type !== "number")
          throw new Error(`Operator '${e.op}' expects a number`);
        return { code: `(${e.op}${v.code})`, type: "number", rep: v.rep };
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
        const items = vals.map((v) => this.f64SlotCode(v)).join(", ");
        // A reference-typed array: a shared_ptr to a heap vector (so `let b = a`
        // aliases, mutations are shared, and `===` is identity — JS semantics).
        const vec = this.vecType(arrType);
        return { code: `std::make_shared<${vec}>(${vec}{${items}})`, type: arrType };
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
        }
        const objType: ObjectType = {
          kind: "object",
          fields: props.map((p) => ({ name: p.name, type: p.value.type })),
        };
        const items = props.map((p) => this.f64SlotCode(p.value)).join(", ");
        // A reference-typed object: a shared_ptr to a heap struct (JS objects are
        // reference types — alias, shared mutation, identity `===`).
        const struct = this.structName(objType);
        return {
          code: `std::make_shared<${struct}>(${struct}{${items}})`,
          type: objType,
        };
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
        const i = `static_cast<std::size_t>(${idx.code})`;
        // `s[i]` on a string yields a one-char string (JS has no char type).
        if (arr.type === "string") {
          return {
            code: `tsn_str(std::string(1, (${arr.code}).str()[${i}]))`,
            type: "string",
          };
        }
        // Array elements use the f64 rep (vector<double> for number[]). The array
        // is a shared_ptr, so dereference to reach the vector before indexing.
        return {
          code: `(*(${arr.code}))[${i}]`,
          type: arr.type.element,
          rep: arr.type.element === "number" ? "f64" : undefined,
        };
      }
      case "member": {
        const obj = this.emitReceiver(e.obj);
        // `arr.length` / `str.length` — size() is a non-negative integer (i64). An
        // array is a shared_ptr (`->size()`); a string is a value (`.size()`).
        if (isArray(obj.type) || obj.type === "string") {
          if (e.name === "length") {
            const size = isArray(obj.type)
              ? `(${obj.code})->size()`
              : `(${obj.code}).size()`;
            return {
              code: `static_cast<long long>(${size})`,
              type: "number",
              rep: "i64",
            };
          }
          const kind = isArray(obj.type) ? "Arrays" : "Strings";
          throw new Error(`${kind} have no property '${e.name}'`);
        }
        // `obj.field` — object fields use the f64 rep. The object is a shared_ptr,
        // so access through `->`.
        if (isObject(obj.type)) {
          const field = obj.type.fields.find((f) => f.name === e.name);
          if (!field) {
            throw new Error(
              `Property '${e.name}' does not exist on type '${displayType(obj.type)}'`,
            );
          }
          return {
            code: `(${obj.code})->${e.name}`,
            type: field.type,
            rep: field.type === "number" ? "f64" : undefined,
          };
        }
        // `instance.field` — `->` through the shared_ptr/`this`; fields are f64.
        if (isClass(obj.type)) {
          return this.classField(obj, e.name);
        }
        throw new Error(
          `Type '${displayType(obj.type)}' has no property '${e.name}'`,
        );
      }
      case "this":
        // Bare `this` as a value is not supported; member/methodCall/emitLValue
        // shortcut `this` via emitReceiver, so reaching here means a misuse.
        throw new Error(
          "'this' may only be used as 'this.field' or 'this.method(...)' (v1)",
        );
      case "new": {
        const cls = this.classes.get(e.className);
        if (!cls) throw new Error(`Unknown class: ${e.className}`);
        const args = this.checkArgs(
          e.className,
          cls.ctor.params.map((p) => p.type),
          e.args,
        );
        return {
          code: `std::make_shared<${e.className}>(${args.join(", ")})`,
          type: { kind: "class", name: e.className },
        };
      }
      case "call": {
        const val = this.emitCall(e, /*asStatement*/ false);
        const rep =
          val.type === "number" ? this.reps.retRep(e.callee) : undefined;
        return { code: val.code, type: val.type as Type, rep };
      }
      case "methodCall": {
        const val = this.emitMethodCall(e, /*asStatement*/ false);
        // charCodeAt / indexOf return numbers in the f64 rep (can be NaN / -1).
        const rep = val.type === "number" ? "f64" : undefined;
        return { code: val.code, type: val.type as Type, rep };
      }
    }
  }

  // A field load/lvalue on a class instance: `(recv)->field`. Fields use the f64
  // rep, like object fields. Shared by emitExpr and emitLValue.
  private classField(recv: Value, name: string): Value {
    const cls = this.classes.get((recv.type as ClassType).name)!;
    const field = cls.fields.find((f) => f.name === name);
    if (!field) {
      throw new Error(
        `Property '${name}' does not exist on class '${cls.name}'`,
      );
    }
    return {
      code: `(${recv.code})->${name}`,
      type: field.type,
      rep: field.type === "number" ? "f64" : undefined,
    };
  }

  // Type-check a call/ctor argument list against parameter types and return each
  // argument's C++ code. Reps are reconciled by repr.ts (a float arg demotes the
  // matching param slot), so no per-argument cast is needed here.
  private checkArgs(who: string, params: Type[], args: Expr[]): string[] {
    if (args.length !== params.length) {
      throw new Error(
        `'${who}' expects ${params.length} argument(s), got ${args.length}`,
      );
    }
    return args.map((a, i) => {
      const val = this.emitExpr(a);
      if (!sameType(val.type, params[i])) {
        throw new Error(
          `Argument ${i + 1} of '${who}': type '${displayType(val.type)}' is not assignable to '${displayType(params[i])}'`,
        );
      }
      return val.code;
    });
  }

  private emitBinary(e: { op: BinaryOp; left: Expr; right: Expr }): Value {
    const l = this.emitExpr(e.left);
    const r = this.emitExpr(e.right);
    const code = `(${l.code} ${CPP_OP[e.op]} ${r.code})`;

    if (ARITH.has(e.op)) {
      // `+` with a string operand is concatenation. Each operand becomes a
      // tsn_str (a number coerces to its JS string form), then tsn_str's
      // operator+ produces the concatenated tsn_str.
      if (e.op === "+" && (l.type === "string" || r.type === "string")) {
        const okConcat = (t: Type) => t === "string" || t === "number";
        if (!okConcat(l.type) || !okConcat(r.type)) {
          throw new Error(
            `Cannot concatenate '${displayType(l.type)}' and '${displayType(r.type)}'`,
          );
        }
        // An i64 number prints exactly via std::to_string; an f64 uses the
        // shortest-round-trip formatter.
        const strForm = (v: Value) =>
          v.type !== "number"
            ? v.code
            : v.rep === "i64"
              ? `tsn_str(std::to_string(${v.code}))`
              : `tsn_str(tsn_num_to_string(${v.code}))`;
        return { code: `(${strForm(l)} + ${strForm(r)})`, type: "string" };
      }
      if (l.type !== "number" || r.type !== "number") {
        throw new Error(`Operator '${e.op}' expects numbers`);
      }
      const lr = l.rep ?? "f64";
      const rr = r.rep ?? "f64";
      // Cast an i64 operand to double where float arithmetic is required.
      const asF64 = (v: Value) =>
        v.rep === "i64" ? `static_cast<double>(${v.code})` : v.code;
      if (e.op === "/") {
        // JS `/` is always float division — this is also what stops two integer
        // operands from doing C++ truncating integer division.
        return { code: `(${asF64(l)} / ${asF64(r)})`, type: "number", rep: "f64" };
      }
      if (e.op === "%") {
        // Integer operands take the fast guarded integer remainder; otherwise
        // tsn_mod's fmod path. Either way the result is f64, so `x % 0 === NaN`.
        const modCode =
          lr === "i64" && rr === "i64"
            ? `tsn_imod(${l.code}, ${r.code})`
            : `tsn_mod(${asF64(l)}, ${asF64(r)})`;
        return { code: modCode, type: "number", rep: "f64" };
      }
      // `+` `-` `*` — integer only when both operands are; a mixed pair is
      // promoted to double by C++. (`code` is `(l <op> r)`.)
      return { code, type: "number", rep: combineRep(lr, rr) };
    }
    if (RELATIONAL.has(e.op)) {
      // Lexicographic ordering on strings (tsn_str compares this way).
      if (l.type === "string" && r.type === "string") {
        return { code, type: "boolean" };
      }
      if (l.type !== "number" || r.type !== "number") {
        throw new Error(`Operator '${e.op}' expects numbers or strings`);
      }
      return { code, type: "boolean" };
    }
    if (EQUALITY.has(e.op)) {
      if (!sameType(l.type, r.type)) {
        throw new Error(
          `Cannot compare '${displayType(l.type)}' and '${displayType(r.type)}' with '${e.op}'`,
        );
      }
      // number/boolean: value comparison; string: tsn_str's value `==`/`!=`;
      // arrays/objects/class instances: shared_ptr **identity** (`==` on the
      // pointer) — JS reference equality, so two distinct literals with the same
      // contents are `!==`, and an alias (`let b = a`) is `===`.
      return { code, type: "boolean" };
    }
    // logical && || — JS semantics: the result is one of the *operands*, not a
    // coerced boolean. Both-boolean keeps the simple boolean result (and stays a
    // usable C++ condition); `false`/`true` are already the operands there.
    if (l.type === "boolean" && r.type === "boolean") {
      return { code, type: "boolean" };
    }
    // Otherwise the operands must share a type, and that's the result type: `||`
    // yields the first truthy operand, `&&` the first falsy one. An immediately-
    // invoked lambda evaluates the left operand exactly once (binding it to `_t`)
    // and the right only on the branch that needs it — preserving short-circuit
    // and avoiding double-evaluating a side-effecting left operand.
    if (!sameType(l.type, r.type)) {
      throw new Error(
        `Operator '${e.op}' needs operands of the same type, got '${displayType(l.type)}' and '${displayType(r.type)}'`,
      );
    }
    const ternary =
      e.op === "||"
        ? `tsn_truthy(_t) ? _t : (${r.code})`
        : `tsn_truthy(_t) ? (${r.code}) : _t`;
    const iife = `([&]() { auto _t = (${l.code}); return ${ternary}; }())`;
    const rep =
      l.type === "number"
        ? combineRep(l.rep ?? "f64", r.rep ?? "f64")
        : undefined;
    return { code: iife, type: l.type, rep };
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

  // Emit a method call: an instance method, a string method (substring/slice/
  // indexOf/charAt/…), or an array method (push/pop/slice/indexOf/join). Array
  // push returns the new length; pop/slice/indexOf map to tsn_* template helpers.
  private emitMethodCall(
    e: { receiver: Expr; method: string; args: Expr[] },
    asStatement: boolean,
  ): { code: string; type: RetType } {
    const recv = this.emitReceiver(e.receiver);
    if (isClass(recv.type)) {
      return this.emitInstanceMethod(recv, e, asStatement);
    }
    if (recv.type === "string") {
      return this.emitStringMethod(recv, e);
    }
    if (isArray(recv.type)) {
      const elem = recv.type.element;
      // The array is a shared_ptr; the tsn_* helpers take the vector, so the
      // receiver is dereferenced (`*ptr`) at each call site.
      const vecRecv = `*(${recv.code})`;
      switch (e.method) {
        case "push": {
          if (e.args.length !== 1) {
            throw new Error(`'push' expects 1 argument, got ${e.args.length}`);
          }
          const arg = this.emitExpr(e.args[0]);
          if (!sameType(arg.type, elem)) {
            throw new Error(
              `Cannot push '${displayType(arg.type)}' onto '${displayType(recv.type)}'`,
            );
          }
          // Mutating through the shared vector is visible to every alias (JS).
          // Returns the new length (a number); usable as a value or a statement.
          return { code: `tsn_push(${vecRecv}, ${arg.code})`, type: "number" };
        }
        case "pop": {
          if (e.args.length !== 0) {
            throw new Error(`'pop' expects 0 arguments, got ${e.args.length}`);
          }
          // Returns the removed last element (the array's element type).
          return { code: `tsn_pop(${vecRecv})`, type: elem };
        }
        case "slice": {
          // `slice(start?, end?)` — both optional numbers; an omitted one is NaN
          // ("default") in the helper. Returns a *new* array (a fresh shared_ptr).
          if (e.args.length > 2) {
            throw new Error(`'slice' expects 0-2 argument(s), got ${e.args.length}`);
          }
          const nums = e.args.map((a) => this.emitExpr(a));
          for (const n of nums) {
            if (n.type !== "number") {
              throw new Error("'slice' arguments must be numbers");
            }
          }
          const start = nums[0]?.code ?? "NAN";
          const end = nums[1]?.code ?? "NAN";
          const vec = this.vecType(recv.type);
          return {
            code: `std::make_shared<${vec}>(tsn_array_slice(${vecRecv}, ${start}, ${end}))`,
            type: recv.type,
          };
        }
        case "indexOf": {
          // `indexOf(searchElement, fromIndex?)` -> number (-1 if absent). Needs
          // element equality, so aggregate (object/array) elements are rejected.
          if (e.args.length < 1 || e.args.length > 2) {
            throw new Error(
              `'indexOf' expects 1-2 argument(s), got ${e.args.length}`,
            );
          }
          if (isAggregate(elem)) {
            throw new Error(
              `'indexOf' is not supported on '${displayType(recv.type)}' (elements have no equality)`,
            );
          }
          const search = this.emitExpr(e.args[0]);
          if (!sameType(search.type, elem)) {
            throw new Error(
              `'indexOf' search type '${displayType(search.type)}' does not match element type '${displayType(elem)}'`,
            );
          }
          let from = "NAN";
          if (e.args.length === 2) {
            const f = this.emitExpr(e.args[1]);
            if (f.type !== "number") {
              throw new Error("'indexOf' fromIndex must be a number");
            }
            from = f.code;
          }
          // f64SlotCode casts an i64-literal search value to the element's double
          // rep (a no-op for string/boolean/class), so the template deduces one T.
          return {
            code: `tsn_array_index_of(${vecRecv}, ${this.f64SlotCode(search)}, ${from})`,
            type: "number",
          };
        }
        case "join": {
          if (e.args.length > 1) {
            throw new Error(`'join' expects 0-1 argument(s), got ${e.args.length}`);
          }
          if (elem !== "string" && elem !== "number") {
            throw new Error(
              `'join' is only supported on string[] or number[], not '${displayType(recv.type)}'`,
            );
          }
          // Separator defaults to "," (JS); a provided one must be a string.
          let sep = `","`;
          if (e.args.length === 1) {
            const arg = this.emitExpr(e.args[0]);
            if (arg.type !== "string") {
              throw new Error("'join' separator must be a string");
            }
            sep = arg.code;
          }
          return { code: `tsn_join(${vecRecv}, ${sep})`, type: "string" };
        }
        default:
          throw new Error(`Unsupported array method '${e.method}'`);
      }
    }
    throw new Error(
      `Type '${displayType(recv.type)}' has no method '${e.method}'`,
    );
  }

  // Emit an instance method call: `(recv)->method(args)`. The method is resolved
  // on the receiver's class; args are type-checked against its parameters. A void
  // method is callable only in statement position (like a void function).
  private emitInstanceMethod(
    recv: Value,
    e: { method: string; args: Expr[] },
    asStatement: boolean,
  ): { code: string; type: RetType } {
    const cls = this.classes.get((recv.type as ClassType).name)!;
    const method = cls.methods.find((m) => m.name === e.method);
    if (!method) {
      throw new Error(`Class '${cls.name}' has no method '${e.method}'`);
    }
    const args = this.checkArgs(
      `${cls.name}.${e.method}`,
      method.params.map((p) => p.type),
      e.args,
    );
    if (method.returnType === "void" && !asStatement) {
      throw new Error(
        `'${cls.name}.${e.method}' returns void and cannot be used as a value`,
      );
    }
    return {
      code: `(${recv.code})->${e.method}(${args.join(", ")})`,
      type: method.returnType,
    };
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
      case "split": {
        // `split(sep: string, limit?: number)` -> string[]. Regex separators are
        // outside the subset (a regex literal already fails at lowering).
        if (argv.length < 1 || argv.length > 2) {
          throw new Error(`'split' expects 1-2 argument(s), got ${argv.length}`);
        }
        if (argv[0].type !== "string") {
          throw new Error("'split' separator must be a string");
        }
        if (argv.length === 2 && argv[1].type !== "number") {
          throw new Error("'split' limit must be a number");
        }
        const limit = argv.length === 2 ? argv[1].code : "NAN";
        // Returns a reference-typed string[] (a shared_ptr to the result vector).
        return {
          code: `std::make_shared<std::vector<tsn_str>>(tsn_split(${s}, ${argv[0].code}, ${limit}))`,
          type: { kind: "array", element: "string" },
        };
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
