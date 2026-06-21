// Stage 3a (with repr.ts): closure preparation — runs once over the merged IR
// Module before number-representation analysis and emission.
//
// It does two things:
//   1. Assigns each `closure` node a unique `id`, so repr.ts and emit.ts agree on
//      the closure's rep-scope key (`$closure<id>`).
//   2. CAPTURE ANALYSIS. A C++ lambda with default capture (`[=]`) copies the
//      automatic variables it uses — which is wrong for a JS closure that must
//      *share* (and observe later mutations to) an enclosing local. So a local
//      variable that is captured by a nested closure is marked `boxed`: codegen
//      stores it in a heap `tsn_box` cell (a `tsn_rc`), and both the enclosing
//      scope and the closure reach the one shared binding through that cell.
//
// A variable is captured when a *nested* closure references it across a function
// boundary. Top-level (entry/dependency) module variables become file-scope
// globals / record fields — referenced directly, never captured — so they are
// never boxed. The walk tracks, per binding, the id of the function scope that
// owns it; a reference whose current function scope differs from the binding's
// owner (and the binding is not global) marks that binding boxed.

import { Module, Stmt, Expr, Param } from "../ir/nodes";

export function prepareClosures(mod: Module): void {
  new CaptureAnalysis().run(mod);
}

// A live binding in a scope frame: the function scope that owns it, whether it is
// a (never-boxed) global, and a callback that flips the boxed flag on its node.
interface Binding {
  ownerId: number;
  global: boolean;
  box: () => void;
}

class CaptureAnalysis {
  private frames: Map<string, Binding>[] = [];
  private curOwner = 0;
  private nextOwner = 1;
  private nextId = 0;
  // How many closure boundaries enclose the current position (so bare `this`
  // inside a closure can be rejected — lexical `this` capture is out of subset).
  private closureDepth = 0;

  run(mod: Module): void {
    for (const f of mod.functions) this.walkFunction(f.params, f.body);
    for (const c of mod.classes) {
      this.walkFunction(c.ctor.params, c.ctor.body);
      for (const m of c.methods) this.walkFunction(m.params, m.body);
    }
    this.walkTopLevel(mod.main);
    for (const dm of mod.modules) this.walkTopLevel(dm.body);
  }

  // A function / method / constructor / closure scope: its parameters are locals
  // of a fresh owner id; the body's references to outer locals capture them.
  private walkFunction(params: Param[], body: Stmt[]): void {
    const owner = this.nextOwner++;
    const saved = this.curOwner;
    this.curOwner = owner;
    this.frames.push(new Map());
    for (const p of params) this.declare(p.name, false, () => (p.boxed = true));
    this.walkStmts(body, false);
    this.frames.pop();
    this.curOwner = saved;
  }

  // The entry's `main` body, or a dependency module's `init` body. Its *direct*
  // top-level `let`s are globals / record fields (never boxed); nested `let`s and
  // loop variables are ordinary locals of this scope.
  private walkTopLevel(stmts: Stmt[]): void {
    const owner = this.nextOwner++;
    const saved = this.curOwner;
    this.curOwner = owner;
    this.frames.push(new Map());
    this.walkStmts(stmts, true);
    this.frames.pop();
    this.curOwner = saved;
  }

  private declare(name: string, global: boolean, box: () => void): void {
    this.frames[this.frames.length - 1].set(name, {
      ownerId: this.curOwner,
      global,
      box,
    });
  }

