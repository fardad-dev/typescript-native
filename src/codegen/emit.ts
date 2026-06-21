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
  SwitchCase,
} from "../ir/nodes";
import { analyze, RepTable, Rep, litRep, combineRep, MAIN_KEY } from "./repr";
import { prepareClosures } from "./closures";

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
type MapType = { kind: "map"; key: Type; value: Type };
type SetType = { kind: "set"; element: Type };
type PromiseType = { kind: "promise"; value?: Type };
type ResponseType = { kind: "response" };
type UnionType = { kind: "union"; members: Type[] };
type FunctionType = {
  kind: "function";
  params: Type[];
  ret: RetType;
  restParam?: boolean;
};

function isArray(t: Type): t is ArrayType {
  return typeof t === "object" && t.kind === "array";
}
function isObject(t: Type): t is ObjectType {
  return typeof t === "object" && t.kind === "object";
}
function isMap(t: Type): t is MapType {
  return typeof t === "object" && t.kind === "map";
}
function isSet(t: Type): t is SetType {
  return typeof t === "object" && t.kind === "set";
}
// A `Promise<T>` (reference type, a coroutine handle). `value` absent ⇒ `Promise<void>`.
function isPromise(t: Type): t is PromiseType {
  return typeof t === "object" && t.kind === "promise";
}
// A class instance is a *reference* type, deliberately NOT an "aggregate": those
// (array/object) are value types passed by const& and read-only, whereas an
// instance is a shared_ptr passed by value and freely mutable (see paramType).
function isClass(t: Type): t is ClassType {
  return typeof t === "object" && t.kind === "class";
}
// A `fetch` Response (reference type → `tsn_rc<tsn_response>`).
function isResponse(t: Type): t is ResponseType {
  return typeof t === "object" && t.kind === "response";
}
// A union `A | B | …` (value type → `tsn_union<…>`, a `std::variant` wrapper).
function isUnion(t: Type): t is UnionType {
  return typeof t === "object" && t.kind === "union";
}
// A first-class function value (reference type → `std::function<…>`).
function isFunction(t: Type): t is FunctionType {
  return typeof t === "object" && t.kind === "function";
}
function isAggregate(t: Type): boolean {
  return isArray(t) || isObject(t);
}

// Lexicographic 3-way string comparison (by code unit) for `Array.sort`
// comparators — `<`/`>`, not `localeCompare`, so the ordering is byte-stable.
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// The mangled incoming-argument name for a BOXED parameter: the function receives
// the value under this name, then copies it into a cell named after the parameter
// (so the body's `(name)->v` accesses, and any closure capturing `name`, share it).
function boxArgName(name: string): string {
  return `_tsnarg_${name}`;
}

// The mangled incoming-argument name for a DEFAULT parameter: the function
// receives the value at the boundary as `T | undefined` under this name, then
// rebinds the user's parameter `name` to `T` at entry (the default expression when
// the argument was omitted — `undefined` — else the passed value).
function defaultArgName(name: string): string {
  return `_tsndef_${name}`;
}

function displayType(t: RetType): string {
  if (t === "void") return "void";
  if (isClass(t)) return t.name;
  if (isArray(t)) return `${displayType(t.element)}[]`;
  if (isMap(t)) return `Map<${displayType(t.key)}, ${displayType(t.value)}>`;
  if (isSet(t)) return `Set<${displayType(t.element)}>`;
  if (isPromise(t)) {
    return `Promise<${t.value === undefined ? "void" : displayType(t.value)}>`;
  }
  if (isResponse(t)) return "Response";
  if (isUnion(t)) return t.members.map((m) => displayType(m)).join(" | ");
  if (isFunction(t)) {
    const ps = t.params.map((p) => displayType(p)).join(", ");
    return `(${ps}) => ${t.ret === "void" ? "void" : displayType(t.ret)}`;
  }
  if (isObject(t)) {
    return `{ ${t.fields.map((f) => `${f.name}: ${displayType(f.type)}`).join("; ")} }`;
  }
  return t;
}

function sameType(a: Type, b: Type): boolean {
  // Unions: equal iff same member set (order-independent — canonicalization keeps
  // them ordered, but compare as sets so a hand-built union still matches).
  if (isUnion(a) || isUnion(b)) {
    if (!isUnion(a) || !isUnion(b)) return false;
    if (a.members.length !== b.members.length) return false;
    return a.members.every((ma) => b.members.some((mb) => sameType(ma, mb)));
  }
  // Class instances are nominal: equal iff they name the same class.
  if (isClass(a) || isClass(b))
    return isClass(a) && isClass(b) && a.name === b.name;
  // Map/Set: equal iff their key/value/element types match (structural).
  if (isMap(a) || isMap(b))
    return (
      isMap(a) &&
      isMap(b) &&
      sameType(a.key, b.key) &&
      sameType(a.value, b.value)
    );
  if (isSet(a) || isSet(b))
    return isSet(a) && isSet(b) && sameType(a.element, b.element);
  // Promises: equal iff both resolve to the same type (or both are Promise<void>).
  if (isPromise(a) || isPromise(b)) {
    if (!isPromise(a) || !isPromise(b)) return false;
    if (a.value === undefined || b.value === undefined)
      return a.value === b.value;
    return sameType(a.value, b.value);
  }
  // Response is a singleton built-in type (no parameters).
  if (isResponse(a) || isResponse(b)) return isResponse(a) && isResponse(b);
  // Function types: equal iff same arity, same parameter types, same rest-ness,
  // and same return type.
  if (isFunction(a) || isFunction(b)) {
    if (!isFunction(a) || !isFunction(b)) return false;
    if (a.params.length !== b.params.length) return false;
    if (!!a.restParam !== !!b.restParam) return false;
    if (!a.params.every((pa, i) => sameType(pa, b.params[i]))) return false;
    if (a.ret === "void" || b.ret === "void") return a.ret === b.ret;
    return sameType(a.ret, b.ret);
  }
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
  params: Param[];
  ret: RetType;
}

// A normalized call-site parameter slot, derived from a Param[] (named calls,
// methods, ctors) or a function `Type` (function-value calls). `optional` ⇒ the
// argument may be omitted (an optional `a?: T` or a defaulted `a: T = …` param);
// `rest` ⇒ this is the trailing rest parameter (`type` is its `T[]`), which
// collects zero or more trailing arguments. `type` is the *boundary* type — for a
// defaulted param that's `T | undefined`, even though the body sees `T`.
interface CallSlot {
  type: Type;
  optional: boolean;
  rest: boolean;
}

// An enclosing breakable/continuable construct, tracked on a stack so `break` /
// `continue` (labeled or not) resolve to the right target. A loop or switch is
// emitted in one of two forms:
//   - native (`goto: false`): a plain C++ loop, so `break`/`continue` are the C++
//     keywords. Used for every *unlabeled* loop.
//   - goto-form (`goto: true`): the loop/switch carries explicit C++ labels and
//     `break`/`continue` become `goto`s. Used for every *labeled* loop (so a
//     labeled break/continue can jump to it) and for every `switch` (whose JS
//     fall-through semantics are themselves compiled with labels — see emitStmt).
interface BreakCtx {
  label?: string; // the JS label, if this is a labeled loop
  kind: "loop" | "switch";
  goto: boolean;
  breakLabel?: string; // C++ label jumped to by `break` (goto-form)
  continueLabel?: string; // C++ label jumped to by `continue` (goto-form loops)
}

