// Stage 3a: representation inference for `number` (run before emission).
//
// JS `number` is an IEEE double, but most numbers in real programs are
// integer-valued — loop counters, array indices, PRNG state, hashes. Backing
// those with a 64-bit integer (`long long`) instead of `double` lets integer
// arithmetic, `%`, and comparisons use the CPU's integer units directly; a
// prime sieve runs ~1.8x faster (see benchmark/run.mjs).
//
// This pass decides, for every number variable, parameter, and function return
// (each a "slot"), whether it can use the integer representation ("i64") or must
// stay floating ("f64").
//
// SOUNDNESS. A slot is "i64" only when EVERY value that can flow into it is
// provably integer-valued: a safe-integer literal, i64 arithmetic of i64
// operands, `.length`, an i64 variable/parameter/return. `/` is always "f64"
// (JS `/` is float division — this is also what fixes plain `int/int`), and `%`
// yields "f64" too so that `x % 0 === NaN` stays representable. The analysis is a
// monotone fixpoint: every number slot starts optimistic ("i64") and is demoted
// to "f64" the moment a floating source is found, iterating until stable. Because
// demotion only ever moves i64 -> f64, it converges, and an "i64" slot can never
// receive a fractional value (which would silently truncate). The one accepted
// imprecision — shared with every native-int compilation strategy — is wraparound
// past 2^63 for integer-valued numbers; `number` is otherwise f64.

import { Module, Expr, Stmt, Type, RetType, Param, ClassDecl } from "../ir/nodes";

export type Rep = "i64" | "f64";

// The scope key for top-level (`main`) variables; functions use their own name.
export const MAIN_KEY = "$main";

// A safe integer is exactly representable in both f64 and i64, so it may use the
// integer representation. Larger or fractional literals stay f64.
export function litRep(value: number): Rep {
  return Number.isSafeInteger(value) ? "i64" : "f64";
}

// Result rep of `+`, `-`, `*`: integer only when both operands are integers.
export function combineRep(a: Rep, b: Rep): Rep {
  return a === "i64" && b === "i64" ? "i64" : "f64";
}

// What the emitter queries after analysis: the chosen rep of any number slot.
export interface RepTable {
  varRep(funcKey: string, name: string): Rep;
  retRep(funcName: string): Rep;
  // Rep of a module-level (global) variable — a direct top-level `let`/`const`,
  // promoted to a file-scope global so functions can reference it. Keyed by the
  // (already program-unique) variable name, not by a function scope.
  globalRep(name: string): Rep;
}

export function analyze(mod: Module): RepTable {
  return new RepAnalyzer(mod).run();
}

interface Sig {
  params: Param[];
  ret: RetType;
}

class RepAnalyzer {
  private sigs = new Map<string, Sig>();
  private classes = new Map<string, ClassDecl>();
  // The class whose method/ctor body is being walked (so `this` resolves).
  private currentClass?: ClassDecl;
  // Only stores demotions (-> "f64"); an absent number slot is optimistically "i64".
  private repOf = new Map<string, Rep>();
  private changed = false;

  // Module-level globals: the direct top-level `let`/`const` statements in `main`
  // (promoted to file-scope globals so functions can reference them). Tracked by
  // node identity (`globalNodes`) for the declaration site and by name
  // (`globalSet`) for resolving references — a reference is a global only when it
  // is NOT shadowed by a local binding (so `globalSet` is checked after `scope`).
  // `globalTypes` is the inferred type of each, built during the `main` walk.
  private globalNodes = new Set<Stmt>();
  private globalSet = new Set<string>();
  private globalTypes = new Map<string, Type>();

  constructor(private mod: Module) {
    for (const fn of mod.functions) {
      this.sigs.set(fn.name, { params: fn.params, ret: fn.returnType });
    }
    for (const cls of mod.classes) this.classes.set(cls.name, cls);
    for (const s of mod.main) {
      if (s.kind === "let") {
        this.globalNodes.add(s);
        this.globalSet.add(s.name);
      }
    }
  }