  // Resolve a name reference: if it binds to a local in an *enclosing* function
  // scope (different owner, not global), that binding is captured — box it.
  private reference(name: string): void {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const b = this.frames[i].get(name);
      if (b) {
        if (!b.global && b.ownerId !== this.curOwner) b.box();
        return;
      }
    }
    // Not found in any frame: a top-level function / class / builtin — not a
    // captured local, so nothing to box.
  }

  private walkStmts(stmts: Stmt[], topLevel: boolean): void {
    for (const s of stmts) this.walkStmt(s, topLevel);
  }

  private walkStmt(s: Stmt, topLevel: boolean): void {
    switch (s.kind) {
      case "let":
        // Declare before walking the initializer so a self-referential closure
        // (`const f = () => f()`) captures its own (boxed) binding.
        this.declare(s.name, topLevel, () => (s.boxed = true));
        this.walkExpr(s.init);
        return;
      case "assign":
        this.walkExpr(s.target);
        this.walkExpr(s.value);
        return;
      case "return":
        if (s.value) this.walkExpr(s.value);
        return;
      case "log":
        this.walkExpr(s.arg);
        return;
      case "exprStmt":
        this.walkExpr(s.expr);
        return;
      case "throw":
        this.walkExpr(s.value);
        return;
      case "if":
        this.walkExpr(s.cond);
        this.walkStmts(s.then, false);
        if (s.else) this.walkStmts(s.else, false);
        return;
      case "while":
      case "doWhile":
        this.walkExpr(s.cond);
        this.walkStmts(s.body, false);
        return;
      case "for":
        if (s.init) this.walkStmt(s.init, false);
        if (s.cond) this.walkExpr(s.cond);
        if (s.update) this.walkStmt(s.update, false);
        this.walkStmts(s.body, false);
        return;
      case "forOf":
        this.walkExpr(s.iterable);
        this.declare(s.name, false, () => (s.boxed = true));
        this.walkStmts(s.body, false);
        return;
      case "forIn":
        this.walkExpr(s.target);
        this.declare(s.name, false, () => (s.boxed = true));
        this.walkStmts(s.body, false);
        return;
      case "switch":
        this.walkExpr(s.disc);
        for (const c of s.cases) {
          if (c.test) this.walkExpr(c.test);
          this.walkStmts(c.body, false);
        }
        return;
      case "labeled":
        this.walkStmt(s.body, false);
        return;
      case "break":
      case "continue":
        return;
      case "try":
        this.walkStmts(s.block, false);
        if (s.catchBody) {
          if (s.catchName) {
            this.declare(s.catchName, false, () => (s.catchBoxed = true));
          }
          this.walkStmts(s.catchBody, false);
        }
        if (s.finallyBody) this.walkStmts(s.finallyBody, false);
        return;
    }
  }

  private walkExpr(e: Expr): void {
    switch (e.kind) {
      case "var":
        this.reference(e.name);
        return;
      case "this":
        if (this.closureDepth > 0) {
          throw new Error(
            "'this' inside an arrow function / closure is not supported yet (v1)",
          );
        }
        return;
      case "closure": {
        if (e.id === undefined) e.id = this.nextId++;
        this.closureDepth++;
        this.walkFunction(e.params, e.body);
        this.closureDepth--;
        return;
      }
      case "call":
        // The callee may be a function-typed local variable (`const f = …; f(x)`),
        // so resolve it as a name reference too (a top-level function won't bind).
        this.reference(e.callee);
        for (const a of e.args) this.walkExpr(a);
        return;
      case "callValue":
        this.walkExpr(e.callee);
        for (const a of e.args) this.walkExpr(a);
        return;
      case "binary":
        this.walkExpr(e.left);
        this.walkExpr(e.right);
        return;
      case "unary":
        this.walkExpr(e.operand);
        return;
      case "ternary":
        this.walkExpr(e.cond);
        this.walkExpr(e.whenTrue);
        this.walkExpr(e.whenFalse);
        return;
      case "array":
        for (const el of e.elements) this.walkExpr(el);
        return;
      case "object":
        for (const p of e.properties) this.walkExpr(p.value);
        return;
      case "index":
        this.walkExpr(e.arr);
        this.walkExpr(e.index);
        return;
      case "member":
        this.walkExpr(e.obj);
        return;
      case "methodCall":
        this.walkExpr(e.receiver);
        for (const a of e.args) this.walkExpr(a);
        return;
      case "new":
        for (const a of e.args) this.walkExpr(a);
        return;
      case "jsonStringify":
      case "promiseResolve":
      case "promiseAll":
        this.walkExpr(e.arg);
        return;
      case "jsonParse":
        this.walkExpr(e.text);
        return;
      case "mathCall":
        for (const a of e.args) this.walkExpr(a);
        return;
      case "setNew":
        if (e.init) this.walkExpr(e.init);
        return;
      case "await":
        this.walkExpr(e.expr);
        return;
      case "typeof":
        this.walkExpr(e.operand);
        return;
      case "fetch":
        this.walkExpr(e.url);
        return;
      case "responseJson":
        this.walkExpr(e.receiver);
        return;
      // num / bool / str / null / undefined / mathConst / mapNew: no sub-exprs.
    }
  }
}