// Emit the C++ source for a module, plus `usesFetch` — whether the program calls
// `fetch` (and so needs the `-lcurl` link flag; the `#define TSN_ENABLE_FETCH` is
// already baked into `cpp`). The driver threads `usesFetch` to the backend.
export function emit(mod: Module): { cpp: string; usesFetch: boolean } {
  const emitter = new Emitter();
  const cpp = emitter.emitModule(mod);
  return { cpp, usesFetch: emitter.fetchUsed };
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

  // Monotonic counter for uniquely naming the locals of the inline lambdas that
  // JSON.parse extraction emits (so nested lambdas never shadow one another).
  private jsonUid = 0;

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

  // True if the whole module uses async (any function/method is async). Gates the
  // one `tsn_run_microtasks()` drain in main(); kept false for non-async programs
  // so their emitted main() stays byte-identical.
  private usesAsync = false;

  // True once a `fetch(...)`/`res.json()` is emitted. Gates the `#define
  // TSN_ENABLE_FETCH` (which turns on the curl include + tsn_fetch in the runtime
  // header) and the `-lcurl` link flag (threaded out via `usesFetch`). A non-fetch
  // program emits neither and links exactly as before. Read after emitModule.
  private usesFetch = false;
  get fetchUsed(): boolean {
    return this.usesFetch;
  }

  // Per-function scratch, reset by resetForFunction().
  private body: string[] = [];
  private vars = new Map<string, Type>();
  // Flow-narrowing: a union-typed variable narrowed by an enclosing `typeof`/`===
  // null`/truthiness guard. `vars` keeps the *declared* union; this overrides it
  // for reads inside the guarded region (a single-member narrowing emits a
  // `std::get`). Installed by the `if`/ternary emitters, restored on block exit,
  // and dropped on reassignment (see `analyzeGuard` / the `var` read).
  private narrowed = new Map<string, Type>();
  // Names (in the current scope) that are BOXED — captured by a nested closure, so
  // stored in a `tsn_rc<tsn_box<…>>` cell. A read/write of such a variable goes
  // through the cell (`(name)->v`). Set when a boxed binding is declared (its node
  // carries the `boxed` flag from the capture pass), inherited into closures (whose
  // `[=]` captures the shared cell), and dropped when the binding leaves scope.
  private boxed = new Set<string>();
  private curReturn: RetType = "void";
  // When emitting a closure with no declared return type, the return type is
  // INFERRED from its `return` statements: `inferRet` switches the `return` emitter
  // into collect-mode and `inferredRets` accumulates the returned value types.
  private inferRet = false;
  private inferredRets: RetType[] = [];
  // True while emitting an async function/method body — a C++20 coroutine, so a
  // `return` is `co_return` and `await` is `co_await` (and is rejected elsewhere).
  private curAsync = false;
  private funcKey: string = MAIN_KEY; // scope key for repr lookups
  // The class whose method/constructor body is being emitted (so `this` resolves);
  // undefined inside free functions and main.
  private currentClass?: ClassDecl;
  private indent = "  ";
  // Stack of enclosing loops/switches, for `break`/`continue` resolution.
  private breakStack: BreakCtx[] = [];
  // A pending JS label from a `labeled` statement, consumed by the loop it wraps.
  private pendingLabel?: string;
  // Monotonic counter for the C++ labels / temporaries control-flow lowering emits
  // (loop break/continue labels, switch dispatch labels, for-of/in temporaries,
  // finally guards). Reset per function so names stay short and stable.
  private ctrlUid = 0;

  emitModule(mod: Module): string {
    // Assign closure ids + mark captured locals as boxed (before repr/emit, which
    // both rely on `closure.id` and the `boxed` flags). See codegen/closures.ts.
    prepareClosures(mod);
    this.reps = analyze(mod); // decide each number slot's representation
    // Does any function/method use async? If so, main() drains the microtask queue
    // after the synchronous top-level (the event loop). Non-async programs skip it.
    this.usesAsync =
      mod.functions.some((f) => f.async) ||
      mod.classes.some((c) => c.methods.some((m) => m.async));

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
        params: fn.params,
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
    // other (or itself) through `tsn_rc<…>` (a pointer to an incomplete type is
    // fine). With reference-typed aggregates, struct *members* are also tsn_rc
    // pointers, so struct order no longer needs inner-before-outer.
    const classFwd = mod.classes.map((c) => `struct ${c.name};`);
    const structFwd = [...this.structNames.values()].map((n) => `struct ${n};`);
    // Per-type `tsn_inspect` overloads (computed after all structs are known, so
    // every aggregate/instance type is covered) — see the JS-style printing block.
    const inspectFwd = this.inspectFwdDecls();
    const inspectDefs = this.aggregateInspectDefs();
    // Per-type `tsn_json_stringify` overloads — same per-object/class machinery as
    // tsn_inspect, but JSON output. (JSON.parse needs no per-type defs — it emits
    // inline extraction lambdas.)
    const jsonFwd = this.jsonStringifyFwdDecls();
    const jsonDefs = this.aggregateJsonStringifyDefs();

    return [
      // `fetch` programs define this BEFORE including the runtime so its guarded
      // curl include + tsn_fetch compile in (and the driver adds `-lcurl`). A
      // non-fetch program emits neither line, so its .cpp is byte-identical.
      ...(this.usesFetch ? [`#define TSN_ENABLE_FETCH 1`] : []),
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
      ...(jsonFwd.length ? [...jsonFwd, ``] : []),
      ...(this.structDefs.length ? [...this.structDefs, ``] : []),
      ...(classStructs.length ? [classStructs.join("\n\n"), ``] : []),
      ...(inspectDefs.length ? [inspectDefs.join("\n\n"), ``] : []),
      ...(jsonDefs.length ? [jsonDefs.join("\n\n"), ``] : []),
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
  // are all *reference* types — a `tsn_rc` (non-atomic ref-counted pointer) to a
  // heap value — so copy/assign aliases the same value (JS reference semantics) and
  // `===` is pointer identity. `tsn_rc` is used instead of `std::shared_ptr` because
  // generated programs are single-threaded: shared_ptr's atomic refcount is pure
  // overhead and dominates element-shuffling hot loops (see tsn_rc in the runtime).
  // The pointee (the `std::vector<T>` / generated `struct`) is what `vecType` /
  // `structName` return.
  private cppType(t: Type): string {
    if (isArray(t)) return `tsn_rc<${this.vecType(t)}>`;
    if (isObject(t)) return `tsn_rc<${this.structName(t)}>`;
    if (isClass(t)) return `tsn_rc<${t.name}>`; // reference-typed instance
    if (isMap(t)) return `tsn_rc<${this.mapPointee(t)}>`;
    if (isSet(t)) return `tsn_rc<${this.setPointee(t)}>`;
    // A `Promise<T>` is a coroutine return type / awaitable (its own handle holds
    // a shared_ptr to the promise state, so it's a reference type). Promise<void>
    // resolves to `tsn_unit`. Resolved numbers use the f64 rep (like array elements).
    if (isPromise(t)) {
      return `tsn_promise<${t.value === undefined ? "tsn_unit" : this.cppType(t.value)}>`;
    }
    // A `fetch` Response — a reference-typed built-in (runtime `tsn_response`).
    if (isResponse(t)) return "tsn_rc<tsn_response>";
    // A union → `tsn_union<…>` (a `std::variant` wrapper). Members are emitted in a
    // deterministic, rename-stable order (see `unionMemberCpps`) so two structurally
    // equal unions always produce byte-identical C++ type text.
    if (isUnion(t)) return `tsn_union<${this.unionMemberCpps(t).join(", ")}>`;
    // A function value → `std::function<Ret(P0, …)>`. Number params/returns use the
    // f64 rep (`cppType` maps number→double), so the C++ type is context-stable: a
    // function value's signature is the same wherever it appears.
    if (isFunction(t)) {
      const ret = t.ret === "void" ? "void" : this.cppType(t.ret);
      const params = t.params.map((p) => this.cppType(p)).join(", ");
      return `std::function<${ret}(${params})>`;
    }
    if (t === "null") return "tsn_null";
    if (t === "undefined") return "tsn_undefined";
    if (t === "number") return "double"; // f64 rep — the default for nested aggregates
    if (t === "boolean") return "bool";
    return "tsn_str"; // string — a ref-counted immutable string (see prelude)
  }

  // The C++ member types of a union, in a deterministic order: `undefined`/`null`
  // first (so the variant's default alternative — used for a `Map.get` miss on a
  // `T | undefined` value — is the JS-correct default), then the rest sorted by
  // their C++ type text. Sorting by the *final* (post-rename) C++ type makes the
  // order rename-stable, so `number | string` and `string | number` emit the same
  // `tsn_union<double, tsn_str>`.
  private unionMemberCpps(t: UnionType): string[] {
    const rank = (m: Type) => (m === "undefined" ? 0 : m === "null" ? 1 : 2);
    return t.members
      .map((m) => ({ m, cpp: this.cppType(m) }))
      .sort((a, b) => rank(a.m) - rank(b.m) || byteCompare(a.cpp, b.cpp))
      .map((x) => x.cpp);
  }

  // Whether a value of type `source` may be stored in a slot of type `target`,
  // beyond exact `sameType`: a member widens into a union (`number` → `number |
  // string`), and a union widens into a union whose members are a superset. The
  // reverse (a wider union into a narrower target/member) is NOT assignable — it
  // needs explicit narrowing (`typeof`). Widening is top-level only; nested element
  // unions must match structurally (so `number[]` is not assignable to
  // `(number | string)[]` — that would need a runtime element rebuild).
  private isAssignable(target: Type, source: Type): boolean {
    if (sameType(target, source)) return true;
    if (isUnion(target)) {
      if (isUnion(source)) {
        return source.members.every((sm) =>
          target.members.some((tm) => sameType(tm, sm)),
        );
      }
      return target.members.some((tm) => sameType(tm, source));
    }
    return false;
  }

  // Code for `value` stored in a slot of type `target`. Identity when the types
  // already match; when widening a member into a union, construct the variant
  // explicitly with `std::in_place_type<Member>` — this avoids `std::variant`'s
  // converting-constructor ambiguity (e.g. `double` vs `bool` both accept an int).
  // A number member stores in the f64 rep (an i64 value is cast).
  private coerceTo(value: Value, target: Type): string {
    if (sameType(value.type, target) || !isUnion(target)) return value.code;
    if (isUnion(value.type)) {
      // Narrower union → wider union: the C++ variant types differ, so rebuild the
      // wider variant around the active member at runtime (isAssignable has already
      // verified every source member is an alternative of the target).
      return `tsn_union_widen<${this.cppType(target)}>(${value.code})`;
    }
    const mcpp = this.cppType(value.type);
    const inner = this.f64SlotCode(value); // i64 number → double for the f64 member
    return `${this.cppType(target)}(std::in_place_type<${mcpp}>, ${inner})`;
  }

  // The JS `typeof` string for a non-union type (statically known). Note the JS
  // quirk: `typeof null === "object"`. Every reference type is `"object"`.
  private staticTypeof(t: Type): string {
    if (t === "number") return "number";
    if (t === "string") return "string";
    if (t === "boolean") return "boolean";
    if (t === "undefined") return "undefined";
    if (isFunction(t)) return "function";
    return "object"; // null, array, object, class, map, set, promise, response
  }

  // The pointee vector type for an array reference (`std::vector<T>`), e.g. for
  // `tsn_make_rc` and slice results. `cppType` wraps this in a `tsn_rc`.
  private vecType(t: ArrayType): string {
    return `std::vector<${this.cppType(t.element)}>`;
  }

  // The pointee tsn_map / tsn_set type for a Map/Set reference. Keys, values, and
  // elements use the f64 number rep (`cppType(number)` = `double`), like array
  // elements; `cppType` wraps these in a `shared_ptr`.
  private mapPointee(t: MapType): string {
    return `tsn_map<${this.cppType(t.key)}, ${this.cppType(t.value)}>`;
  }
  private setPointee(t: SetType): string {
    return `tsn_set<${this.cppType(t.element)}>`;
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

  // `tsn_inspect(const tsn_rc<NAME>&)` forward declarations, one per
  // generated object struct and per class (a shared_ptr to an incomplete type is
  // fine in a declaration, so these can precede the full type definitions).
  private inspectFwdDecls(): string[] {
    const names = [...this.structFields.keys(), ...this.classes.keys()];
    return names.map(
      (n) => `static std::string tsn_inspect(const tsn_rc<${n}>& v);`,
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
        `static std::string tsn_inspect(const tsn_rc<${name}>& v) {`,
        `  if (!v) return "null";`,
        `  return "${prefix}{}";`,
        `}`,
      ].join("\n");
    }
    const lines = [
      `static std::string tsn_inspect(const tsn_rc<${name}>& v) {`,
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

  // --- JSON.stringify (per-object / per-class overloads) ------------------
  //
  // Mirrors the tsn_inspect machinery exactly (the runtime carries the scalar
  // overloads + array template; these are the program-dependent ones that need
  // field names), but emits JSON: double-quoted keys, no spaces, and no class
  // name on an instance — `JSON.stringify(new Pt(1,2))` is `{"x":1,"y":2}`.

  // `tsn_json_stringify(const tsn_rc<NAME>&)` forward declarations.
  private jsonStringifyFwdDecls(): string[] {
    const names = [...this.structFields.keys(), ...this.classes.keys()];
    return names.map(
      (n) => `static std::string tsn_json_stringify(const tsn_rc<${n}>& v);`,
    );
  }

  // The `tsn_json_stringify` definitions for every object struct and class.
  private aggregateJsonStringifyDefs(): string[] {
    const defs: string[] = [];
    for (const [name, fields] of this.structFields) {
      defs.push(this.jsonStringifyBody(name, fields));
    }
    for (const cls of this.classes.values()) {
      defs.push(this.jsonStringifyBody(cls.name, cls.fields));
    }
    return defs;
  }

  // One `tsn_json_stringify` body. Each field recurses through tsn_json_stringify
  // (nested objects/arrays/strings are serialized correctly); a null pointer (an
  // uninitialized global) serializes as `null`, like JS.
  private jsonStringifyBody(name: string, fields: Field[]): string {
    if (fields.length === 0) {
      return [
        `static std::string tsn_json_stringify(const tsn_rc<${name}>& v) {`,
        `  if (!v) return "null";`,
        `  return "{}";`,
        `}`,
      ].join("\n");
    }
    const lines = [
      `static std::string tsn_json_stringify(const tsn_rc<${name}>& v) {`,
      `  if (!v) return "null";`,
      `  std::string out = "{";`,
    ];
    fields.forEach((f, i) => {
      // The leading separator + the JSON-quoted key, e.g. `,"x":`.
      const key = cppStringLiteral(
        `${i === 0 ? "" : ","}${JSON.stringify(f.name)}:`,
      );
      lines.push(`  out += ${key}; out += tsn_json_stringify(v->${f.name});`);
    });
    lines.push(`  out += "}";`);
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
  //  - A **default** parameter is received at the boundary as `T | undefined`
  //    under a mangled name (`defaultArgName`); the body rebinds it (see bindParams).
  //  - A **boxed** (captured) parameter is received under `boxArgName` and copied
  //    into its cell at entry.
  //  - Everything else uses its slot type and own name.
  private declParams(funcKey: string, params: Param[]): string {
    return params
      .map((p) => {
        if (p.default !== undefined) {
          return `${this.cppType(this.optionalUnion(p.type))} ${defaultArgName(p.name)}`;
        }
        const name = p.boxed ? boxArgName(p.name) : p.name;
        return `${this.paramType(funcKey, p)} ${name}`;
      })
      .join(", ");
  }

  // Register parameters as local variables. Every parameter is mutable now —
  // arrays/objects are reference types (a `shared_ptr` alias), so a callee
  // mutation is visible to the caller, exactly like JS. A **boxed** (captured)
  // parameter is received under a mangled name (see `declParams`) and copied into a
  // heap cell at entry, so the parameter and any closures over it share one binding.
  private bindParams(params: Param[]): void {
    for (const p of params) {
      // A **default** parameter is resolved at entry: the passed value if present,
      // else the default expression (emitted HERE — in the body's scope, with
      // earlier params already bound, so it may reference them; evaluated left to
      // right). The incoming arg is the boundary union `T | undefined`.
      const valueCode = p.default !== undefined ? this.resolveDefault(p) : undefined;
      this.vars.set(p.name, p.type);
      if (p.boxed) {
        // Captured: box the resolved/incoming value into a shared heap cell.
        this.boxed.add(p.name);
        const elem = this.boxElemType(p.type);
        const init = valueCode ?? boxArgName(p.name);
        this.push(
          `${this.boxType(p.type)} ${p.name} = tsn_make_rc<tsn_box<${elem}>>(tsn_box<${elem}>{${init}});`,
        );
      } else if (valueCode !== undefined) {
        // Defaulted, not captured: declare the body local `p: T` from the resolve.
        const cpp = this.slotType(p.type, this.reps.varRep(this.funcKey, p.name));
        this.push(`${cpp} ${p.name} = ${valueCode};`);
      }
      // A plain parameter: the C++ parameter `p` is already the binding.
    }
  }

  // The C++ expression that resolves a **default** parameter at function entry:
  // the default expression when the boundary argument is `undefined`, else the
  // passed value. The default's type must be assignable to the declared type `T`.
  // A union-typed default param is deferred (extracting the narrower union from the
  // `T | undefined` boundary would need a runtime re-wrap — clean error).
  private resolveDefault(p: Param): string {
    if (isUnion(p.type)) {
      throw new Error(
        `A default value on a union-typed parameter ('${p.name}') is not supported yet (v1)`,
      );
    }
    const def = this.emitExpr(p.default!);
    if (!this.isAssignable(p.type, def.type)) {
      throw new Error(
        `Default value for '${p.name}': type '${displayType(def.type)}' is not assignable to '${displayType(p.type)}'`,
      );
    }
    const arg = `(${defaultArgName(p.name)}).v()`;
    const member = this.cppType(p.type); // the non-undefined union alternative
    return `(std::holds_alternative<tsn_undefined>(${arg}) ? (${this.f64SlotCode(def)}) : std::get<${member}>(${arg}))`;
  }

  // The C++ element type a boxed variable's cell holds. A captured `number` is
  // stored in the f64 rep (`double`), like array elements / closure params — so a
  // box never needs the i64/f64 distinction.
  private boxElemType(t: Type): string {
    return t === "number" ? "double" : this.cppType(t);
  }
  // The cell type for a boxed variable: `tsn_rc<tsn_box<elem>>`.
  private boxType(t: Type): string {
    return `tsn_rc<tsn_box<${this.boxElemType(t)}>>`;
  }

  private prototype(fn: Func): string {
    return `${this.retSlotType(fn.name, fn.returnType)} ${fn.name}(${this.declParams(fn.name, fn.params)});`;
  }

  private resetForFunction(ret: RetType, funcKey: string): void {
    this.body = [];
    this.vars = new Map();
    this.narrowed = new Map();
    this.boxed = new Set();
    this.curReturn = ret;
    this.curAsync = false;
    this.inferRet = false;
    this.inferredRets = [];
    this.funcKey = funcKey;
    this.currentClass = undefined;
    this.indent = "  ";
    this.breakStack = [];
    this.pendingLabel = undefined;
    this.ctrlUid = 0;
  }

  private emitFunction(fn: Func): string {
    this.resetForFunction(fn.returnType, fn.name);
    this.curAsync = fn.async;
    this.bindParams(fn.params);
    for (const s of fn.body) this.emitStmt(s);
    // A `void` async coroutine (Promise<void>) needs a final `co_return tsn_unit{}`
    // — both to make it a coroutine when the body has no other co_return and to
    // satisfy the return value (the function's body may fall off the end).
    this.emitAsyncVoidTail();
    return [
      `${this.retSlotType(fn.name, fn.returnType)} ${fn.name}(${this.declParams(fn.name, fn.params)}) {`,
      ...this.body,
      `}`,
    ].join("\n");
  }

  // Append `co_return tsn_unit{};` when emitting a `void` async coroutine
  // (Promise<void>). A non-void async function returns on all paths (stage 0
  // guarantees it), so its `co_return`s already make it a coroutine.
  private emitAsyncVoidTail(): void {
    const ret = this.curReturn;
    if (
      this.curAsync &&
      ret !== "void" &&
      isPromise(ret) &&
      ret.value === undefined
    ) {
      this.push(`co_return tsn_unit{};`);
    }
  }

  // A `return` inside an async function — a `co_return` whose value is the
  // promise's RESOLVED type (curReturn is `Promise<T>`). For Promise<void> a bare
  // `return;` co_returns the unit; returning a value is rejected. Returning a
  // `Promise<T>` from a `Promise<T>` function adopts it (JS flattening: await it).
  private emitAsyncReturn(stmt: { value?: Expr }): void {
    const ret = this.curReturn as PromiseType; // async ⇒ a promise type
    const valueType = ret.value;
    if (valueType === undefined) {
      // Promise<void>.
      if (stmt.value) {
        throw new Error(
          "Cannot return a value from an async 'Promise<void>' function",
        );
      }
      this.push(`co_return tsn_unit{};`);
      return;
    }
    if (!stmt.value) throw new Error("Missing return value");
    const val = this.emitExpr(stmt.value);
    if (this.isAssignable(valueType, val.type)) {
      // Resolved values store in the f64 rep for numbers (cast an i64 value);
      // a member widens into a union-resolved promise via coerceTo.
      const code = isUnion(valueType)
        ? this.coerceTo(val, valueType)
        : this.f64SlotCode(val);
      this.push(`co_return ${code};`);
      return;
    }
    // `return somePromise` where the function resolves to the same type: adopt the
    // returned promise by awaiting it (matching JS's async return-a-thenable).
    if (
      isPromise(val.type) &&
      val.type.value !== undefined &&
      sameType(val.type.value, valueType)
    ) {
      this.push(`co_return co_await (${val.code});`);
      return;
    }
    throw new Error(
      `Type '${displayType(val.type)}' is not assignable to async return type 'Promise<${displayType(valueType)}>'`,
    );
  }

  // --- classes ------------------------------------------------------------
  //
  // A class `C` compiles to `struct C { fields; C(ctor); methods; }` and an
  // instance to `tsn_rc<C>` (see cppType). Methods/ctor are analyzed by
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
    const members = cls.fields.map(
      (f) => `  ${this.cppType(f.type)} ${f.name};`,
    );
    const ctorDecl = `  ${cls.name}(${this.declParams(this.ctorKey(cls.name), cls.ctor.params)});`;
    const methodDecls = cls.methods.map((m) => {
      const key = this.methodKey(cls.name, m.name);
      return `  ${this.retSlotType(key, m.returnType)} ${m.name}(${this.declParams(key, m.params)});`;
    });
    return [
      `struct ${cls.name} {`,
      ...members,
      ctorDecl,
      ...methodDecls,
      `};`,
    ].join("\n");
  }

  // Out-of-line constructor and method definitions for one class.
  private emitClassDefs(cls: ClassDecl): string[] {
    return [
      this.emitCtorDef(cls),
      ...cls.methods.map((m) => this.emitMethodDef(cls, m)),
    ];
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
    this.curAsync = m.async;
    this.currentClass = cls;
    this.bindParams(m.params);
    for (const s of m.body) this.emitStmt(s);
    this.emitAsyncVoidTail();
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
    return {
      code: "this",
      type: { kind: "class", name: this.currentClass.name },
    };
  }
  private emitReceiver(e: Expr): Value {
    return e.kind === "this" ? this.thisValue() : this.emitExpr(e);
  }

  private emitMain(stmts: Stmt[], deps: DepModule[]): string {
    // top-level `return` is rejected during lowering. **Top-level `await`** (only
    // legal when the entry is a module — stage 0 enforces that) makes the entry's
    // top-level a coroutine: see emitTopLevelCoroutine.
    if (stmts.some(stmtContainsAwait)) {
      return this.emitTopLevelCoroutine(stmts, deps);
    }
    this.resetForFunction("void", MAIN_KEY);
    // Run each dependency's init() eagerly, in dependency order, before the
    // entry's own top-level — so a module's top-level side effects happen at
    // "import time" (matching ES module semantics). init() is memoized, so a
    // later module-variable read just returns the cached record.
    for (const d of deps) this.push(`${this.depInitName(d)}();`);
    for (const s of stmts) this.emitTopLevel(s);
    // After the synchronous top-level, drain the microtask queue — the event loop
    // that runs async continuations (only when the program uses async; otherwise
    // main() is byte-identical to the pre-async output). No timers/IO => no
    // macrotasks, so draining to empty is the whole loop.
    const drain = this.usesAsync ? [`  tsn_run_microtasks();`] : [];
    return [`int main() {`, ...this.body, ...drain, `  return 0;`, `}`].join(
      "\n",
    );
  }

  // The entry top-level contains `await`. Emit it into a coroutine
  // `tsn_promise<tsn_unit> tsn_top_level()` (so `await` is a real `co_await`), and
  // a thin `main()` that runs the dependency inits, *starts* the top-level
  // coroutine (it runs synchronously until its first await), then drains the
  // microtask queue (the event loop runs the rest). Promoted globals stay
  // file-scope (declared at namespace scope, assigned inside the coroutine), and
  // the coroutine uses MAIN_KEY so its number-rep slots match repr.ts.
  private emitTopLevelCoroutine(stmts: Stmt[], deps: DepModule[]): string {
    this.resetForFunction({ kind: "promise" }, MAIN_KEY); // Promise<void> coroutine
    this.curAsync = true;
    for (const s of stmts) this.emitTopLevel(s);
    this.emitAsyncVoidTail(); // co_return tsn_unit{};
    const coDef = [
      `tsn_promise<tsn_unit> tsn_top_level() {`,
      ...this.body,
      `}`,
    ].join("\n");
    const mainLines = [
      ...deps.map((d) => `  ${this.depInitName(d)}();`),
      `  tsn_top_level();`,
      `  tsn_run_microtasks();`,
    ];
    return [coDef, ``, `int main() {`, ...mainLines, `  return 0;`, `}`].join(
      "\n",
    );
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
    // Top-level await in an *imported* module would make its init() a coroutine
    // and force every importer (transitively, up to main) to await it — the full
    // async-module-graph semantics. Out of subset; only the entry may use it.
    if (d.body.some(stmtContainsAwait)) {
      throw new Error(
        "Top-level 'await' in an imported module is not supported (v1) — only the entry module may use top-level await",
      );
    }
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
        if (s.type !== undefined && !this.isAssignable(s.type, init.type)) {
          throw new Error(
            `Type '${displayType(init.type)}' is not assignable to '${displayType(s.type)}'`,
          );
        }
        // Keep the declared type when it widens the init (a union module variable
        // stays a union), else the init's exact type. (See `emitGlobalLet`.)
        const fieldType =
          s.type !== undefined && !sameType(s.type, init.type)
            ? s.type
            : init.type;
        fields.push({ name: s.name, type: fieldType });
        this.sigs.set(fn, {
          params: [],
          ret: { kind: "object", fields: [...fields] },
        });
        // Record fields are object fields (f64 for numbers), so cast an i64 init;
        // a member widens into a union field via coerceTo.
        const stored = isUnion(fieldType)
          ? this.coerceTo(init, fieldType)
          : this.f64SlotCode(init);
        this.push(`rec->${s.name} = ${stored};`);
      } else {
        this.emitStmt(s);
      }
    }
    const recordType: ObjectType = { kind: "object", fields };
    this.sigs.set(fn, { params: [], ret: recordType });
    const ptr = this.cppType(recordType); // tsn_rc<tsn_ObjN>
    const struct = this.structName(recordType);
    const def = [
      `${ptr} ${fn}() {`,
      `  static ${ptr} rec;`,
      `  if (rec) return rec;`, // memoized — runs the body exactly once
      `  rec = tsn_make_rc<${struct}>();`,
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
      this.push(`${stmt.name} = tsn_make_rc<${this.vecType(stmt.type)}>();`);
      return;
    }
    const init = this.emitExpr(stmt.init);
    if (stmt.type !== undefined && !this.isAssignable(stmt.type, init.type)) {
      throw new Error(
        `Type '${displayType(init.type)}' is not assignable to '${displayType(stmt.type)}'`,
      );
    }
    // Bind the declared type when it widens the init (a union global keeps its
    // union type); otherwise the init's exact type. (See the local `let` above.)
    const declared =
      stmt.type !== undefined && !sameType(stmt.type, init.type)
        ? stmt.type
        : init.type;
    this.globals.set(stmt.name, declared);
    // The global's C++ type follows its inferred number rep (a safe-integer global
    // never assigned a fraction stays `long long`); an i64 initializer widens
    // harmlessly into a demoted (double) global.
    const declType = this.slotType(declared, this.reps.globalRep(stmt.name));
    this.globalDecls.push(`${declType} ${stmt.name};`);
    this.push(`${stmt.name} = ${this.coerceTo(init, declared)};`);
  }

  // --- emission helpers ---------------------------------------------------

  private push(line: string): void {
    this.body.push(this.indent + line);
  }

  // Run `fn` with the emission indent one level deeper, restoring it after.
  // Block emitters use this to indent the body between their `{` and `}` pushes
  // (no try/finally: any error aborts the whole emit, so there's nothing to
  // unwind to). emitBlock layers narrowing-state snapshotting on top.
  private withIndent(fn: () => void): void {
    const saved = this.indent;
    this.indent += "  ";
    fn();
    this.indent = saved;
  }

  // Emit a nested `{ ... }` block of statements at one deeper indent level.
  private emitBlock(stmts: Stmt[]): void {
    // Snapshot the narrowing state: an early-return guard inside this block may
    // narrow the fallthrough (see the `if` emitter), and that must not leak past
    // the block's end. (Cheap — the map holds at most a handful of entries.)
    const savedNarrowed = new Map(this.narrowed);
    this.withIndent(() => {
      for (const s of stmts) this.emitStmt(s);
    });
    this.narrowed = savedNarrowed;
  }

  // Whether a block unconditionally exits the enclosing control flow on every path
  // (so code after it runs only when the block was NOT taken). v1: the block ends
  // in a `return` or `throw`. Used for early-return narrowing: `if (s === null)
  // return; …` narrows `s` to non-null for the statements after the `if`.
  private alwaysExits(stmts: Stmt[]): boolean {
    const last = stmts[stmts.length - 1];
    return (
      last !== undefined && (last.kind === "return" || last.kind === "throw")
    );
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

  // --- flow narrowing -----------------------------------------------------
  //
  // A union-typed variable can be *narrowed* by a guard so its members can be
  // used directly (`if (typeof x === "string") { x.length }`). This is done at
  // emit time: `analyzeGuard` recognizes the guard shape and returns the narrowed
  // type for the positive (then) and negative (else) branches; the `if`/ternary
  // emitters install it for the matching block via `withNarrowed`, and the `var`
  // read emits a `std::get<Member>` when the narrowing is down to one member. The
  // stage-0 TS checker has already proven the program correct under TS narrowing,
  // so the `std::get` is sound (no runtime variant-access check needed).

  // The declared union type of a (possibly global) variable, or undefined.
  private declaredUnion(name: string): UnionType | undefined {
    const t = this.vars.get(name) ?? this.globals.get(name);
    return t !== undefined && isUnion(t) ? t : undefined;
  }

  // Filter a union's members by a predicate, collapsing the result: a single
  // surviving member becomes that member; an empty/unchanged set yields the
  // original union (i.e. "no narrowing").
  private filterUnion(u: UnionType, keep: (m: Type) => boolean): Type {
    const kept = u.members.filter(keep);
    if (kept.length === 0 || kept.length === u.members.length) return u;
    return kept.length === 1 ? kept[0] : { kind: "union", members: kept };
  }

  // Recognize a narrowing guard on a single union variable and return the narrowed
  // types for the then/else branches. Supported v1 forms: `typeof x === "lit"`
  // (and `!==`), `x === null`/`undefined` (and `!==`), bare truthiness `x` / `!x`
  // (removes null/undefined), and a boolean `&&` chain over the same variable.
  private analyzeGuard(
    cond: Expr,
  ): { name: string; positive: Type; negative: Type } | undefined {
    // `!guard` swaps the branches.
    if (cond.kind === "unary" && cond.op === "!") {
      const inner = this.analyzeGuard(cond.operand);
      if (!inner) {
        // bare `!x` truthiness: else-branch (x truthy) drops null/undefined.
        const tv = this.truthyGuard(cond.operand);
        if (tv)
          return { name: tv.name, positive: tv.declared, negative: tv.truthy };
        return undefined;
      }
      return {
        name: inner.name,
        positive: inner.negative,
        negative: inner.positive,
      };
    }
    // Boolean `&&` chain: combine same-variable narrowings (positive only; the
    // else-branch of `a && b` can't be cleanly narrowed, so it stays the union).
    if (cond.kind === "binary" && cond.op === "&&") {
      const l = this.analyzeGuard(cond.left);
      const r = this.analyzeGuard(cond.right);
      if (l && r && l.name === r.name) {
        const u = this.declaredUnion(l.name);
        if (!u) return undefined;
        // Intersect: keep members in both positives (compare against each side).
        const keep = (m: Type) =>
          this.typeInNarrow(m, l.positive) && this.typeInNarrow(m, r.positive);
        return {
          name: l.name,
          positive: this.filterUnion(u, keep),
          negative: u,
        };
      }
      return l ?? r;
    }
    if (cond.kind === "binary" && (cond.op === "===" || cond.op === "!==")) {
      return this.equalityGuard(cond.op, cond.left, cond.right);
    }
    // Bare truthiness `x` → then-branch drops null/undefined.
    const tv = this.truthyGuard(cond);
    if (tv)
      return { name: tv.name, positive: tv.truthy, negative: tv.declared };
    return undefined;
  }

  // Whether member `m` is within the narrowed type `n` (a member is in a union if
  // it's one of its members; otherwise types must match).
  private typeInNarrow(m: Type, n: Type): boolean {
    return isUnion(n)
      ? n.members.some((nm) => sameType(nm, m))
      : sameType(n, m);
  }

  // A bare-variable truthiness guard: `{ name, declared union, truthy }` where
  // `truthy` drops `null`/`undefined`. Undefined if `e` isn't a union variable.
  private truthyGuard(
    e: Expr,
  ): { name: string; declared: UnionType; truthy: Type } | undefined {
    if (e.kind !== "var") return undefined;
    const u = this.declaredUnion(e.name);
    if (!u) return undefined;
    const truthy = this.filterUnion(
      u,
      (m) => m !== "null" && m !== "undefined",
    );
    return { name: e.name, declared: u, truthy };
  }

  // `===`/`!==` guard: `typeof x === "lit"` or `x === null|undefined`.
  private equalityGuard(
    op: "===" | "!==",
    left: Expr,
    right: Expr,
  ): { name: string; positive: Type; negative: Type } | undefined {
    const swap = op === "!==";
    const flip = (g: { name: string; positive: Type; negative: Type }) =>
      swap ? { name: g.name, positive: g.negative, negative: g.positive } : g;

    // typeof x === "literal"
    const tof = this.typeofOperand(left) ?? this.typeofOperand(right);
    const lit = this.stringLiteral(right) ?? this.stringLiteral(left);
    if (tof !== undefined && lit !== undefined) {
      const u = this.declaredUnion(tof);
      if (!u) return undefined;
      const positive = this.filterUnion(u, (m) => this.staticTypeof(m) === lit);
      const negative = this.filterUnion(u, (m) => this.staticTypeof(m) !== lit);
      return flip({ name: tof, positive, negative });
    }
    // x === null / x === undefined
    const v =
      left.kind === "var"
        ? left.name
        : right.kind === "var"
          ? right.name
          : undefined;
    let litType: Type | undefined;
    if (left.kind === "null" || right.kind === "null") litType = "null";
    else if (left.kind === "undefined" || right.kind === "undefined")
      litType = "undefined";
    if (v !== undefined && litType !== undefined) {
      const u = this.declaredUnion(v);
      if (!u) return undefined;
      const positive = this.filterUnion(u, (m) => m === litType);
      const negative = this.filterUnion(u, (m) => m !== litType);
      return flip({ name: v, positive, negative });
    }
    return undefined;
  }

  private typeofOperand(e: Expr): string | undefined {
    return e.kind === "typeof" && e.operand.kind === "var"
      ? e.operand.name
      : undefined;
  }
  private stringLiteral(e: Expr): string | undefined {
    return e.kind === "str" ? e.value : undefined;
  }

  // Install a narrowing for the duration of `fn`, restoring the prior state. A
  // no-op when there's nothing to narrow.
  private withNarrowed<T>(
    name: string | undefined,
    type: Type | undefined,
    fn: () => T,
  ): T {
    if (name === undefined || type === undefined) return fn();
    const had = this.narrowed.has(name);
    const prev = this.narrowed.get(name);
    this.narrowed.set(name, type);
    try {
      return fn();
    } finally {
      if (had) this.narrowed.set(name, prev!);
      else this.narrowed.delete(name);
    }
  }

  // --- loops / break / continue -------------------------------------------
  //
  // Every loop pushes a BreakCtx so an inner `break`/`continue` resolves to it.
  // A loop wrapped by a `labeled` statement (its label arrives via pendingLabel)
  // is emitted in *goto-form*: it carries explicit C++ break/continue labels so a
  // labeled `break`/`continue` — which may target an *outer* loop — can `goto` it.
  // An unlabeled loop is emitted natively (plain C++ `break`/`continue`).

  // Begin a loop: consume any pending label, allocate a context, push it.
  private enterLoop(): BreakCtx {
    const label = this.pendingLabel;
    this.pendingLabel = undefined;
    const id = this.ctrlUid++;
    const ctx: BreakCtx =
      label === undefined
        ? { kind: "loop", goto: false }
        : {
            label,
            kind: "loop",
            goto: true,
            breakLabel: `_tsn_brk${id}`,
            continueLabel: `_tsn_cont${id}`,
          };
    this.breakStack.push(ctx);
    return ctx;
  }

  // End a loop: pop it and, for goto-form, place the break target after it.
  private exitLoop(ctx: BreakCtx): void {
    this.breakStack.pop();
    if (ctx.goto) this.push(`${ctx.breakLabel}: ;`);
  }

  // Emit the body of a goto-form loop: the statements, then the continue label.
  // Used where `continue` must `goto` (a labeled loop); for a plain loop the body
  // goes through emitBlock instead.
  private emitLoopBodyWithContinue(body: Stmt[], ctx: BreakCtx): void {
    this.withIndent(() => {
      for (const s of body) this.emitStmt(s);
      this.push(`${ctx.continueLabel}: ;`);
    });
  }

  // Resolve the target of a `break`: the matching labeled loop, or (unlabeled) the
  // innermost loop or switch.
  private breakTarget(label?: string): BreakCtx {
    if (label === undefined) {
      const ctx = this.breakStack[this.breakStack.length - 1];
      if (!ctx) throw new Error("'break' used outside a loop or switch");
      return ctx;
    }
    for (let i = this.breakStack.length - 1; i >= 0; i--) {
      if (this.breakStack[i].label === label) return this.breakStack[i];
    }
    throw new Error(`'break ${label}': no enclosing labeled loop '${label}'`);
  }

  // Resolve the target of a `continue`: the matching labeled loop, or (unlabeled)
  // the innermost *loop* (a switch is skipped — `continue` continues the loop).
  private continueTarget(label?: string): BreakCtx {
    if (label === undefined) {
      for (let i = this.breakStack.length - 1; i >= 0; i--) {
        if (this.breakStack[i].kind === "loop") return this.breakStack[i];
      }
      throw new Error("'continue' used outside a loop");
    }
    for (let i = this.breakStack.length - 1; i >= 0; i--) {
      const c = this.breakStack[i];
      if (c.label === label) {
        if (c.kind !== "loop")
          throw new Error(`'continue ${label}': '${label}' is not a loop`);
        return c;
      }
    }
    throw new Error(
      `'continue ${label}': no enclosing labeled loop '${label}'`,
    );
  }

  // A `finally` body runs from a C++ destructor (see tsn_make_finally), which must
  // not itself `return`, `throw`, or `break`/`continue` out of the guard's scope.
  // Reject those; break/continue *into a loop/switch inside the finally* is fine.
  private assertFinallySafe(stmts: Stmt[]): void {
    this.checkFinally(stmts, 0, 0);
  }
  private checkFinally(
    stmts: Stmt[],
    loopDepth: number,
    switchDepth: number,
  ): void {
    for (const s of stmts) {
      switch (s.kind) {
        case "return":
          throw new Error("'return' inside a 'finally' block is not supported");
        case "throw":
          throw new Error("'throw' inside a 'finally' block is not supported");
        case "break":
          if (s.label !== undefined || loopDepth + switchDepth === 0)
            throw new Error(
              "'break' escaping a 'finally' block is not supported",
            );
          break;
        case "continue":
          if (s.label !== undefined || loopDepth === 0)
            throw new Error(
              "'continue' escaping a 'finally' block is not supported",
            );
          break;
        case "if":
          this.checkFinally(s.then, loopDepth, switchDepth);
          if (s.else) this.checkFinally(s.else, loopDepth, switchDepth);
          break;
        case "while":
        case "for":
        case "doWhile":
        case "forOf":
        case "forIn":
          this.checkFinally(s.body, loopDepth + 1, switchDepth);
          break;
        case "labeled":
          this.checkFinally([s.body], loopDepth, switchDepth);
          break;
        case "switch":
          for (const c of s.cases)
            this.checkFinally(c.body, loopDepth, switchDepth + 1);
          break;
        case "try":
          this.checkFinally(s.block, loopDepth, switchDepth);
          if (s.catchBody)
            this.checkFinally(s.catchBody, loopDepth, switchDepth);
          if (s.finallyBody)
            this.checkFinally(s.finallyBody, loopDepth, switchDepth);
          break;
      }
    }
  }

  // --- statements ---------------------------------------------------------

  // Compute a `let`'s declared type and initializer Value. Handles the empty-array
  // literal (whose element type comes from the annotation) and the
  // annotation-widens-the-init rule (a union slot keeps its union type). Does NOT
  // register the variable — callers do that (inlineStmt / emitBoxedLet).
  private letInit(stmt: { name: string; type?: Type; init: Expr }): {
    declared: Type;
    init: Value;
  } {
    if (stmt.init.kind === "array" && stmt.init.elements.length === 0) {
      if (!stmt.type || !isArray(stmt.type)) {
        throw new Error("Empty array literal needs an array type annotation");
      }
      return {
        declared: stmt.type,
        init: {
          code: `tsn_make_rc<${this.vecType(stmt.type)}>()`,
          type: stmt.type,
        },
      };
    }
    const init = this.emitExpr(stmt.init);
    if (stmt.type !== undefined && !this.isAssignable(stmt.type, init.type)) {
      throw new Error(
        `Type '${displayType(init.type)}' is not assignable to '${displayType(stmt.type)}'`,
      );
    }
    const declared =
      stmt.type !== undefined && !sameType(stmt.type, init.type)
        ? stmt.type
        : init.type;
    return { declared, init };
  }

  // A captured (boxed) `let` in statement position. Emitted in two steps —
  // allocate the empty cell, then assign — so a self-referential closure
  // (`const f = (n) => f(n - 1)`, which must be type-annotated) captures the cell
  // before it is filled. An annotated binding is pre-registered so that closure can
  // resolve the name while its body is emitted.
  private emitBoxedLet(stmt: { name: string; type?: Type; init: Expr }): void {
    if (stmt.type !== undefined) {
      this.vars.set(stmt.name, stmt.type);
      this.boxed.add(stmt.name);
    }
    const { declared, init } = this.letInit(stmt);
    this.vars.set(stmt.name, declared);
    this.boxed.add(stmt.name);
    const elem = this.boxElemType(declared);
    const stored = isUnion(declared)
      ? this.coerceTo(init, declared)
      : this.f64SlotCode(init);
    this.push(
      `${this.boxType(declared)} ${stmt.name} = tsn_make_rc<tsn_box<${elem}>>();`,
    );
    this.push(`(${stmt.name})->v = ${stored};`);
  }

  // A `let`/`assign` rendered as a C++ fragment without trailing `;` (also used
  // inline inside a `for (...)` header). `let` registers the variable.
  private inlineStmt(stmt: Stmt): string {
    if (stmt.kind === "let") {
      const { declared, init } = this.letInit(stmt);
      this.vars.set(stmt.name, declared);
      // A captured (boxed) let — used here only for a for-loop counter (statement
      // position uses the self-ref-safe two-step form, `emitBoxedLet`). One step is
      // fine for a counter: its initializer can't be a closure over the counter.
      if (stmt.boxed) {
        this.boxed.add(stmt.name);
        const elem = this.boxElemType(declared);
        const stored = isUnion(declared)
          ? this.coerceTo(init, declared)
          : this.f64SlotCode(init);
        return `${this.boxType(declared)} ${stmt.name} = tsn_make_rc<tsn_box<${elem}>>(tsn_box<${elem}>{${stored}})`;
      }
      // The variable's C++ type follows its inferred number representation (a
      // safe-integer initializer that's never assigned a fraction stays i64); an
      // i64 init code widens harmlessly into a demoted (double) slot.
      const cpp = this.slotType(
        declared,
        this.reps.varRep(this.funcKey, stmt.name),
      );
      return `${cpp} ${stmt.name} = ${this.coerceTo(init, declared)}`;
    }
    if (stmt.kind === "assign") {
      const target = this.emitLValue(stmt.target);
      const val = this.emitExpr(stmt.value);
      if (!this.isAssignable(target.type, val.type)) {
        throw new Error(
          `Type '${displayType(val.type)}' is not assignable to '${displayType(target.type)}'`,
        );
      }
      // Reassigning a narrowed variable invalidates the narrowing for the rest of
      // the block — the lvalue type is the declared union (emitLValue ignores the
      // narrowing), so the value re-widens into it.
      if (stmt.target.kind === "var") this.narrowed.delete(stmt.target.name);
      return `${target.code} = ${this.coerceTo(val, target.type)}`;
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
        const type =
          this.vars.get(target.name) ?? this.globals.get(target.name);
        if (!type)
          throw new Error(
            `Cannot assign to undeclared variable '${target.name}'`,
          );
        // A captured (boxed) variable is written through its cell, so the write is
        // visible to every closure sharing it.
        const code = this.boxed.has(target.name)
          ? `(${target.name})->v`
          : target.name;
        return { code, type };
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
        // A captured (boxed) `let` is emitted in two self-ref-safe steps.
        if (stmt.boxed) {
          this.emitBoxedLet(stmt);
          return;
        }
        this.push(`${this.inlineStmt(stmt)};`);
        return;
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
        } else if (isUnion(val.type)) {
          // A union prints its active member with top-level semantics (a string
          // bare, like the `string` case above; everything else via tsn_inspect).
          out = `tsn_console_union(${val.code})`;
        } else {
          out = `tsn_inspect(${val.code})`;
        }
        this.push(`std::cout << ${out} << "\\n";`);
        return;
      }
      case "return": {
        if (this.curAsync) {
          this.emitAsyncReturn(stmt);
          return;
        }
        // Inferring a closure's return type: collect each return's value type
        // (unified afterward) and emit the value without coercing to a known type.
        if (this.inferRet) {
          if (!stmt.value) {
            this.inferredRets.push("void");
            this.push(`return;`);
            return;
          }
          const val = this.emitExpr(stmt.value);
          this.inferredRets.push(val.type);
          this.push(`return ${this.f64SlotCode(val)};`);
          return;
        }
        if (this.curReturn === "void") {
          if (stmt.value)
            throw new Error("Cannot return a value from a void function");
          this.push(`return;`);
        } else {
          if (!stmt.value) throw new Error("Missing return value");
          const val = this.emitExpr(stmt.value);
          if (!this.isAssignable(this.curReturn, val.type)) {
            throw new Error(
              `Type '${displayType(val.type)}' is not assignable to return type '${displayType(this.curReturn)}'`,
            );
          }
          this.push(`return ${this.coerceTo(val, this.curReturn)};`);
        }
        return;
      }
      case "exprStmt": {
        // Evaluate for effect; discard any result. (Calls / method calls.)
        let code: string;
        if (stmt.expr.kind === "call") {
          code = this.emitCall(stmt.expr, /*asStatement*/ true).code;
        } else if (stmt.expr.kind === "callValue") {
          code = this.emitCallValue(stmt.expr, /*asStatement*/ true).code;
        } else if (stmt.expr.kind === "methodCall") {
          code = this.emitMethodCall(stmt.expr, /*asStatement*/ true).code;
        } else if (stmt.expr.kind === "await") {
          // `await f();` — run for effect; discard the result (works for void too).
          code = this.emitAwait(stmt.expr).code;
        } else {
          code = this.emitExpr(stmt.expr).code;
        }
        this.push(`${code};`);
        return;
      }
      case "if": {
        const guard = this.analyzeGuard(stmt.cond);
        this.push(`if (${this.condition(stmt.cond)}) {`);
        this.withNarrowed(guard?.name, guard?.positive, () =>
          this.emitBlock(stmt.then),
        );
        if (stmt.else) {
          this.push(`} else {`);
          this.withNarrowed(guard?.name, guard?.negative, () =>
            this.emitBlock(stmt.else!),
          );
        }
        this.push(`}`);
        // Early-return narrowing: when the then-block always exits and there's no
        // else, the code after the `if` runs only when the guard was false — so
        // install the negative narrowing for the rest of the enclosing block (the
        // block's emitBlock snapshot restores it at the block's end).
        if (guard && !stmt.else && this.alwaysExits(stmt.then)) {
          this.narrowed.set(guard.name, guard.negative);
        }
        return;
      }
      case "while": {
        const ctx = this.enterLoop();
        this.push(`while (${this.condition(stmt.cond)}) {`);
        if (ctx.goto) this.emitLoopBodyWithContinue(stmt.body, ctx);
        else this.emitBlock(stmt.body);
        this.push(`}`);
        this.exitLoop(ctx);
        return;
      }
      case "doWhile": {
        const ctx = this.enterLoop();
        this.push(`do {`);
        if (ctx.goto) this.emitLoopBodyWithContinue(stmt.body, ctx);
        else this.emitBlock(stmt.body);
        this.push(`} while (${this.condition(stmt.cond)});`);
        this.exitLoop(ctx);
        return;
      }
      case "for": {
        // init/cond/update are emitted inline into the C++ for-header; init
        // (when a `let`) registers the loop variable before cond/update/body.
        const ctx = this.enterLoop();
        const init = stmt.init ? this.inlineStmt(stmt.init) : "";
        const cond = stmt.cond ? this.condition(stmt.cond) : "";
        const update = stmt.update ? this.inlineStmt(stmt.update) : "";
        if (ctx.goto) {
          // Goto-form: the update moves into the body after the continue label, so
          // `continue` (a goto) still runs it before re-testing the condition.
          this.push(`for (${init}; ${cond}; ) {`);
          this.withIndent(() => {
            for (const s of stmt.body) this.emitStmt(s);
            this.push(`${ctx.continueLabel}: ;`);
            if (update) this.push(`${update};`);
          });
          this.push(`}`);
        } else {
          this.push(`for (${init}; ${cond}; ${update}) {`);
          this.emitBlock(stmt.body);
          this.push(`}`);
        }
        this.exitLoop(ctx);
        // A `let`-introduced loop variable is scoped to the loop in C++; drop it.
        // (A captured counter is boxed once in the header — shared across iterations,
        // i.e. JS `var`-like capture, a documented divergence from per-iteration `let`.)
        if (stmt.init && stmt.init.kind === "let") {
          this.vars.delete(stmt.init.name);
          this.boxed.delete(stmt.init.name);
        }
        return;
      }
      case "forOf":
        this.emitForOf(stmt);
        return;
      case "forIn":
        this.emitForIn(stmt);
        return;
      case "switch":
        this.emitSwitch(stmt);
        return;
      case "break": {
        const ctx = this.breakTarget(stmt.label);
        this.push(ctx.goto ? `goto ${ctx.breakLabel};` : `break;`);
        return;
      }
      case "continue": {
        const ctx = this.continueTarget(stmt.label);
        this.push(ctx.goto ? `goto ${ctx.continueLabel};` : `continue;`);
        return;
      }
      case "labeled": {
        // The label is handed to the loop it wraps (lowering guarantees a loop),
        // which picks it up in enterLoop and emits its goto-form.
        this.pendingLabel = stmt.label;
        this.emitStmt(stmt.body);
        return;
      }
      case "throw": {
        const v = this.emitExpr(stmt.value);
        if (v.type !== "string") {
          throw new Error(
            `Can only throw a string (got '${displayType(v.type)}') — use 'throw "msg"' or 'throw new Error("msg")'`,
          );
        }
        this.push(`throw ${v.code};`);
        return;
      }
      case "try":
        this.emitTry(stmt);
        return;
    }
  }

  // `for (let x of iterable)` — iterate an array's elements or a string's chars.
  // Lowered to an index loop over a temp holding the iterable (evaluated once).
  private emitForOf(stmt: {
    name: string;
    iterable: Expr;
    body: Stmt[];
    boxed?: boolean;
  }): void {
    const ctx = this.enterLoop();
    const iter = this.emitExpr(stmt.iterable);
    const id = this.ctrlUid++;
    const it = `_tsn_it${id}`;
    const i = `_tsn_i${id}`;
    let elemType: Type;
    let sizeExpr: string;
    let elemCode: string;
    if (isArray(iter.type)) {
      elemType = iter.type.element;
      sizeExpr = `${it}->size()`;
      elemCode = `(*${it})[${i}]`;
    } else if (isSet(iter.type)) {
      // Iterate a Set's elements in insertion order (a Map iterates entries =
      // tuples, which the subset can't represent — use .keys()/.values()).
      elemType = iter.type.element;
      sizeExpr = `${it}->size()`;
      elemCode = `${it}->at(${i})`;
    } else if (iter.type === "string") {
      elemType = "string";
      sizeExpr = `${it}.size()`;
      // Each character is a one-char string (JS has no char type), like `s[i]`.
      elemCode = `tsn_str(std::string(1, ${it}.str()[${i}]))`;
    } else {
      throw new Error(
        `Cannot iterate with for…of over '${displayType(iter.type)}'`,
      );
    }
    // Array elements / string chars are stored as the f64 number rep, so a number
    // loop variable is always `double` (repr.ts marks it f64 to match).
    const elemCpp = elemType === "number" ? "double" : this.cppType(elemType);
    this.push(`auto ${it} = ${iter.code};`);
    const incr = ctx.goto ? "" : `${i}++`;
    this.push(`for (std::size_t ${i} = 0; ${i} < ${sizeExpr}; ${incr}) {`);
    this.withIndent(() => {
      // A captured loop variable gets a FRESH cell each iteration — so closures
      // created in different iterations capture distinct bindings (JS `let`
      // per-iteration semantics: `for (const i of …) fns.push(() => i)`).
      if (stmt.boxed) {
        const elem = this.boxElemType(elemType);
        this.push(
          `${this.boxType(elemType)} ${stmt.name} = tsn_make_rc<tsn_box<${elem}>>(tsn_box<${elem}>{${elemCode}});`,
        );
        this.boxed.add(stmt.name);
      } else {
        this.push(`${elemCpp} ${stmt.name} = ${elemCode};`);
      }
      this.vars.set(stmt.name, elemType);
      for (const s of stmt.body) this.emitStmt(s);
      if (ctx.goto) {
        this.push(`${ctx.continueLabel}: ;`);
        this.push(`${i}++;`);
      }
      this.vars.delete(stmt.name);
      if (stmt.boxed) this.boxed.delete(stmt.name);
    });
    this.push(`}`);
    this.exitLoop(ctx);
  }

  // `for (let k in target)` — iterate the *keys* (always strings). Array/string
  // keys are the indices "0".."n-1"; object/instance keys are the field names.
  private emitForIn(stmt: {
    name: string;
    target: Expr;
    body: Stmt[];
    boxed?: boolean;
  }): void {
    const ctx = this.enterLoop();
    const tgt = this.emitExpr(stmt.target);
    const id = this.ctrlUid++;
    const t = `_tsn_in${id}`;
    const i = `_tsn_i${id}`;
    // Evaluate the target once (its side effects happen even when, for an object,
    // we only need the statically-known field names).
    this.push(`auto ${t} = ${tgt.code};`);
    const fields = this.forInKeys(tgt.type);
    let keyCode: string;
    let sizeExpr: string;
    if (fields === null) {
      // Array / string: keys are stringified indices.
      sizeExpr = tgt.type === "string" ? `${t}.size()` : `${t}->size()`;
      keyCode = `tsn_str(std::to_string(${i}))`;
    } else {
      // Object / class: a fixed vector of the field-name strings.
      const keys = `_tsn_keys${id}`;
      const items = fields
        .map((f) => `tsn_str(${cppStringLiteral(f)})`)
        .join(", ");
      this.push(`std::vector<tsn_str> ${keys} = {${items}};`);
      sizeExpr = `${keys}.size()`;
      keyCode = `${keys}[${i}]`;
    }
    const incr = ctx.goto ? "" : `${i}++`;
    this.push(`for (std::size_t ${i} = 0; ${i} < ${sizeExpr}; ${incr}) {`);
    this.withIndent(() => {
      // A captured key gets a fresh cell each iteration (see emitForOf).
      if (stmt.boxed) {
        this.push(
          `tsn_rc<tsn_box<tsn_str>> ${stmt.name} = tsn_make_rc<tsn_box<tsn_str>>(tsn_box<tsn_str>{${keyCode}});`,
        );
        this.boxed.add(stmt.name);
      } else {
        this.push(`tsn_str ${stmt.name} = ${keyCode};`);
      }
      this.vars.set(stmt.name, "string");
      for (const s of stmt.body) this.emitStmt(s);
      if (ctx.goto) {
        this.push(`${ctx.continueLabel}: ;`);
        this.push(`${i}++;`);
      }
      this.vars.delete(stmt.name);
      if (stmt.boxed) this.boxed.delete(stmt.name);
    });
    this.push(`}`);
    this.exitLoop(ctx);
  }

  // The for-in keys of a value: an object/instance's field names, or `null` for an
  // array/string (whose keys are positional indices, handled by the caller).
  private forInKeys(t: Type): string[] | null {
    if (isObject(t)) return t.fields.map((f) => f.name);
    if (isClass(t)) {
      const cls = this.classes.get(t.name);
      if (!cls) throw new Error(`Unknown class: ${t.name}`);
      return cls.fields.map((f) => f.name);
    }
    if (isArray(t) || t === "string") return null;
    throw new Error(`Cannot iterate with for…in over '${displayType(t)}'`);
  }

  // `switch (disc) { ... }`. JS matches with `===` and *falls through* until a
  // `break`, with `default` runnable from any position — semantics a value table
  // can't express. So we compile it the way a C compiler does internally: evaluate
  // the discriminant once, dispatch with `goto`s to per-clause labels (in source
  // order, so fall-through is just falling into the next clause), and make `break`
  // a `goto` past the end. Each clause body is its own `{ }` block so the forward
  // dispatch jumps never bypass a clause-local variable's initialization.
  private emitSwitch(stmt: { disc: Expr; cases: SwitchCase[] }): void {
    const disc = this.emitExpr(stmt.disc);
    const id = this.ctrlUid++;
    const sw = `_tsn_sw${id}`;
    const endLabel = `_tsn_swend${id}`;
    const caseLabel = (i: number) => `_tsn_sw${id}_c${i}`;
    const defaultIdx = stmt.cases.findIndex((c) => c.test === undefined);
    this.push(`{`);
    this.withIndent(() => {
      this.push(`auto ${sw} = ${disc.code};`);
      // Dispatch: first matching `case` wins; later tests aren't evaluated (the
      // goto jumps away), matching JS's evaluate-in-order-until-match.
      stmt.cases.forEach((c, idx) => {
        if (c.test === undefined) return;
        const t = this.emitExpr(c.test);
        if (!sameType(t.type, disc.type)) {
          throw new Error(
            `switch case type '${displayType(t.type)}' is not comparable to discriminant type '${displayType(disc.type)}'`,
          );
        }
        this.push(`if ((${sw} == ${t.code})) goto ${caseLabel(idx)};`);
      });
      this.push(`goto ${defaultIdx >= 0 ? caseLabel(defaultIdx) : endLabel};`);
      // Clause bodies. `break` inside resolves to this switch (goto past the end).
      const ctx: BreakCtx = {
        kind: "switch",
        goto: true,
        breakLabel: endLabel,
      };
      this.breakStack.push(ctx);
      stmt.cases.forEach((c, idx) => {
        this.push(`${caseLabel(idx)}: {`);
        this.withIndent(() => {
          for (const s of c.body) this.emitStmt(s);
        });
        this.push(`}`);
      });
      this.breakStack.pop();
      this.push(`${endLabel}: ;`);
    });
    this.push(`}`);
  }

  // `try { } catch (e) { } finally { }`. A `finally` is realized as a RAII guard
  // (tsn_make_finally) so it runs on every exit — normal, `return`, or exception —
  // which means a finally needs no C++ `try` of its own; only a `catch` does. The
  // caught value is bound as a `string` (the subset throws only strings).
  private emitTry(stmt: {
    block: Stmt[];
    catchName?: string;
    catchBody?: Stmt[];
    finallyBody?: Stmt[];
    catchBoxed?: boolean;
  }): void {
    const hasFinally = stmt.finallyBody !== undefined;
    const hasCatch = stmt.catchBody !== undefined;
    // The finally guard (if any) and the try/catch body sit at the same indent;
    // a finally wraps them in an extra `{ … }` (and its own deeper level).
    const emitTryCore = () => {
      if (hasFinally) {
        this.assertFinallySafe(stmt.finallyBody!);
        const id = this.ctrlUid++;
        this.push(`auto _tsn_fin${id} = tsn_make_finally([&]() {`);
        this.withIndent(() => {
          for (const s of stmt.finallyBody!) this.emitStmt(s);
        });
        this.push(`});`);
      }
      if (hasCatch) {
        this.push(`try {`);
        this.emitBlock(stmt.block);
        const cname = stmt.catchName ?? `_tsn_ex${this.ctrlUid++}`;
        // A captured catch binding is received under a mangled name and boxed into
        // the user's name, so a closure in the catch body shares the binding.
        const boxedCatch = !!stmt.catchBoxed && stmt.catchName !== undefined;
        const recvName = boxedCatch ? boxArgName(cname) : cname;
        this.push(`} catch (const tsn_str& ${recvName}) {`);
        if (stmt.catchName) {
          this.vars.set(stmt.catchName, "string");
          if (boxedCatch) {
            this.boxed.add(stmt.catchName);
            this.push(
              `  tsn_rc<tsn_box<tsn_str>> ${cname} = tsn_make_rc<tsn_box<tsn_str>>(tsn_box<tsn_str>{${recvName}});`,
            );
          }
        }
        this.emitBlock(stmt.catchBody!);
        if (stmt.catchName) {
          this.vars.delete(stmt.catchName);
          if (boxedCatch) this.boxed.delete(stmt.catchName);
        }
        this.push(`}`);
      } else {
        // finally-only: the RAII guard already covers exceptions/returns.
        this.push(`{`);
        this.emitBlock(stmt.block);
        this.push(`}`);
      }
    };
    if (hasFinally) {
      this.push(`{`);
      this.withIndent(emitTryCore);
      this.push(`}`);
    } else {
      emitTryCore();
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
        return {
          code: `tsn_str(${cppStringLiteral(e.value)})`,
          type: "string",
        };
      case "null":
        return { code: "tsn_null{}", type: "null" };
      case "undefined":
        return { code: "tsn_undefined{}", type: "undefined" };
      case "typeof": {
        // `typeof e` → a `string`. For a union it's decided at runtime (the active
        // variant); for any other type it's known statically. (Narrowing reads the
        // *unlowered* form via analyzeGuard — see the `if`/ternary emitters.)
        const operand = this.emitExpr(e.operand);
        if (isUnion(operand.type)) {
          return { code: `tsn_typeof(${operand.code})`, type: "string" };
        }
        return {
          code: `tsn_str(${cppStringLiteral(this.staticTypeof(operand.type))})`,
          type: "string",
        };
      }
      case "var": {
        // A captured (boxed) variable lives in a heap cell — read through `->v`.
        const boxedAccess = this.boxed.has(e.name);
        const access = boxedAccess ? `(${e.name})->v` : e.name;
        // A flow-narrowed union variable: when narrowed to a single member, read
        // it through `std::get<Member>` (the active alternative — sound because the
        // stage-0 checker proved the guard holds on this path); when narrowed to a
        // smaller union, keep the variant value but report the narrower type.
        const narrowedType = this.narrowed.get(e.name);
        if (narrowedType !== undefined && this.declaredUnion(e.name)) {
          if (isUnion(narrowedType)) {
            return { code: access, type: narrowedType };
          }
          const mcpp = this.cppType(narrowedType);
          return {
            code: `std::get<${mcpp}>((${access}).v())`,
            type: narrowedType,
            rep: narrowedType === "number" ? "f64" : undefined,
          };
        }
        // A local binding shadows a same-named global, so check `vars` first. A
        // boxed local's cell holds the f64 rep for numbers (see `boxElemType`).
        const local = this.vars.get(e.name);
        if (local !== undefined) {
          const rep =
            local === "number"
              ? boxedAccess
                ? "f64"
                : this.reps.varRep(this.funcKey, e.name)
              : undefined;
          return { code: access, type: local, rep };
        }
        // Otherwise it may be a module-level global (a promoted top-level var),
        // visible here even from inside a function/method body. (Globals are never
        // boxed — they are already file-scope, so a closure references them directly.)
        const global = this.globals.get(e.name);
        if (global !== undefined) {
          const rep =
            global === "number" ? this.reps.globalRep(e.name) : undefined;
          return { code: e.name, type: global, rep };
        }
        // A bare reference to a top-level function name = a first-class function
        // VALUE: wrap the function in a `std::function` of its type. (repr.ts forces
        // such a function's number params/return to the f64 rep, so its C++
        // signature matches this `std::function<…>` exactly.)
        const sig = this.sigs.get(e.name);
        if (sig) {
          const ft = this.fnValueType(sig.params, sig.ret);
          return { code: `${this.cppType(ft)}(${e.name})`, type: ft };
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
      case "ternary": {
        // `cond ? a : b` -> the C++ ternary. The condition must be a number or
        // boolean (like `if`/`while`); the branches must share a type, and that
        // type is the result. For a number result the rep follows both branches
        // (i64 only when both are) — a mixed pair is promoted to double by C++,
        // matching the f64 rep.
        const guard = this.analyzeGuard(e.cond);
        const cond = this.condition(e.cond);
        const a = this.withNarrowed(guard?.name, guard?.positive, () =>
          this.emitExpr(e.whenTrue),
        );
        const b = this.withNarrowed(guard?.name, guard?.negative, () =>
          this.emitExpr(e.whenFalse),
        );
        if (!sameType(a.type, b.type)) {
          throw new Error(
            `Ternary branches must have the same type, got '${displayType(a.type)}' and '${displayType(b.type)}'`,
          );
        }
        const rep =
          a.type === "number"
            ? combineRep(a.rep ?? "f64", b.rep ?? "f64")
            : undefined;
        return {
          code: `(${cond} ? ${a.code} : ${b.code})`,
          type: a.type,
          rep,
        };
      }
      case "array":
        return this.emitArrayLiteral(e.elements);
      case "spread":
        // A spread is only meaningful inside an array literal or a call's argument
        // list (both handled by their emitters). Anywhere else it has no value.
        throw new Error(
          "Spread ('...x') is only valid in an array literal or a call argument (v1)",
        );
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
          code: `tsn_make_rc<${struct}>(${struct}{${items}})`,
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
        // `map.size` / `set.size` — the entry/element count (a non-negative i64).
        if (isMap(obj.type) || isSet(obj.type)) {
          if (e.name === "size") {
            return {
              code: `static_cast<long long>((${obj.code})->size())`,
              type: "number",
              rep: "i64",
            };
          }
          throw new Error(
            `${isMap(obj.type) ? "Maps" : "Sets"} have no property '${e.name}'`,
          );
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
        // `res.status` (f64 number) / `res.ok` (boolean) on a fetch Response.
        if (isResponse(obj.type)) {
          if (e.name === "status") {
            return {
              code: `(${obj.code})->status`,
              type: "number",
              rep: "f64",
            };
          }
          if (e.name === "ok") {
            return { code: `(${obj.code})->ok`, type: "boolean" };
          }
          throw new Error(`Response has no property '${e.name}'`);
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
          this.slotsFromParams(cls.ctor.params),
          e.args,
        );
        return {
          code: `tsn_make_rc<${e.className}>(${args.join(", ")})`,
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
      case "jsonStringify": {
        // Any value type serializes — overload resolution on tsn_json_stringify
        // picks the scalar / array-template / generated per-type overload. Map/Set
        // have no JSON form here (Node serializes them as `{}`); reject cleanly
        // rather than emit a C++ overload error.
        const v = this.emitExpr(e.arg);
        if (
          isMap(v.type) ||
          isSet(v.type) ||
          isPromise(v.type) ||
          isFunction(v.type)
        ) {
          const what = isMap(v.type)
            ? "Map"
            : isSet(v.type)
              ? "Set"
              : isFunction(v.type)
                ? "function"
                : "Promise";
          throw new Error(`JSON.stringify of a ${what} is not supported (v1)`);
        }
        return { code: `tsn_json_stringify(${v.code})`, type: "string" };
      }
      case "jsonParse":
        return this.emitJsonParse(e);
      case "mathCall":
        return this.emitMathCall(e);
      case "mathConst":
        return this.emitMathConst(e.name);
      case "mapNew": {
        const t: MapType = { kind: "map", key: e.key, value: e.value };
        return {
          code: `tsn_make_rc<${this.mapPointee(t)}>()`,
          type: t,
        };
      }
      case "setNew": {
        const t: SetType = { kind: "set", element: e.element };
        if (e.init) {
          const init = this.emitExpr(e.init);
          if (!isArray(init.type) || !sameType(init.type.element, e.element)) {
            throw new Error(
              `new Set<${displayType(e.element)}> initializer must be a '${displayType(e.element)}[]', got '${displayType(init.type)}'`,
            );
          }
          // Seed from the array's elements (deref the shared_ptr to the vector).
          return {
            code: `tsn_make_rc<${this.setPointee(t)}>(*(${init.code}))`,
            type: t,
          };
        }
        return {
          code: `tsn_make_rc<${this.setPointee(t)}>()`,
          type: t,
        };
      }
      case "await": {
        const a = this.emitAwait(e);
        if (a.valueType === "void") {
          throw new Error(
            "'await' of a Promise<void> has no value — use it as a statement, not an expression",
          );
        }
        return { code: a.code, type: a.valueType, rep: a.rep };
      }
      case "promiseResolve": {
        const v = this.emitExpr(e.arg);
        // Promise.resolve(p) === p when the argument is already a promise.
        if (isPromise(v.type)) return { code: v.code, type: v.type };
        return {
          code: `tsn_resolve(${this.f64SlotCode(v)})`,
          type: { kind: "promise", value: v.type },
        };
      }
      case "promiseAll": {
        const v = this.emitExpr(e.arg);
        if (!isArray(v.type) || !isPromise(v.type.element)) {
          throw new Error(
            `Promise.all expects a Promise<T>[] argument, got '${displayType(v.type)}'`,
          );
        }
        const inner = v.type.element.value;
        if (inner === undefined) {
          throw new Error(
            "Promise.all of a Promise<void>[] is not supported (v1)",
          );
        }
        // tsn_all(ps) resolves to a vector of the element results -> T[].
        return {
          code: `tsn_all(${v.code})`,
          type: { kind: "promise", value: { kind: "array", element: inner } },
        };
      }
      case "fetch": {
        this.usesFetch = true;
        const url = this.emitExpr(e.url);
        if (url.type !== "string") {
          throw new Error(
            `fetch expects a string URL, got '${displayType(url.type)}'`,
          );
        }
        // tsn_fetch (runtime) does the blocking GET and returns an already-settled
        // Promise<Response> (rejected on a transport error).
        return {
          code: `tsn_fetch(${url.code})`,
          type: { kind: "promise", value: { kind: "response" } },
        };
      }
      case "responseJson": {
        this.usesFetch = true;
        const recv = this.emitExpr(e.receiver);
        if (!isResponse(recv.type)) {
          throw new Error(
            `'.json()' is only valid on a fetch Response, got '${displayType(recv.type)}'`,
          );
        }
        this.assertJsonType(e.type);
        // Parse the buffered body into the target type (reusing JSON.parse's
        // extraction), then resolve a promise over it — so `await res.json()`
        // yields the typed value (one tick later, like any await).
        const extracted = this.extractJson(
          `tsn_json_parse((${recv.code})->body)`,
          e.type,
        );
        return {
          code: `tsn_resolve(${extracted})`,
          type: { kind: "promise", value: e.type },
        };
      }
      case "closure":
        return this.emitClosure(e);
      case "callValue": {
        const v = this.emitCallValue(e, /*asStatement*/ false);
        // A function value's return uses the f64 rep for numbers.
        const rep = v.type === "number" ? "f64" : undefined;
        return { code: v.code, type: v.type as Type, rep };
      }
    }
  }

  // --- array literals (with spread) ---------------------------------------

  // Emit an array literal whose `elements` may include `spread` nodes (`[...a]`).
  // `knownElement` fixes the element type up front (used when collecting a rest
  // parameter's trailing arguments, where the array may be empty); otherwise the
  // element type is inferred from the first element / spread. A spread element's
  // `arg` must be a `T[]` whose element matches. With no spreads this emits the
  // same `tsn_make_rc<vec>(vec{...})` as before; with spreads it builds a *fresh*
  // array at runtime via an IIFE (so `[...a]` is a copy), splicing each spread.
  private emitArrayLiteral(elements: Expr[], knownElement?: Type): Value {
    let element: Type | undefined = knownElement;
    const note = (t: Type) => {
      if (element === undefined) element = t;
      else if (!sameType(element, t)) {
        throw new Error("All array elements must have the same type");
      }
    };
    const parts = elements.map((el) => {
      if (el.kind === "spread") {
        const v = this.emitExpr(el.arg);
        if (!isArray(v.type)) {
          throw new Error(
            `Spread element must be an array, got '${displayType(v.type)}'`,
          );
        }
        note(v.type.element);
        return { spread: true, v };
      }
      const v = this.emitExpr(el);
      note(v.type);
      return { spread: false, v };
    });
    if (element === undefined) {
      throw new Error(
        "Empty array literals are not supported (element type cannot be inferred)",
      );
    }
    const arrType: ArrayType = { kind: "array", element };
    const vec = this.vecType(arrType);
    const hasSpread = parts.some((p) => p.spread);
    if (!hasSpread) {
      // A reference-typed array: a tsn_rc to a heap vector (so `let b = a` aliases,
      // mutations are shared, and `===` is identity — JS semantics).
      if (parts.length === 0) {
        return { code: `tsn_make_rc<${vec}>()`, type: arrType };
      }
      const items = parts.map((p) => this.f64SlotCode(p.v)).join(", ");
      return { code: `tsn_make_rc<${vec}>(${vec}{${items}})`, type: arrType };
    }
    // The spread builder lowers into a C++ lambda body, where `co_await` can't go.
    if (elements.some(containsAwait)) {
      throw new Error(
        "'await' inside a spread array literal is not supported (v1) — assign the awaited value to a variable first",
      );
    }
    const id = this.ctrlUid++;
    const t = `_tsn_arr${id}`;
    const x = `_tsn_el${id}`;
    const pieces: string[] = [`auto ${t} = tsn_make_rc<${vec}>();`];
    for (const p of parts) {
      if (p.spread) {
        pieces.push(
          `for (const auto& ${x} : *(${p.v.code})) ${t}->push_back(${x});`,
        );
      } else {
        pieces.push(`${t}->push_back(${this.f64SlotCode(p.v)});`);
      }
    }
    pieces.push(`return ${t};`);
    return { code: `([&]{ ${pieces.join(" ")} }())`, type: arrType };
  }

  // --- closures / first-class functions -----------------------------------

  // Emit a closure (arrow function / function expression) as a C++ lambda wrapped
  // in a `std::function<Ret(P…)>`. The lambda uses default capture `[=]`, which
  // copies the (boxed) cells of any captured locals by value — so all closures
  // sharing a captured variable share its one heap cell (see the capture pass).
  // Parameters and the return type use the f64 number rep (a function value's
  // signature is context-stable). The return type is taken from the annotation or
  // inferred from the body's `return`s. Emitting the body swaps the whole
  // per-function emitter state, restoring it afterward (closures nest).
  private emitClosure(e: {
    params: Param[];
    returnType?: RetType;
    body: Stmt[];
    id?: number;
  }): Value {
    // Save the enclosing function's scratch state.
    const saved = {
      body: this.body,
      vars: this.vars,
      boxed: this.boxed,
      narrowed: this.narrowed,
      curReturn: this.curReturn,
      curAsync: this.curAsync,
      inferRet: this.inferRet,
      inferredRets: this.inferredRets,
      funcKey: this.funcKey,
      breakStack: this.breakStack,
      pendingLabel: this.pendingLabel,
      indent: this.indent,
      ctrlUid: this.ctrlUid,
    };

    // Set up the closure's own scope. Inherit `vars`/`boxed` so the body can resolve
    // the types of (and read through the cells of) captured outer variables; start
    // fresh for narrowing / loops / labels. A closure is never a coroutine here
    // (async closures are rejected in lowering).
    this.body = [];
    this.vars = new Map(saved.vars);
    this.boxed = new Set(saved.boxed);
    this.narrowed = new Map();
    this.curAsync = false;
    this.funcKey = `$closure${e.id}`;
    this.breakStack = [];
    this.pendingLabel = undefined;
    this.indent = saved.indent + "  ";
    this.ctrlUid = 0;

    const declParams = this.declParams(this.funcKey, e.params);
    let retType: RetType;
    if (e.returnType !== undefined) {
      this.inferRet = false;
      this.curReturn = e.returnType;
      this.bindParams(e.params);
      for (const s of e.body) this.emitStmt(s);
      retType = e.returnType;
    } else {
      // Infer the return type from the body's `return`s (unified like ternary
      // branches; no returns ⇒ void).
      this.inferRet = true;
      this.inferredRets = [];
      this.curReturn = "void";
      this.bindParams(e.params);
      for (const s of e.body) this.emitStmt(s);
      retType = this.unifyReturns(this.inferredRets);
    }
    const retCpp = retType === "void" ? "void" : this.cppType(retType);
    // The closure's value type: boundary param types (a defaulted param becomes
    // optional `T | undefined`), with `restParam` set if the last is a rest.
    const fnType = this.fnValueType(e.params, retType);
    const bodyLines = this.body;
    const closeIndent = saved.indent;

    // Restore the enclosing state.
    this.body = saved.body;
    this.vars = saved.vars;
    this.boxed = saved.boxed;
    this.narrowed = saved.narrowed;
    this.curReturn = saved.curReturn;
    this.curAsync = saved.curAsync;
    this.inferRet = saved.inferRet;
    this.inferredRets = saved.inferredRets;
    this.funcKey = saved.funcKey;
    this.breakStack = saved.breakStack;
    this.pendingLabel = saved.pendingLabel;
    this.indent = saved.indent;
    this.ctrlUid = saved.ctrlUid;

    const lambda = [
      `${this.cppType(fnType)}([=](${declParams}) -> ${retCpp} {`,
      ...bodyLines,
      `${closeIndent}})`,
    ].join("\n");
    return { code: lambda, type: fnType };
  }

  // Unify the return-value types collected while inferring a closure's return type:
  // they must all be the same type (no union-merge, like ternary branches); no
  // returns ⇒ `void`.
  private unifyReturns(rets: RetType[]): RetType {
    if (rets.length === 0) return "void";
    const first = rets[0];
    for (const r of rets) {
      const same =
        first === "void" || r === "void"
          ? first === r
          : sameType(first, r);
      if (!same) {
        throw new Error(
          `A closure's return values must share a type, got '${displayType(first)}' and '${displayType(r)}'`,
        );
      }
    }
    return first;
  }

  // Call a function VALUE: `(callee)(args)` where `callee` is any function-typed
  // expression. The argument types are checked against the function type's
  // parameters; a `void`-returning value call is valid only in statement position.
  private emitCallValue(
    e: { callee: Expr; args: Expr[] },
    asStatement: boolean,
  ): { code: string; type: RetType } {
    const callee = this.emitExpr(e.callee);
    if (!isFunction(callee.type)) {
      throw new Error(
        `Cannot call a value of type '${displayType(callee.type)}'`,
      );
    }
    const ft = callee.type;
    const args = this.checkArgs("call", this.slotsFromFunctionType(ft), e.args);
    if (ft.ret === "void" && !asStatement) {
      throw new Error("This function returns void and cannot be used as a value");
    }
    return { code: `(${callee.code})(${args.join(", ")})`, type: ft.ret };
  }

  // Emit an `await`. Returns the C++ `co_await …` expression and the awaited
  // (resolved) type — `"void"` for a Promise<void> (only valid as a statement).
  // Valid wherever `curAsync` is set: an async function/method, or the entry's
  // top-level coroutine (emitTopLevelCoroutine). Otherwise rejected.
  private emitAwait(e: { expr: Expr }): {
    code: string;
    valueType: RetType;
    rep?: Rep;
  } {
    if (!this.curAsync) {
      // Reachable only for await in a non-async function/method or an imported
      // module's top level — stage 0 rejects the former; emitDepInit the latter.
      throw new Error(
        "'await' is only valid inside an async function or the entry module's top level",
      );
    }
    const inner = this.emitExpr(e.expr);
    if (isPromise(inner.type)) {
      const valueType: RetType =
        inner.type.value === undefined ? "void" : inner.type.value;
      return {
        code: `co_await (${inner.code})`,
        valueType,
        rep: valueType === "number" ? "f64" : undefined,
      };
    }
    // await on a non-promise: wrap in a resolved promise so the one-tick deferral
    // still happens (JS `await 5`), then unwrap to the value.
    return {
      code: `co_await tsn_resolve(${this.f64SlotCode(inner)})`,
      valueType: inner.type,
      rep: inner.type === "number" ? "f64" : undefined,
    };
  }

  // --- Math.* -------------------------------------------------------------
  //
  // `Math.<fn>(...)` is a builtin (recognized in lowering), always `number`-typed
  // and always the f64 rep — Math is double math. Most functions map straight to
  // <cmath>; the JS-divergent ones (round half-to-+∞, NaN-propagating min/max,
  // sign, random) use a `tsn_math_*` runtime helper. Every argument is forced to
  // `double` (`static_cast`) so an i64-rep operand picks the floating overload.

  // Unary `Math.<fn>` that maps straight to a <cmath> function.
  private static readonly MATH_UNARY_STD: Record<string, string> = {
    abs: "std::fabs",
    floor: "std::floor",
    ceil: "std::ceil",
    trunc: "std::trunc",
    sqrt: "std::sqrt",
    cbrt: "std::cbrt",
    exp: "std::exp",
    log: "std::log",
    log2: "std::log2",
    log10: "std::log10",
    sin: "std::sin",
    cos: "std::cos",
    tan: "std::tan",
    asin: "std::asin",
    acos: "std::acos",
    atan: "std::atan",
    sinh: "std::sinh",
    cosh: "std::cosh",
    tanh: "std::tanh",
  };

  // The exact double-literal value of each Math constant (the shortest round-trip
  // spelling JS uses, so clang parses it to the identical double — byte-for-byte
  // with Node). Emitting literals avoids depending on <cmath>'s M_PI being defined.
  private static readonly MATH_CONST: Record<string, string> = {
    PI: "3.141592653589793",
    E: "2.718281828459045",
    LN2: "0.6931471805599453",
    LN10: "2.302585092994046",
    LOG2E: "1.4426950408889634",
    LOG10E: "0.4342944819032518",
    SQRT2: "1.4142135623730951",
    SQRT1_2: "0.7071067811865476",
  };

  private emitMathConst(name: string): Value {
    const code = Emitter.MATH_CONST[name];
    if (code === undefined)
      throw new Error(`Unsupported Math constant 'Math.${name}'`);
    return { code, type: "number", rep: "f64" };
  }

  private emitMathCall(e: { fn: string; args: Expr[] }): Value {
    const fn = e.fn;
    const vals = e.args.map((a) => this.emitExpr(a));
    for (const v of vals) {
      if (v.type !== "number")
        throw new Error(`'Math.${fn}' arguments must be numbers`);
    }
    // Force every argument to double, so an i64-rep operand selects the floating
    // <cmath> overload (and integer literals don't pick an integral overload).
    const ds = vals.map((v) => `static_cast<double>(${v.code})`);
    const num = (code: string): Value => ({ code, type: "number", rep: "f64" });
    const arity = (n: number) => this.checkArity(`Math.${fn}`, vals.length, n);

    const std = Emitter.MATH_UNARY_STD[fn];
    if (std) {
      arity(1);
      return num(`${std}(${ds[0]})`);
    }
    switch (fn) {
      case "round":
        arity(1);
        return num(`tsn_math_round(${ds[0]})`);
      case "sign":
        arity(1);
        return num(`tsn_math_sign(${ds[0]})`);
      case "pow":
        arity(2);
        return num(`std::pow(${ds[0]}, ${ds[1]})`);
      case "atan2":
        arity(2);
        return num(`std::atan2(${ds[0]}, ${ds[1]})`);
      case "min":
      case "max": {
        // Fold the (variadic) args with a NaN-propagating binary helper. With no
        // args JS yields +Infinity (min) / -Infinity (max).
        if (ds.length === 0)
          return num(fn === "min" ? "INFINITY" : "-INFINITY");
        const helper = fn === "min" ? "tsn_math_min" : "tsn_math_max";
        let acc = ds[0];
        for (let i = 1; i < ds.length; i++) acc = `${helper}(${acc}, ${ds[i]})`;
        return num(acc);
      }
      case "hypot": {
        // hypot(a,b,c) == hypot(hypot(a,b),c); hypot(x) == |x|; hypot() == 0.
        if (ds.length === 0) return num("0.0");
        if (ds.length === 1) return num(`std::fabs(${ds[0]})`);
        let acc = `std::hypot(${ds[0]}, ${ds[1]})`;
        for (let i = 2; i < ds.length; i++)
          acc = `std::hypot(${acc}, ${ds[i]})`;
        return num(acc);
      }
      case "random":
        arity(0);
        return num("tsn_math_random()");
    }
    throw new Error(`Unsupported Math function 'Math.${fn}'`);
  }

  // --- JSON.parse ---------------------------------------------------------
  //
  // The runtime parses the text into a generic `tsn_json` value; here we emit a
  // recursive *extraction* expression that pulls the statically-known target type
  // out of it: scalars via the `tsn_json_as_*` accessors, arrays/objects via inline
  // lambdas (so no per-type helper functions or forward decls are needed — the
  // target type is a finite tree, the subset has no recursive/aliased types).
  private emitJsonParse(e: { text: Expr; type: Type }): Value {
    const text = this.emitExpr(e.text);
    if (text.type !== "string") {
      throw new Error("JSON.parse expects a string argument");
    }
    this.assertJsonType(e.type);
    return {
      code: this.extractJson(`tsn_json_parse(${text.code})`, e.type),
      type: e.type,
      // JSON numbers parse to doubles, so a parsed value is always the f64 rep.
      rep: e.type === "number" ? "f64" : undefined,
    };
  }

  // A JSON.parse target must be a JSON *value* type: scalars and arrays/objects of
  // them. A class instance has no JSON form (no prototype/constructor to rebuild),
  // so it's rejected with a clear error rather than miscompiled.
  private assertJsonType(t: Type): void {
    if (isClass(t)) {
      throw new Error(
        `JSON.parse target type may not be a class ('${t.name}') — use an object type like { ... }`,
      );
    }
    if (isMap(t) || isSet(t)) {
      throw new Error(
        `JSON.parse target type may not be a ${isMap(t) ? "Map" : "Set"} — use an object/array type`,
      );
    }
    if (isPromise(t)) {
      throw new Error(
        "JSON.parse target type may not be a Promise — use a JSON value type",
      );
    }
    if (isArray(t)) {
      this.assertJsonType(t.element);
    } else if (isObject(t)) {
      for (const f of t.fields) this.assertJsonType(f.type);
    }
  }

  // C++ expression that extracts a value of tsn type `t` from the `tsn_json`
  // expression `j`. Recurses for aggregates via immediately-invoked lambdas
  // (`uid`-suffixed locals avoid name clashes between nested lambdas).
  private extractJson(j: string, t: Type): string {
    if (t === "number") return `tsn_json_as_number(${j})`;
    if (t === "boolean") return `tsn_json_as_bool(${j})`;
    if (t === "string") return `tsn_json_as_string(${j})`;
    if (isArray(t)) {
      const id = this.jsonUid++;
      const a = `_ja${id}`;
      const v = `_jv${id}`;
      const el = `_je${id}`;
      const vec = this.vecType(t);
      const elem = this.extractJson(el, t.element);
      return (
        `([&](const tsn_json& ${a}) { ` +
        `auto ${v} = tsn_make_rc<${vec}>(); ` +
        `for (const tsn_json& ${el} : ${a}.as_array()) { ${v}->push_back(${elem}); } ` +
        `return ${v}; }(${j}))`
      );
    }
    if (isObject(t)) {
      const id = this.jsonUid++;
      const o = `_jo${id}`;
      const r = `_jr${id}`;
      const struct = this.structName(t); // registers the struct
      const assigns = t.fields
        .map((f) => {
          const fv = this.extractJson(
            `${o}.get(${cppStringLiteral(f.name)})`,
            f.type,
          );
          return `${r}->${f.name} = ${fv};`;
        })
        .join(" ");
      return (
        `([&](const tsn_json& ${o}) { ` +
        `auto ${r} = tsn_make_rc<${struct}>(); ${assigns} ` +
        `return ${r}; }(${j}))`
      );
    }
    // Class types are rejected by assertJsonType before we get here.
    throw new Error("Unsupported JSON.parse target type");
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

  // An optional parameter — its (desugared) type is a union containing
  // `undefined`, so a caller may omit it (the omitted value is `undefined`).
  private isOptionalParam(p: Type): boolean {
    return isUnion(p) && p.members.some((m) => m === "undefined");
  }

  // `T | undefined`, flattening if `T` is already a union (so a default param's
  // boundary type stays a flat union). Used as the boundary type of a defaulted /
  // optional parameter — the caller widens its value into it (or omits it).
  private optionalUnion(t: Type): Type {
    if (t === "undefined") return t;
    if (isUnion(t)) {
      return t.members.some((m) => m === "undefined")
        ? t
        : { kind: "union", members: [...t.members, "undefined"] };
    }
    return { kind: "union", members: [t, "undefined"] };
  }

  // Normalize a callee's `Param[]` into call slots (the call-site view). A rest
  // param keeps its `T[]` type and is marked `rest`; a defaulted param's boundary
  // type widens to `T | undefined` and is optional; an `a?: T` param is already a
  // `T | undefined` union (optional); everything else is a required slot.
  private slotsFromParams(params: Param[]): CallSlot[] {
    return params.map((p) => {
      if (p.rest) return { type: p.type, optional: false, rest: true };
      if (p.default !== undefined) {
        return { type: this.optionalUnion(p.type), optional: true, rest: false };
      }
      return { type: p.type, optional: this.isOptionalParam(p.type), rest: false };
    });
  }

  // Call slots for a function *value* (a closure / function-typed variable). Its
  // `Type` carries boundary param types already; `restParam` marks the last as a
  // rest parameter. (Defaults aren't tracked in a function type — a defaulted param
  // surfaces as an optional `T | undefined` member there.)
  private slotsFromFunctionType(ft: FunctionType): CallSlot[] {
    return ft.params.map((t, i) => {
      const rest = !!ft.restParam && i === ft.params.length - 1;
      return { type: t, optional: !rest && this.isOptionalParam(t), rest };
    });
  }

  // The function-value `Type` of a callee's params/return (for a bare top-level
  // function name referenced as a value): boundary param types (a defaulted param
  // becomes optional `T | undefined`), with `restParam` set if the last is a rest.
  private fnValueType(params: Param[], ret: RetType): FunctionType {
    const last = params[params.length - 1];
    return {
      kind: "function",
      params: params.map((p) =>
        p.default !== undefined ? this.optionalUnion(p.type) : p.type,
      ),
      ret,
      restParam: last !== undefined && last.rest ? true : undefined,
    };
  }

  // Validate an argument count against [min, max] (max defaults to min for an
  // exact count; pass Infinity for "at least min"), throwing a clear error that
  // names `label` (a method/function name) on mismatch. Centralizes the arity
  // checks the string/array/map/set/math method emitters all need.
  private checkArity(
    label: string,
    count: number,
    min: number,
    max = min,
  ): void {
    if (count >= min && count <= max) return;
    const plural = (k: number) => `${k} argument${k === 1 ? "" : "s"}`;
    const want =
      max === Infinity
        ? `at least ${plural(min)}`
        : min === max
          ? plural(min)
          : `${min}-${max} arguments`;
    throw new Error(`'${label}' expects ${want}, got ${count}`);
  }

  // Emit an optional numeric argument at index `i`: returns its C++ code, or the
  // "NAN" sentinel the tsn_* helpers read as "absent" when the arg isn't present.
  // Throws (naming `label`/`what`) if present but not a number.
  private optionalNumberArg(
    args: Expr[],
    i: number,
    label: string,
    what = "argument",
  ): string {
    if (i >= args.length) return "NAN";
    const v = this.emitExpr(args[i]);
    if (v.type !== "number") {
      throw new Error(`'${label}' ${what} must be a number`);
    }
    return v.code;
  }

  // Type-check a call/ctor argument list against call slots and return each
  // emitted C++ argument (one per slot). Reps are reconciled by repr.ts (a float
  // arg demotes the matching param slot), so no per-argument cast is needed here.
  //  - A trailing optional/defaulted slot may be omitted — an `undefined` default
  //    is appended for it (the callee's body resolves a default; an optional param
  //    just receives `undefined`).
  //  - A trailing **rest** slot collects the remaining arguments into a fresh
  //    `T[]`, which may include `...spread` args (`f(1, ...xs)`); zero rest args
  //    give an empty array. A spread argument is allowed *only* in the rest region.
  private checkArgs(who: string, slots: CallSlot[], args: Expr[]): string[] {
    const hasRest = slots.length > 0 && slots[slots.length - 1].rest;
    const fixed = hasRest ? slots.slice(0, -1) : slots;
    const restSlot = hasRest ? slots[slots.length - 1] : undefined;

    // Required fixed args = leading fixed slots that are neither optional nor a
    // default (those are trailing among the fixed slots — stage 0 guarantees it).
    const firstOptional = fixed.findIndex((s) => s.optional);
    const minFixed = firstOptional === -1 ? fixed.length : firstOptional;

    // A spread argument can only feed the rest region.
    const firstSpread = args.findIndex((a) => a.kind === "spread");
    if (firstSpread !== -1 && (!hasRest || firstSpread < fixed.length)) {
      throw new Error(
        `'${who}': a spread argument ('...x') is only allowed for a rest parameter (v1)`,
      );
    }

    // Arity. With a rest parameter the maximum is unbounded.
    const wantMsg = hasRest
      ? `at least ${minFixed}`
      : minFixed === fixed.length
        ? `${fixed.length}`
        : `${minFixed}-${fixed.length}`;
    if (args.length < minFixed || (!hasRest && args.length > fixed.length)) {
      throw new Error(
        `'${who}' expects ${wantMsg} argument(s), got ${args.length}`,
      );
    }

    const out: string[] = [];
    // Fixed positional args (these are never spreads — guarded above).
    const fixedCount = Math.min(args.length, fixed.length);
    for (let i = 0; i < fixedCount; i++) {
      const val = this.emitExpr(args[i]);
      if (!this.isAssignable(fixed[i].type, val.type)) {
        throw new Error(
          `Argument ${i + 1} of '${who}': type '${displayType(val.type)}' is not assignable to '${displayType(fixed[i].type)}'`,
        );
      }
      out.push(this.coerceTo(val, fixed[i].type));
    }
    // Omitted trailing optionals/defaults receive `undefined`.
    for (let i = fixedCount; i < fixed.length; i++) {
      out.push(
        this.coerceTo({ code: "tsn_undefined{}", type: "undefined" }, fixed[i].type),
      );
    }
    // Rest: collect the remaining arguments into a fresh T[] (spreads spliced in).
    if (restSlot) {
      if (!isArray(restSlot.type)) {
        throw new Error(`Internal: rest parameter of '${who}' is not an array`);
      }
      const arr = this.emitArrayLiteral(args.slice(fixed.length), restSlot.type.element);
      out.push(arr.code);
    }
    return out;
  }

  private emitBinary(e: { op: BinaryOp; left: Expr; right: Expr }): Value {
    const l = this.emitExpr(e.left);
    // For `&&` / `||` the right operand is evaluated under the left's narrowing:
    // `a && b` runs `b` only when `a` held (positive narrowing), `a || b` runs `b`
    // only when `a` failed (negative). This is what lets `typeof x === "string" &&
    // x.length` use `x` as a string in the right operand.
    let r: Value;
    if (e.op === "&&" || e.op === "||") {
      const g = this.analyzeGuard(e.left);
      const narrow = e.op === "&&" ? g?.positive : g?.negative;
      r = this.withNarrowed(g?.name, narrow, () => this.emitExpr(e.right));
    } else {
      r = this.emitExpr(e.right);
    }
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
        return {
          code: `(${asF64(l)} / ${asF64(r)})`,
          type: "number",
          rep: "f64",
        };
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
      // Union operands: compare the underlying variant when both are the same
      // union (std::variant's `==`), or test "holds this member and equals it"
      // when one side is a member of the other (the common `x === null` / `x === 42`
      // form, which also drives narrowing — see analyzeGuard).
      if (isUnion(l.type) || isUnion(r.type)) {
        return this.emitUnionEquality(e.op, l, r);
      }
      // `std::function` has no `==`; comparing function values isn't in the subset.
      if (isFunction(l.type) || isFunction(r.type)) {
        throw new Error(
          `Function values cannot be compared with '${e.op}' (v1)`,
        );
      }
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
    // This form lowers the operands into a C++ lambda body (to keep short-circuit
    // + single left-eval), and `co_await` can't appear in a lambda. Reject an
    // awaited operand here with a clear message (assign it to a variable first).
    if (containsAwait(e.left) || containsAwait(e.right)) {
      throw new Error(
        `'await' inside a non-boolean '${e.op}' operand is not supported (v1) — assign the awaited value to a variable first`,
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

  // `===` / `!==` where at least one operand is a union.
  //  - union === union (same canonical type): compare the underlying variants.
  //  - union === member: test the variant holds that member AND equals it; this is
  //    the `x === null` / `x === 42` form. Single-eval the union side via an IIFE.
  private emitUnionEquality(op: BinaryOp, l: Value, r: Value): Value {
    const neg = (s: string) => (op === "===" ? s : `(!${s})`);
    if (isUnion(l.type) && isUnion(r.type)) {
      if (!sameType(l.type, r.type)) {
        throw new Error(
          `Cannot compare '${displayType(l.type)}' and '${displayType(r.type)}' with '${op}' — different unions (v1)`,
        );
      }
      return {
        code: neg(`((${l.code}).v() == (${r.code}).v())`),
        type: "boolean",
      };
    }
    const [u, m] = isUnion(l.type) ? [l, r] : [r, l];
    const ut = u.type as UnionType;
    if (!ut.members.some((mem) => sameType(mem, m.type))) {
      throw new Error(
        `Cannot compare '${displayType(l.type)}' and '${displayType(r.type)}' with '${op}'`,
      );
    }
    const mcpp = this.cppType(m.type);
    const mcode = this.f64SlotCode(m); // number member stored as double
    const held = `([&]{ auto&& _u = (${u.code}).v(); return std::holds_alternative<${mcpp}>(_u) && std::get<${mcpp}>(_u) == ${mcode}; }())`;
    return { code: neg(held), type: "boolean" };
  }

  // Emit a function call. In statement position a void call is allowed; in value
  // position a void call is an error.
  private emitCall(
    e: { callee: string; args: Expr[] },
    asStatement: boolean,
  ): { code: string; type: RetType } {
    const sig = this.sigs.get(e.callee);
    if (!sig) {
      // Not a top-level function: maybe a function-typed variable (a closure or a
      // function value stored in a let/param/global) — call it as a value.
      const vt = this.vars.get(e.callee) ?? this.globals.get(e.callee);
      if (vt !== undefined) {
        if (!isFunction(vt)) {
          throw new Error(`'${e.callee}' is not a function`);
        }
        return this.emitCallValue(
          { callee: { kind: "var", name: e.callee }, args: e.args },
          asStatement,
        );
      }
      throw new Error(`Unknown function: ${e.callee}`);
    }
    // Shared arg-checking (handles union widening, omitted trailing optional /
    // defaulted params, and rest-parameter collection / spread args).
    const args = this.checkArgs(
      e.callee,
      this.slotsFromParams(sig.params),
      e.args,
    );
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
    if (isArray(recv.type)) return this.emitArrayMethod(recv, e);
    if (isMap(recv.type)) return this.emitMapMethod(recv, e, asStatement);
    if (isSet(recv.type)) return this.emitSetMethod(recv, e, asStatement);
    if (isResponse(recv.type)) return this.emitResponseMethod(recv, e);
    // `obj.fn(args)` where `fn` is a function-VALUED field (not a method) — call it.
    if (isObject(recv.type)) {
      const field = recv.type.fields.find((f) => f.name === e.method);
      if (field && isFunction(field.type)) {
        return this.emitFieldCall(recv.code, field.type, e.method, e.args, asStatement);
      }
    }
    throw new Error(
      `Type '${displayType(recv.type)}' has no method '${e.method}'`,
    );
  }

  // Call a function-valued field/property: `((recv)->name)(args)`. Shared by an
  // object's function field and a class instance's function field (where the name
  // isn't a method). Arg types are checked against the field's function type.
  private emitFieldCall(
    recvCode: string,
    fieldType: FunctionType,
    name: string,
    argExprs: Expr[],
    asStatement: boolean,
  ): { code: string; type: RetType } {
    const args = this.checkArgs(
      `.${name}`,
      this.slotsFromFunctionType(fieldType),
      argExprs,
    );
    if (fieldType.ret === "void" && !asStatement) {
      throw new Error(`'${name}' returns void and cannot be used as a value`);
    }
    return {
      code: `((${recvCode})->${name})(${args.join(", ")})`,
      type: fieldType.ret,
    };
  }

  // Emit an array method call (push/pop/slice/indexOf/join/includes/reverse/…).
  // The array is a tsn_rc; the tsn_* helpers take the underlying vector, so the
  // receiver is dereferenced (`*ptr`) at each call site. Mutating methods are
  // visible through every alias (JS reference semantics); slice/concat/reverse
  // return a *new* array (a fresh tsn_rc) or the same reference, per JS.
  private emitArrayMethod(
    recv: Value,
    e: { method: string; args: Expr[] },
  ): { code: string; type: RetType } {
    const arrType = recv.type as ArrayType;
    const elem = arrType.element;
    const vecRecv = `*(${recv.code})`;
    switch (e.method) {
      case "push": {
        this.checkArity("push", e.args.length, 1);
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
        this.checkArity("pop", e.args.length, 0);
        // Returns the removed last element (the array's element type).
        return { code: `tsn_pop(${vecRecv})`, type: elem };
      }
      case "slice": {
        // `slice(start?, end?)` — both optional numbers; an omitted one is NaN
        // ("default") in the helper. Returns a *new* array (a fresh tsn_rc).
        this.checkArity("slice", e.args.length, 0, 2);
        const start = this.optionalNumberArg(e.args, 0, "slice");
        const end = this.optionalNumberArg(e.args, 1, "slice");
        const vec = this.vecType(arrType);
        return {
          code: `tsn_make_rc<${vec}>(tsn_array_slice(${vecRecv}, ${start}, ${end}))`,
          type: recv.type,
        };
      }
      case "indexOf":
      case "includes":
      case "lastIndexOf": {
        // Position / membership via element `==` (so aggregate elements, which
        // have no equality, are rejected — class elements compare by identity).
        // `indexOf(search, fromIndex?)` / `includes` / `lastIndexOf`.
        this.checkArity(e.method, e.args.length, 1, 2);
        if (isAggregate(elem)) {
          throw new Error(
            `'${e.method}' is not supported on '${displayType(recv.type)}' (elements have no equality)`,
          );
        }
        const search = this.emitExpr(e.args[0]);
        if (!sameType(search.type, elem)) {
          throw new Error(
            `'${e.method}' search type '${displayType(search.type)}' does not match element type '${displayType(elem)}'`,
          );
        }
        const from = this.optionalNumberArg(e.args, 1, e.method, "fromIndex");
        // f64SlotCode casts an i64-literal search value to the element's double
        // rep (a no-op for string/boolean/class), so the template deduces one T.
        const helper =
          e.method === "indexOf"
            ? "tsn_array_index_of"
            : e.method === "includes"
              ? "tsn_array_includes"
              : "tsn_array_last_index_of";
        return {
          code: `${helper}(${vecRecv}, ${this.f64SlotCode(search)}, ${from})`,
          type: e.method === "includes" ? "boolean" : "number",
        };
      }
      case "join": {
        this.checkArity("join", e.args.length, 0, 1);
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
      case "reverse": {
        this.checkArity("reverse", e.args.length, 0);
        // Mutates in place and returns the SAME array reference (chainable /
        // usable as a value). The IIFE takes the receiver by value (a refcount
        // bump) so the receiver expression is evaluated exactly once.
        return {
          code: `([](auto _tsn_r){ tsn_array_reverse(*_tsn_r); return _tsn_r; }(${recv.code}))`,
          type: recv.type,
        };
      }
      case "fill": {
        this.checkArity("fill", e.args.length, 1, 3);
        const val = this.emitExpr(e.args[0]);
        if (!sameType(val.type, elem)) {
          throw new Error(
            `Cannot fill '${displayType(recv.type)}' with '${displayType(val.type)}'`,
          );
        }
        // start/end are lowered into a C++ lambda body (see below), where a
        // co_await can't appear — reject an awaited index argument cleanly.
        if (e.args.slice(1).some(containsAwait)) {
          throw new Error(
            "'await' inside Array.fill's start/end is not supported (v1) — assign it to a variable first",
          );
        }
        const start = this.optionalNumberArg(e.args, 1, "fill", "start/end");
        const end = this.optionalNumberArg(e.args, 2, "fill", "start/end");
        // `[&]` captures any locals referenced by start/end; the receiver and
        // value pass as by-value args (evaluated once). Returns the array.
        return {
          code: `([&](auto _tsn_r, auto _tsn_x){ tsn_array_fill(*_tsn_r, _tsn_x, ${start}, ${end}); return _tsn_r; }(${recv.code}, ${this.f64SlotCode(val)}))`,
          type: recv.type,
        };
      }
      case "shift": {
        this.checkArity("shift", e.args.length, 0);
        // Removes and returns the first element (empty -> element default).
        return { code: `tsn_array_shift(${vecRecv})`, type: elem };
      }
      case "unshift": {
        this.checkArity("unshift", e.args.length, 1, Infinity);
        const items = e.args.map((a) => {
          const v = this.emitExpr(a);
          if (!sameType(v.type, elem)) {
            throw new Error(
              `Cannot unshift '${displayType(v.type)}' onto '${displayType(recv.type)}'`,
            );
          }
          return this.f64SlotCode(v);
        });
        // Pass the prepended items as a vector so 0..n args work; returns length.
        const vec = this.vecType(arrType);
        return {
          code: `tsn_array_unshift(${vecRecv}, ${vec}{${items.join(", ")}})`,
          type: "number",
        };
      }
      case "concat": {
        // Array operands only (element-value args aren't supported); each must
        // share the receiver's type. 0 args -> a fresh shallow copy (new identity).
        let acc = vecRecv;
        for (const a of e.args) {
          const arg = this.emitExpr(a);
          if (!sameType(arg.type, recv.type)) {
            throw new Error(
              `'concat' expects '${displayType(recv.type)}' argument(s), got '${displayType(arg.type)}'`,
            );
          }
          acc = `tsn_array_concat(${acc}, *(${arg.code}))`;
        }
        const vec = this.vecType(arrType);
        return { code: `tsn_make_rc<${vec}>(${acc})`, type: recv.type };
      }
      default:
        throw new Error(`Unsupported array method '${e.method}'`);
    }
  }

  // Emit a fetch Response method. `text()` resolves a promise over the buffered
  // body; `json()` reaches here only without a target type (lowering captures it
  // at `await res.json() as T` / annotated targets), so it's a clear error.
  private emitResponseMethod(
    recv: Value,
    e: { method: string; args: Expr[] },
  ): { code: string; type: RetType } {
    if (e.method === "text") {
      if (e.args.length !== 0) {
        throw new Error(
          `'Response.text' expects 0 arguments, got ${e.args.length}`,
        );
      }
      this.usesFetch = true;
      return {
        code: `tsn_resolve((${recv.code})->body)`,
        type: { kind: "promise", value: "string" },
      };
    }
    if (e.method === "json") {
      throw new Error(
        "res.json() needs a target type — write `await res.json() as T` or annotate the target (`const x: T = await res.json()`)",
      );
    }
    throw new Error(`Type 'Response' has no method '${e.method}'`);
  }

  // Emit a Map method call. `set` returns the map (chainable) via an IIFE that
  // takes the receiver by value so it's evaluated once; `get` returns the value
  // type (a missing key yields the value default — see tsn_map::get); `keys` /
  // `values` return arrays; `has` / `delete` booleans; `clear` is statement-only.
  private emitMapMethod(
    recv: Value,
    e: { method: string; args: Expr[] },
    asStatement: boolean,
  ): { code: string; type: RetType } {
    const t = recv.type as MapType;
    const { key, value } = t;
    const arity = (n: number) =>
      this.checkArity(`Map.${e.method}`, e.args.length, n);
    // Emit + type-check the first argument as a key, returning its (f64-cast) code.
    const keyArg = (): string => {
      const k = this.emitExpr(e.args[0]);
      if (!sameType(k.type, key)) {
        throw new Error(
          `'Map.${e.method}' key type '${displayType(k.type)}' does not match '${displayType(key)}'`,
        );
      }
      return this.f64SlotCode(k);
    };
    switch (e.method) {
      case "set": {
        arity(2);
        const k = this.emitExpr(e.args[0]);
        if (!sameType(k.type, key)) {
          throw new Error(
            `'Map.set' key type '${displayType(k.type)}' does not match '${displayType(key)}'`,
          );
        }
        const v = this.emitExpr(e.args[1]);
        if (!sameType(v.type, value)) {
          throw new Error(
            `'Map.set' value type '${displayType(v.type)}' does not match '${displayType(value)}'`,
          );
        }
        return {
          code: `([](auto _tsn_m, auto _tsn_k, auto _tsn_v){ _tsn_m->set(_tsn_k, _tsn_v); return _tsn_m; }(${recv.code}, ${this.f64SlotCode(k)}, ${this.f64SlotCode(v)}))`,
          type: t,
        };
      }
      case "get":
        arity(1);
        return { code: `(${recv.code})->get(${keyArg()})`, type: value };
      case "has":
        arity(1);
        return { code: `(${recv.code})->has(${keyArg()})`, type: "boolean" };
      case "delete":
        arity(1);
        return { code: `(${recv.code})->del(${keyArg()})`, type: "boolean" };
      case "clear":
        arity(0);
        if (!asStatement) {
          throw new Error(
            "'Map.clear' returns void and cannot be used as a value",
          );
        }
        return { code: `(${recv.code})->clear()`, type: "void" };
      case "keys":
        arity(0);
        return {
          code: `(${recv.code})->keys()`,
          type: { kind: "array", element: key },
        };
      case "values":
        arity(0);
        return {
          code: `(${recv.code})->values()`,
          type: { kind: "array", element: value },
        };
      case "forEach":
        throw new Error(
          "'Map.forEach' is not supported (v1) — no first-class functions; iterate for…of over .keys()/.values()",
        );
      case "entries":
        throw new Error(
          "'Map.entries' is not supported (v1) — tuples are out of subset; iterate .keys()/.values()",
        );
      default:
        throw new Error(`Map has no method '${e.method}'`);
    }
  }

  // Emit a Set method call. `add` returns the set (chainable, IIFE-evaluated once);
  // `has` / `delete` booleans; `values` / `keys` the elements as an array; `clear`
  // is statement-only. forEach/entries are rejected (callbacks / tuples).
  private emitSetMethod(
    recv: Value,
    e: { method: string; args: Expr[] },
    asStatement: boolean,
  ): { code: string; type: RetType } {
    const t = recv.type as SetType;
    const elem = t.element;
    const arity = (n: number) =>
      this.checkArity(`Set.${e.method}`, e.args.length, n);
    const elemArg = (): string => {
      const x = this.emitExpr(e.args[0]);
      if (!sameType(x.type, elem)) {
        throw new Error(
          `'Set.${e.method}' value type '${displayType(x.type)}' does not match '${displayType(elem)}'`,
        );
      }
      return this.f64SlotCode(x);
    };
    switch (e.method) {
      case "add": {
        arity(1);
        const x = this.emitExpr(e.args[0]);
        if (!sameType(x.type, elem)) {
          throw new Error(
            `'Set.add' value type '${displayType(x.type)}' does not match '${displayType(elem)}'`,
          );
        }
        return {
          code: `([](auto _tsn_s, auto _tsn_x){ _tsn_s->add(_tsn_x); return _tsn_s; }(${recv.code}, ${this.f64SlotCode(x)}))`,
          type: t,
        };
      }
      case "has":
        arity(1);
        return { code: `(${recv.code})->has(${elemArg()})`, type: "boolean" };
      case "delete":
        arity(1);
        return { code: `(${recv.code})->del(${elemArg()})`, type: "boolean" };
      case "clear":
        arity(0);
        if (!asStatement) {
          throw new Error(
            "'Set.clear' returns void and cannot be used as a value",
          );
        }
        return { code: `(${recv.code})->clear()`, type: "void" };
      case "values":
      case "keys":
        arity(0);
        return {
          code: `(${recv.code})->values()`,
          type: { kind: "array", element: elem },
        };
      case "forEach":
        throw new Error(
          "'Set.forEach' is not supported (v1) — no first-class functions; iterate with for…of",
        );
      case "entries":
        throw new Error(
          "'Set.entries' is not supported (v1) — tuples are out of subset; iterate with for…of",
        );
      default:
        throw new Error(`Set has no method '${e.method}'`);
    }
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
      // Not a method: maybe a function-valued field (`this.cb = …; inst.cb(x)`).
      const field = cls.fields.find((f) => f.name === e.method);
      if (field && isFunction(field.type)) {
        return this.emitFieldCall(
          recv.code,
          field.type,
          e.method,
          e.args,
          asStatement,
        );
      }
      throw new Error(`Class '${cls.name}' has no method '${e.method}'`);
    }
    const args = this.checkArgs(
      `${cls.name}.${e.method}`,
      this.slotsFromParams(method.params),
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
      this.checkArity(e.method, argv.length, lo, hi);
      for (const a of argv) {
        if (a.type !== "number") {
          throw new Error(`'${e.method}' arguments must be numbers`);
        }
      }
      return Array.from({ length: hi }, (_, i) => argv[i]?.code ?? "NAN");
    };
    // A string search argument plus an optional numeric position — the shape
    // indexOf / lastIndexOf / includes / startsWith / endsWith all share. Returns
    // `[searchCode, positionCodeOrNAN]`; `what` names the numeric arg in errors.
    const searchAndPosition = (what: string): [string, string] => {
      this.checkArity(e.method, argv.length, 1, 2);
      if (argv[0].type !== "string") {
        throw new Error(`'${e.method}' search argument must be a string`);
      }
      const pos = this.optionalNumberArg(e.args, 1, e.method, what);
      return [argv[0].code, pos];
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
        return {
          code: `tsn_substring(${s}, ${start}, ${end})`,
          type: "string",
        };
      }
      case "slice": {
        const [start, end] = numArgs(1, 2);
        return { code: `tsn_slice(${s}, ${start}, ${end})`, type: "string" };
      }
      case "split": {
        // `split(sep: string, limit?: number)` -> string[]. Regex separators are
        // outside the subset (a regex literal already fails at lowering).
        this.checkArity("split", argv.length, 1, 2);
        if (argv[0].type !== "string") {
          throw new Error("'split' separator must be a string");
        }
        const limit = this.optionalNumberArg(e.args, 1, "split", "limit");
        // Returns a reference-typed string[] (a shared_ptr to the result vector).
        return {
          code: `tsn_make_rc<std::vector<tsn_str>>(tsn_split(${s}, ${argv[0].code}, ${limit}))`,
          type: { kind: "array", element: "string" },
        };
      }
      case "indexOf": {
        const [search, from] = searchAndPosition("fromIndex");
        return {
          code: `tsn_index_of(${s}, ${search}, ${from})`,
          type: "number",
        };
      }
      case "lastIndexOf": {
        const [search, from] = searchAndPosition("fromIndex");
        return {
          code: `tsn_last_index_of(${s}, ${search}, ${from})`,
          type: "number",
        };
      }
      case "includes":
      case "startsWith":
      case "endsWith": {
        // A string search + optional numeric position; returns a boolean.
        const [search, pos] = searchAndPosition("position");
        const helper =
          e.method === "includes"
            ? "tsn_str_includes"
            : e.method === "startsWith"
              ? "tsn_starts_with"
              : "tsn_ends_with";
        return {
          code: `${helper}(${s}, ${search}, ${pos})`,
          type: "boolean",
        };
      }
      case "repeat": {
        const [n] = numArgs(1, 1);
        return { code: `tsn_repeat(${s}, ${n})`, type: "string" };
      }
      case "trim":
        numArgs(0, 0);
        return { code: `tsn_trim(${s})`, type: "string" };
      case "trimStart":
        numArgs(0, 0);
        return { code: `tsn_trim_start(${s})`, type: "string" };
      case "trimEnd":
        numArgs(0, 0);
        return { code: `tsn_trim_end(${s})`, type: "string" };
      case "padStart":
      case "padEnd": {
        // `padStart(targetLength, padString = " ")`.
        this.checkArity(e.method, argv.length, 1, 2);
        if (argv[0].type !== "number") {
          throw new Error(`'${e.method}' target length must be a number`);
        }
        let pad = `" "`;
        if (argv.length === 2) {
          if (argv[1].type !== "string") {
            throw new Error(`'${e.method}' pad argument must be a string`);
          }
          pad = argv[1].code;
        }
        const helper =
          e.method === "padStart" ? "tsn_pad_start" : "tsn_pad_end";
        return {
          code: `${helper}(${s}, ${argv[0].code}, ${pad})`,
          type: "string",
        };
      }
      case "replace":
      case "replaceAll": {
        // String search + string replacement only (regex / function args are out
        // of subset). `replace` hits the first match; `replaceAll` every match.
        this.checkArity(e.method, argv.length, 2);
        if (argv[0].type !== "string" || argv[1].type !== "string") {
          throw new Error(
            `'${e.method}' arguments must be strings (regex / function args are out of subset)`,
          );
        }
        const helper =
          e.method === "replace" ? "tsn_replace" : "tsn_replace_all";
        return {
          code: `${helper}(${s}, ${argv[0].code}, ${argv[1].code})`,
          type: "string",
        };
      }
      case "concat": {
        // Fold into +-concatenation; every operand must already be a string
        // (TypeScript's String.concat signature rejects non-string args).
        for (const a of argv) {
          if (a.type !== "string") {
            throw new Error("'concat' arguments must be strings");
          }
        }
        let acc = s;
        for (const a of argv) acc = `(${acc} + ${a.code})`;
        return { code: acc, type: "string" };
      }
      default:
        throw new Error(`Unsupported string method '${e.method}'`);
    }
  }
}

// Does `e` contain an `await` anywhere in its subtree? Used to reject `await` in
// the few spots codegen lowers to a C++ *lambda body* — the operand-returning
// `&&`/`||` IIFE and Array.fill's index args — where a `co_await` can't appear
// (a lambda is not a coroutine). `await` in plain positions (let/return/args/if/
// while/ternary branches/IIFE *arguments*) is fine and not flagged.
function containsAwait(e: Expr): boolean {
  switch (e.kind) {
    case "await":
      return true;
    case "binary":
      return containsAwait(e.left) || containsAwait(e.right);
    case "unary":
      return containsAwait(e.operand);
    case "ternary":
      return (
        containsAwait(e.cond) ||
        containsAwait(e.whenTrue) ||
        containsAwait(e.whenFalse)
      );
    case "array":
      return e.elements.some(containsAwait);
    case "index":
      return containsAwait(e.arr) || containsAwait(e.index);
    case "object":
      return e.properties.some((p) => containsAwait(p.value));
    case "member":
      return containsAwait(e.obj);
    case "call":
      return e.args.some(containsAwait);
    case "methodCall":
      return containsAwait(e.receiver) || e.args.some(containsAwait);
    case "new":
      return e.args.some(containsAwait);
    case "jsonStringify":
    case "promiseResolve":
    case "promiseAll":
      return containsAwait(e.arg);
    case "jsonParse":
      return containsAwait(e.text);
    case "mathCall":
      return e.args.some(containsAwait);
    case "setNew":
      return e.init ? containsAwait(e.init) : false;
    case "fetch":
      return containsAwait(e.url);
    case "responseJson":
      return containsAwait(e.receiver);
    case "callValue":
      return containsAwait(e.callee) || e.args.some(containsAwait);
    case "spread":
      return containsAwait(e.arg);
    case "closure":
      // A closure's body is a separate function — any `await` in it belongs to that
      // (async) closure's coroutine, not the enclosing one. Don't recurse.
      return false;
    default:
      return false; // num / bool / str / var / this / mathConst / mapNew
  }
}

// Does a statement (or anything nested within it) contain an `await`? Used to
// detect **top-level await** in the entry's top-level statements — including
// inside a top-level loop/if/try (function bodies are hoisted out of `main`, so
// there's nothing to recurse *into* that we shouldn't).
function stmtContainsAwait(s: Stmt): boolean {
  switch (s.kind) {
    case "let":
      return containsAwait(s.init);
    case "log":
      return containsAwait(s.arg);
    case "return":
      return s.value ? containsAwait(s.value) : false;
    case "exprStmt":
      return containsAwait(s.expr);
    case "assign":
      return containsAwait(s.target) || containsAwait(s.value);
    case "if":
      return (
        containsAwait(s.cond) ||
        s.then.some(stmtContainsAwait) ||
        (s.else?.some(stmtContainsAwait) ?? false)
      );
    case "while":
    case "doWhile":
      return containsAwait(s.cond) || s.body.some(stmtContainsAwait);
    case "for":
      return (
        (s.init ? stmtContainsAwait(s.init) : false) ||
        (s.cond ? containsAwait(s.cond) : false) ||
        (s.update ? stmtContainsAwait(s.update) : false) ||
        s.body.some(stmtContainsAwait)
      );
    case "forOf":
      return containsAwait(s.iterable) || s.body.some(stmtContainsAwait);
    case "forIn":
      return containsAwait(s.target) || s.body.some(stmtContainsAwait);
    case "switch":
      return (
        containsAwait(s.disc) ||
        s.cases.some(
          (c) =>
            (c.test ? containsAwait(c.test) : false) ||
            c.body.some(stmtContainsAwait),
        )
      );
    case "labeled":
      return stmtContainsAwait(s.body);
    case "throw":
      return containsAwait(s.value);
    case "try":
      return (
        s.block.some(stmtContainsAwait) ||
        (s.catchBody?.some(stmtContainsAwait) ?? false) ||
        (s.finallyBody?.some(stmtContainsAwait) ?? false)
      );
    case "break":
    case "continue":
      return false;
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