  run(): RepTable {
    // Monotone fixpoint: re-walk the whole module, applying demotions, until a
    // full pass makes no change. Demotions are i64 -> f64 only, so this is
    // bounded by the number of slots; the guard is a runaway backstop.
    let guard = 0;
    do {
      this.changed = false;
      for (const fn of this.mod.functions) {
        const scope = new Map<string, Type>();
        for (const p of fn.params) scope.set(p.name, p.type);
        this.walkAll(fn.body, scope, fn.name, fn.returnType);
      }
      // Class constructors and methods are analyzed as their own scopes (keys
      // `C#$ctor` / `C#method`, matching the emitter), so method-local number
      // params/locals/returns get the same i64/f64 treatment as free functions,
      // and a float arg passed from a method demotes the callee's param.
      for (const cls of this.mod.classes) {
        this.currentClass = cls;
        const ctorScope = new Map<string, Type>();
        for (const p of cls.ctor.params) ctorScope.set(p.name, p.type);
        this.walkAll(cls.ctor.body, ctorScope, ctorSlotKey(cls.name), "void");
        for (const m of cls.methods) {
          const scope = new Map<string, Type>();
          for (const p of m.params) scope.set(p.name, p.type);
          this.walkAll(m.body, scope, methodSlotKey(cls.name, m.name), m.returnType);
        }
        this.currentClass = undefined;
      }
      this.walkAll(this.mod.main, new Map(), MAIN_KEY, "void");
      // Dependency module bodies run inside their own `init()` — analyze each
      // under its own scope key (matching the emitter's `$dep<idx>`), so nested
      // locals get reps and a float argument passed to a function from a module's
      // top-level demotes the callee's parameter. The module variables themselves
      // are record fields (f64), reached via member access, so they need no slot.
      for (const dm of this.mod.modules) {
        this.walkAll(dm.body, new Map(), `$dep${dm.index}`, "void");
      }
    } while (this.changed && ++guard < 100000);

    const repOf = this.repOf;
    return {
      varRep: (fk, name) => repOf.get(varSlot(fk, name)) ?? "i64",
      retRep: (fn) => repOf.get(retSlot(fn)) ?? "i64",
      globalRep: (name) => repOf.get(globalSlot(name)) ?? "i64",
    };
  }

  private getRep(slot: string): Rep {
    return this.repOf.get(slot) ?? "i64";
  }

  private demote(slot: string): void {
    if (this.getRep(slot) === "i64") {
      this.repOf.set(slot, "f64");
      this.changed = true;
    }
  }

  // --- statements: track variable types in `scope`, record slot demotions -----

  private walkAll(
    stmts: Stmt[],
    scope: Map<string, Type>,
    fk: string,
    ret: RetType,
  ): void {
    for (const s of stmts) this.walk(s, scope, fk, ret);
  }

  private walk(
    s: Stmt,
    scope: Map<string, Type>,
    fk: string,
    ret: RetType,
  ): void {
    switch (s.kind) {
      case "let": {
        const init = this.visit(s.init, scope, fk);
        // An annotation is authoritative for the type (e.g. empty `[]` or a
        // declared `: number`); otherwise the type is inferred from the init.
        const type = s.type !== undefined ? s.type : (init.type as Type);
        // A direct top-level `let` is a global (file-scope), not a local: record
        // its type and demote its global slot, but do NOT add it to the local
        // scope (so a same-named function-local stays a distinct local slot).
        if (this.globalNodes.has(s)) {
          this.globalTypes.set(s.name, type);
          if (type === "number" && init.rep === "f64") {
            this.demote(globalSlot(s.name));
          }
        } else {
          scope.set(s.name, type);
          if (type === "number" && init.rep === "f64") {
            this.demote(varSlot(fk, s.name));
          }
        }
        return;
      }
      case "assign": {
        const val = this.visit(s.value, scope, fk);
        if (s.target.kind === "var") {
          const name = s.target.name;
          if (scope.get(name) === "number" && val.rep === "f64") {
            this.demote(varSlot(fk, name));
          } else if (
            !scope.has(name) &&
            this.globalTypes.get(name) === "number" &&
            val.rep === "f64"
          ) {
            // Assigning a fraction to a (non-shadowed) global demotes its slot.
            this.demote(globalSlot(name));
          }
        } else {
          // index/member target — object fields and array elements are f64, so
          // no slot to demote; still visit it to surface nested calls.
          this.visit(s.target, scope, fk);
        }
        return;
      }
      case "return": {
        if (s.value) {
          const val = this.visit(s.value, scope, fk);
          if (ret === "number" && val.rep === "f64") this.demote(retSlot(fk));
        }
        return;
      }
      case "log":
        this.visit(s.arg, scope, fk);
        return;
      case "exprStmt":
        this.visit(s.expr, scope, fk);
        return;
      case "if":
        this.visit(s.cond, scope, fk);
        this.walkAll(s.then, scope, fk, ret);
        if (s.else) this.walkAll(s.else, scope, fk, ret);
        return;
      case "while":
        this.visit(s.cond, scope, fk);
        this.walkAll(s.body, scope, fk, ret);
        return;
      case "for": {
        // A `let` init is scoped to the loop (matching the emitter); drop it after.
        let loopVar: string | undefined;
        if (s.init) {
          this.walk(s.init, scope, fk, ret);
          if (s.init.kind === "let") loopVar = s.init.name;
        }
        if (s.cond) this.visit(s.cond, scope, fk);
        if (s.update) this.walk(s.update, scope, fk, ret);
        this.walkAll(s.body, scope, fk, ret);
        if (loopVar) scope.delete(loopVar);
        return;
      }
    }
  }

  // --- expressions: compute (type, rep); record call arg -> param demotions ---
  //
  // This mirrors the emitter's type rules closely enough to identify number
  // slots and integer-valued sources. It is NOT the authority on types — the
  // emitter re-derives and validates types during emission — so a divergence
  // here can only make a rep more conservative (slower), never unsound: an
  // expression is rep "i64" only when it is structurally integer-valued.
  private visit(
    e: Expr,
    scope: Map<string, Type>,
    fk: string,
  ): { type: RetType; rep: Rep } {
    switch (e.kind) {
      case "num":
        return { type: "number", rep: litRep(e.value) };
      case "str":
        return { type: "string", rep: "f64" };
      case "bool":
        return { type: "boolean", rep: "f64" };
      case "this":
        return {
          type: this.currentClass
            ? { kind: "class", name: this.currentClass.name }
            : "number",
          rep: "f64",
        };
      case "new": {
        const cls = this.classes.get(e.className);
        e.args.forEach((arg, i) => {
          const av = this.visit(arg, scope, fk);
          const p = cls?.ctor.params[i];
          // A float ctor argument forces the matching ctor param to f64.
          if (p && p.type === "number" && av.rep === "f64") {
            this.demote(varSlot(ctorSlotKey(e.className), p.name));
          }
        });
        return { type: { kind: "class", name: e.className }, rep: "f64" };
      }
      case "var": {
        // A local binding shadows a same-named global, so check `scope` first.
        if (scope.has(e.name)) {
          const t = scope.get(e.name)!;
          return {
            type: t,
            rep: t === "number" ? this.getRep(varSlot(fk, e.name)) : "f64",
          };
        }
        if (this.globalSet.has(e.name)) {
          const t = this.globalTypes.get(e.name) ?? "number";
          return {
            type: t,
            rep: t === "number" ? this.getRep(globalSlot(e.name)) : "f64",
          };
        }
        return { type: "number", rep: this.getRep(varSlot(fk, e.name)) };
      }
      case "unary": {
        const v = this.visit(e.operand, scope, fk);
        if (e.op === "!") return { type: "boolean", rep: "f64" };
        return { type: "number", rep: v.rep }; // -x / +x preserve the rep
      }
      case "binary": {
        const l = this.visit(e.left, scope, fk);
        const r = this.visit(e.right, scope, fk);
        if (e.op === "+" && (l.type === "string" || r.type === "string")) {
          return { type: "string", rep: "f64" }; // concatenation
        }
        if (e.op === "/" || e.op === "%") {
          // `/` is float division; `%` returns float so `x % 0 === NaN` works.
          return { type: "number", rep: "f64" };
        }
        if (e.op === "+" || e.op === "-" || e.op === "*") {
          return { type: "number", rep: combineRep(l.rep, r.rep) };
        }
        return { type: "boolean", rep: "f64" }; // relational / equality / logical
      }
      case "array": {
        const els = e.elements.map((el) => this.visit(el, scope, fk));
        const element = (els[0]?.type ?? "number") as Type;
        return { type: { kind: "array", element }, rep: "f64" };
      }
      case "object": {
        const fields = e.properties.map((p) => ({
          name: p.name,
          type: this.visit(p.value, scope, fk).type as Type,
        }));
        return { type: { kind: "object", fields }, rep: "f64" };
      }
      case "index": {
        const arr = this.visit(e.arr, scope, fk);
        this.visit(e.index, scope, fk);
        if (arr.type === "string") return { type: "string", rep: "f64" };
        if (typeof arr.type === "object" && arr.type.kind === "array") {
          return { type: arr.type.element, rep: "f64" };
        }
        return { type: "number", rep: "f64" };
      }
      case "member": {
        const obj = this.visit(e.obj, scope, fk);
        const arrayOrString =
          obj.type === "string" ||
          (typeof obj.type === "object" && obj.type.kind === "array");
        if (e.name === "length" && arrayOrString) {
          return { type: "number", rep: "i64" }; // .size() is a non-negative integer
        }
        if (typeof obj.type === "object" && obj.type.kind === "object") {
          const field = obj.type.fields.find((f) => f.name === e.name);
          if (field) return { type: field.type, rep: "f64" };
        }
        if (typeof obj.type === "object" && obj.type.kind === "class") {
          const field = this.classes
            .get(obj.type.name)
            ?.fields.find((f) => f.name === e.name);
          if (field) return { type: field.type, rep: "f64" };
        }
        return { type: "number", rep: "f64" };
      }
      case "call": {
        const sig = this.sigs.get(e.callee);
        e.args.forEach((arg, i) => {
          const av = this.visit(arg, scope, fk);
          const p = sig?.params[i];
          // A float argument forces the parameter to f64 at every call site.
          if (p && p.type === "number" && av.rep === "f64") {
            this.demote(varSlot(e.callee, p.name));
          }
        });
        if (!sig) return { type: "number", rep: "f64" };
        return {
          type: sig.ret,
          rep: sig.ret === "number" ? this.getRep(retSlot(e.callee)) : "f64",
        };
      }
      case "methodCall": {
        const recv = this.visit(e.receiver, scope, fk);
        // Instance method: demote its number params from float args (like a
        // call), and report its return type. Number returns are treated as f64
        // (matching the emitter), so no method retRep is queried.
        if (typeof recv.type === "object" && recv.type.kind === "class") {
          const className = recv.type.name;
          const method = this.classes
            .get(className)
            ?.methods.find((m) => m.name === e.method);
          e.args.forEach((arg, i) => {
            const av = this.visit(arg, scope, fk);
            const p = method?.params[i];
            if (p && p.type === "number" && av.rep === "f64") {
              this.demote(varSlot(methodSlotKey(className, e.method), p.name));
            }
          });
          return { type: method ? method.returnType : "number", rep: "f64" };
        }
        // Array methods: dispatch on the receiver type so the result type matches
        // the emitter (e.g. array `slice` is an array, not a string). Number
        // results stay f64, like every other method's number return.
        if (typeof recv.type === "object" && recv.type.kind === "array") {
          e.args.forEach((a) => this.visit(a, scope, fk));
          const elem = recv.type.element;
          switch (e.method) {
            case "pop":
              return { type: elem, rep: "f64" };
            case "slice":
              return { type: recv.type, rep: "f64" };
            case "join":
              return { type: "string", rep: "f64" };
            // push (new length) / indexOf (-1 or index) -> number.
            default:
              return { type: "number", rep: "f64" };
          }
        }
        e.args.forEach((a) => this.visit(a, scope, fk));
        switch (e.method) {
          case "toUpperCase":
          case "toLowerCase":
          case "charAt":
          case "substring":
          case "slice":
          case "join":
            return { type: "string", rep: "f64" };
          case "split":
            return { type: { kind: "array", element: "string" }, rep: "f64" };
          default:
            // String charCodeAt / indexOf -> number (can be NaN/-1, kept f64).
            return { type: "number", rep: "f64" };
        }
      }
    }
  }
}

function varSlot(funcKey: string, name: string): string {
  return `${funcKey}::${name}`;
}
// Slot for a module-level global. Globals have program-unique names (the loader
// mangles cross-module collisions), so the name alone keys the slot; the `$g::`
// prefix keeps it distinct from any function-scoped `funcKey::name` slot.
function globalSlot(name: string): string {
  return `$g::${name}`;
}
function retSlot(funcName: string): string {
  return `${funcName}::$ret`;
}
// Scope keys for a class's methods / constructor — must match the emitter's
// methodKey / ctorKey so both sides look up the same number-rep slots.
function methodSlotKey(className: string, method: string): string {
  return `${className}#${method}`;
}
function ctorSlotKey(className: string): string {
  return `${className}#$ctor`;
}
