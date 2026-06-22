// Stage 1 + 2: parse with the official TypeScript parser, then lower its AST
// into our internal IR. We read type annotations straight off the AST: stage 0
// (src/frontend/check.ts) already ran a real ts.Program + TypeChecker as a gate,
// but lowering does not yet thread the checker's *inferred* types through.
//
// Many `Error` messages here carry a "(v1)" marker — it flags a construct that
// is valid TypeScript but outside this compiler's current subset (so it's a
// clean "not yet supported", not a type error). Stage 0 has already accepted the
// program as type-correct by the time these fire.

import * as ts from "typescript";
import {
  Module,
  Stmt,
  Expr,
  BinaryOp,
  Type,
  Func,
  RetType,
  Param,
  ClassDecl,
  Method,
  SwitchCase,
} from "../ir/nodes";

// Monotonic counter for the synthetic temporaries destructuring / parameter
// patterns introduce (`_tsn_d<n>`). Reset per `lower()` (one file), so names are
// unique within a file; cross-file top-level collisions are mangled by the module
// loader, and inside functions these are ordinary locals (distinct scopes).
let tempCounter = 0;
function freshTemp(): string {
  return `_tsn_d${tempCounter++}`;
}

// Synthetic local name for an anonymous `export default` (an expression, or an
// unnamed `export default function`/`class`). The loader maps the module's
// "default" export to it and mangles it apart on a cross-module collision.
const DEFAULT_EXPORT_NAME = "tsn_default";

export function lower(fileName: string, source: string): Module {
  tempCounter = 0;
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
  );
  const classes: ClassDecl[] = [];
  const functions: Func[] = [];
  const main: Stmt[] = [];
  // The local name of this file's `export default` target, if any (see Module).
  let defaultExport: string | undefined;
  for (const stmt of sf.statements) {
    // `import`/`export` declarations are wired by the module loader
    // (src/frontend/modules.ts): imports drove which files to include, an `export`
    // modifier on a declaration lowers transparently (handled below), and a bare
    // `export {...}` / re-export only affects the loader's symbol table. We skip
    // them here so they don't fall through to the "unsupported" throw.
    if (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) {
      continue;
    }
    // `export default <expr>` — a bare expression (not a declaration). Desugar it
    // to a synthetic module variable; the loader maps the module's "default" export
    // to it. `export = x` (CommonJS) has no module-record analogue → clean error.
    if (ts.isExportAssignment(stmt)) {
      if (stmt.isExportEquals) {
        throw new Error(
          "`export =` (CommonJS export assignment) is not supported — use `export default`",
        );
      }
      main.push({
        kind: "let",
        name: DEFAULT_EXPORT_NAME,
        init: lowerExpr(stmt.expression),
      });
      defaultExport = DEFAULT_EXPORT_NAME;
      continue;
    }
    if (ts.isClassDeclaration(stmt)) {
      const isDefault = hasModifier(stmt, ts.SyntaxKind.DefaultKeyword);
      const cls = lowerClass(stmt, isDefault ? DEFAULT_EXPORT_NAME : undefined);
      classes.push(cls);
      if (isDefault) defaultExport = cls.name;
      continue;
    }
    if (ts.isFunctionDeclaration(stmt)) {
      const isDefault = hasModifier(stmt, ts.SyntaxKind.DefaultKeyword);
      const fn = lowerFunction(stmt, isDefault ? DEFAULT_EXPORT_NAME : undefined);
      functions.push(fn);
      if (isDefault) defaultExport = fn.name;
      continue;
    }
    if (ts.isReturnStatement(stmt)) {
      throw new Error("'return' is only allowed inside a function");
    }
    lowerStatement(stmt, main);
  }
  // A single lowered file has no dependency modules of its own; the module loader
  // (modules.ts) assembles cross-file programs and fills in `modules`.
  return { classes, functions, main, modules: [], defaultExport };
}

// Lower a typed parameter list (function, method, constructor, or closure). Each
// param needs an explicit type annotation. Returns the lowered `Param`s plus a
// `prelude`: the statements a **destructuring** parameter (`({ x }: P)` / `([a]:
// T[])`) desugars to — they bind the pattern off a synthetic parameter and must be
// prepended to the function body by the caller.
function lowerParams(params: ts.NodeArray<ts.ParameterDeclaration>): {
  params: Param[];
  prelude: Stmt[];
} {
  const prelude: Stmt[] = [];
  const out = params.map((p): Param => {
    // A parameter-property (`constructor(private x: number)`) implicitly declares
    // and assigns a field — out of subset; declare the field explicitly instead.
    if (p.modifiers && p.modifiers.length > 0) {
      throw new Error(
        "Constructor parameter properties are not supported (v1) — declare the field explicitly",
      );
    }
    // A **destructuring** parameter (`({ x, y }: P)` / `([a, b]: T[])`). Receive it
    // under a synthetic name with the annotated type, and desugar the pattern into
    // `prelude` `let`s (bound off the synthetic param), prepended to the body. A
    // whole-param default / optional applies to the synthetic param.
    if (!ts.isIdentifier(p.name)) {
      if (p.dotDotDotToken) {
        throw new Error("A rest parameter cannot be destructured (v1)");
      }
      if (!p.type) {
        throw new Error("A destructured parameter needs a type annotation (v1)");
      }
      const type = lowerType(p.type);
      const synth = freshTemp();
      lowerBindingPattern(p.name, { kind: "var", name: synth }, prelude);
      if (p.initializer) {
        return { name: synth, type, default: lowerExpr(p.initializer) };
      }
      return {
        name: synth,
        type: p.questionToken ? canonicalizeUnion([type, "undefined"]) : type,
      };
    }
    // A **rest** parameter `...xs: T[]`. Its annotation is the array type; the
    // body uses it as an ordinary array. Codegen collects the trailing call
    // arguments into a fresh `T[]`. (Stage 0 guarantees a rest param is last and
    // array-typed; we also check so a tuple/non-array annotation errors cleanly.)
    if (p.dotDotDotToken) {
      if (!p.type) {
        throw new Error(`Rest parameter '${p.name.text}' needs a type annotation`);
      }
      const type = lowerType(p.type);
      if (typeof type !== "object" || type.kind !== "array") {
        throw new Error(
          `Rest parameter '${p.name.text}' must have an array type 'T[]' (v1)`,
        );
      }
      return { name: p.name.text, type, rest: true };
    }
    if (!p.type) {
      throw new Error(`Parameter '${p.name.text}' needs a type annotation`);
    }
    // A **default** parameter `a: T = expr`. `type` stays the declared `T` (the
    // type seen in the body); codegen resolves the default at the function's entry
    // (so it may reference earlier params) and treats the param as optional at the
    // boundary. (A `?` on a defaulted param is redundant — TS forbids it.)
    if (p.initializer) {
      return {
        name: p.name.text,
        type: lowerType(p.type),
        default: lowerExpr(p.initializer),
      };
    }
    // An optional parameter `a?: T` is `T | undefined` (callers may omit it; the
    // omitted value is `undefined`). Codegen appends an `undefined` default for an
    // omitted trailing optional arg. (Stage 0 enforces TS's required-before-optional
    // ordering and rejects omitting a non-optional param.)
    let type = lowerType(p.type);
    if (p.questionToken) type = canonicalizeUnion([type, "undefined"]);
    return { name: p.name.text, type };
  });
  return { params: out, prelude };
}

// Whether `node` carries the given modifier keyword.
function hasModifier(node: ts.HasModifiers, kind: ts.SyntaxKind): boolean {
  return ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false;
}

// `static` is the one modifier that changes semantics (no `this`); reject it.
// Access modifiers (public/private/protected/readonly) are accepted and ignored
// — we don't enforce visibility yet, and they don't affect generated code.
function hasStatic(node: ts.HasModifiers): boolean {
  return hasModifier(node, ts.SyntaxKind.StaticKeyword);
}

// The `async` modifier on a function/method. An async function returns a
// `Promise<T>` and compiles to a C++20 coroutine (see codegen); its body may use
// `await`. (Stage 0 already enforces that `await` appears only in async functions
// and that an async function's annotated return type is a `Promise<...>`.)
function hasAsync(node: ts.HasModifiers): boolean {
  return hasModifier(node, ts.SyntaxKind.AsyncKeyword);
}

// `nameOverride` names an anonymous `export default class {}` (the loader maps the
// module's "default" export to this name); a named class ignores it.
function lowerClass(cls: ts.ClassDeclaration, nameOverride?: string): ClassDecl {
  const name = cls.name?.text ?? nameOverride;
  if (name === undefined)
    throw new Error("Class declarations must be named (v1)");
  if (cls.heritageClauses && cls.heritageClauses.length > 0) {
    throw new Error(
      `Class inheritance (extends/implements) is not supported yet (v1)`,
    );
  }

  const fields: ClassDecl["fields"] = [];
  const methods: Method[] = [];
  let ctor: ClassDecl["ctor"] | undefined;

  for (const m of cls.members) {
    if (ts.isPropertyDeclaration(m)) {
      if (!ts.isIdentifier(m.name)) {
        throw new Error("Only simple field names are supported (v1)");
      }
      if (hasStatic(m)) {
        throw new Error(`Static members are not supported yet (v1)`);
      }
      if (m.initializer) {
        throw new Error(
          `Field initializers are not supported yet (v1) — set '${m.name.text}' in the constructor`,
        );
      }
      if (!m.type) {
        throw new Error(`Field '${m.name.text}' needs a type annotation`);
      }
      fields.push({ name: m.name.text, type: lowerType(m.type) });
      continue;
    }
    if (ts.isConstructorDeclaration(m)) {
      if (ctor)
        throw new Error(`Class '${name}' has more than one constructor`);
      if (!m.body) throw new Error(`Constructor of '${name}' must have a body`);
      const { params, prelude } = lowerParams(m.parameters);
      ctor = {
        params,
        body: [...prelude, ...lowerStmts(m.body.statements)],
      };
      continue;
    }
    if (ts.isMethodDeclaration(m)) {
      if (!ts.isIdentifier(m.name)) {
        throw new Error("Only simple method names are supported (v1)");
      }
      if (hasStatic(m)) {
        throw new Error(`Static members are not supported yet (v1)`);
      }
      if (!m.body) throw new Error(`Method '${m.name.text}' must have a body`);
      if (!m.type) {
        throw new Error(
          `Method '${m.name.text}' needs a return type annotation`,
        );
      }
      // An async method's annotated type is a `Promise<...>` (lowered to a
      // promise type by lowerType); `void` only appears on non-async methods.
      const returnType: RetType =
        m.type.kind === ts.SyntaxKind.VoidKeyword ? "void" : lowerType(m.type);
      const { params, prelude } = lowerParams(m.parameters);
      methods.push({
        name: m.name.text,
        params,
        returnType,
        body: [...prelude, ...lowerStmts(m.body.statements)],
        async: hasAsync(m),
      });
      continue;
    }
    if (ts.isGetAccessor(m) || ts.isSetAccessor(m)) {
      throw new Error(`Getters/setters are not supported yet (v1)`);
    }
    throw new Error(`Unsupported class member: ${ts.SyntaxKind[m.kind]}`);
  }

  if (!ctor) {
    throw new Error(
      `Class '${name}' must declare a constructor (v1) — implicit constructors are not supported`,
    );
  }
  return { name, fields, ctor, methods };
}

// `nameOverride` names an anonymous `export default function () {}` (the loader
// maps the module's "default" export to this name); a named function ignores it.
function lowerFunction(fn: ts.FunctionDeclaration, nameOverride?: string): Func {
  const name = fn.name?.text ?? nameOverride;
  if (name === undefined)
    throw new Error("Function declarations must be named (v1)");
  if (!fn.body) throw new Error(`Function '${name}' must have a body`);

  // Params may be any supported type — scalars, arrays, objects, or class
  // instances. A destructuring param contributes desugared `let`s in `prelude`.
  const { params, prelude } = lowerParams(fn.parameters);

  if (!fn.type) {
    throw new Error(`Function '${name}' needs a return type annotation`);
  }
  let returnType: RetType;
  if (fn.type.kind === ts.SyntaxKind.VoidKeyword) {
    returnType = "void";
  } else {
    // Returns may be any supported type now (scalars, arrays, objects). An async
    // function's annotation is a `Promise<...>` — lowerType maps it to a promise
    // type, and the function compiles to a coroutine (see codegen).
    returnType = lowerType(fn.type);
  }

  const body = [...prelude, ...lowerStmts(fn.body.statements)];
  return { name, params, returnType, body, async: hasAsync(fn) };
}

function lowerStatement(node: ts.Statement, out: Stmt[]): void {
  if (ts.isVariableStatement(node)) {
    // Only `let` / `const` — `var` is intentionally unsupported.
    const flags = node.declarationList.flags;
    if (!(flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) {
      throw new Error("'var' is not supported — use 'let' or 'const'");
    }
    for (const decl of node.declarationList.declarations) {
      lowerVarDeclInto(decl, out);
    }
    return;
  }
  if (ts.isReturnStatement(node)) {
    out.push({
      kind: "return",
      value: node.expression ? lowerExpr(node.expression) : undefined,
    });
    return;
  }
  if (ts.isIfStatement(node)) {
    out.push({
      kind: "if",
      cond: lowerExpr(node.expression),
      then: lowerBlock(node.thenStatement),
      else: node.elseStatement ? lowerBlock(node.elseStatement) : undefined,
    });
    return;
  }
  if (ts.isWhileStatement(node)) {
    out.push({
      kind: "while",
      cond: lowerExpr(node.expression),
      body: lowerBlock(node.statement),
    });
    return;
  }
  if (ts.isForStatement(node)) {
    out.push({
      kind: "for",
      init: node.initializer ? lowerForInit(node.initializer) : undefined,
      cond: node.condition ? lowerExpr(node.condition) : undefined,
      update: node.incrementor ? lowerAssignLike(node.incrementor) : undefined,
      body: lowerBlock(node.statement),
    });
    return;
  }
  if (ts.isDoStatement(node)) {
    out.push({
      kind: "doWhile",
      body: lowerBlock(node.statement),
      cond: lowerExpr(node.expression),
    });
    return;
  }
  if (ts.isForOfStatement(node)) {
    if (node.awaitModifier) {
      throw new Error("'for await' is not supported (v1)");
    }
    out.push({
      kind: "forOf",
      name: lowerForBindingName(node.initializer, "of"),
      iterable: lowerExpr(node.expression),
      body: lowerBlock(node.statement),
    });
    return;
  }
  if (ts.isForInStatement(node)) {
    out.push({
      kind: "forIn",
      name: lowerForBindingName(node.initializer, "in"),
      target: lowerExpr(node.expression),
      body: lowerBlock(node.statement),
    });
    return;
  }
  if (ts.isSwitchStatement(node)) {
    out.push({
      kind: "switch",
      disc: lowerExpr(node.expression),
      cases: node.caseBlock.clauses.map((clause): SwitchCase => {
        const body = lowerStmts(clause.statements);
        return ts.isCaseClause(clause)
          ? { test: lowerExpr(clause.expression), body }
          : { body };
      }),
    });
    return;
  }
  if (ts.isBreakStatement(node)) {
    out.push({ kind: "break", label: node.label?.text });
    return;
  }
  if (ts.isContinueStatement(node)) {
    out.push({ kind: "continue", label: node.label?.text });
    return;
  }
  if (ts.isLabeledStatement(node)) {
    out.push(lowerLabeled(node));
    return;
  }
  if (ts.isThrowStatement(node)) {
    out.push({ kind: "throw", value: lowerThrowValue(node.expression) });
    return;
  }
  if (ts.isTryStatement(node)) {
    out.push(lowerTry(node));
    return;
  }
  if (ts.isExpressionStatement(node)) {
    const expr = node.expression;
    if (ts.isCallExpression(expr) && isConsoleLog(expr.expression)) {
      if (expr.arguments.length !== 1) {
        throw new Error("console.log expects exactly one argument (v1)");
      }
      out.push({ kind: "log", arg: lowerExpr(expr.arguments[0]) });
      return;
    }
    if (isAssignmentLike(expr)) {
      out.push(lowerAssignLike(expr));
      return;
    }
    // `await f();` — run for its side effect (and suspension). Kept as an `await`
    // IR node (codegen emits `co_await`), not unwrapped — the suspension matters.
    if (ts.isAwaitExpression(expr)) {
      out.push({ kind: "exprStmt", expr: lowerExpr(expr) });
      return;
    }
    if (ts.isCallExpression(expr)) {
      out.push({ kind: "exprStmt", expr: lowerExpr(expr) });
      return;
    }
  }
  throw new Error(`Unsupported statement: ${ts.SyntaxKind[node.kind]}`);
}

// Maps a compound-assignment token (`+=` etc.) to its arithmetic op, or null.
function compoundOp(kind: ts.SyntaxKind): BinaryOp | null {
  switch (kind) {
    case ts.SyntaxKind.PlusEqualsToken:
      return "+";
    case ts.SyntaxKind.MinusEqualsToken:
      return "-";
    case ts.SyntaxKind.AsteriskEqualsToken:
      return "*";
    case ts.SyntaxKind.SlashEqualsToken:
      return "/";
    case ts.SyntaxKind.PercentEqualsToken:
      return "%";
    default:
      return null;
  }
}

// `x = e`, `x += e`, `x++`/`++x`, `x--`/`--x` — all targeting a simple variable.
function isAssignmentLike(expr: ts.Expression): boolean {
  if (ts.isBinaryExpression(expr)) {
    const k = expr.operatorToken.kind;
    return k === ts.SyntaxKind.EqualsToken || compoundOp(k) !== null;
  }
  if (ts.isPostfixUnaryExpression(expr) || ts.isPrefixUnaryExpression(expr)) {
    return (
      expr.operator === ts.SyntaxKind.PlusPlusToken ||
      expr.operator === ts.SyntaxKind.MinusMinusToken
    );
  }
  return false;
}

// An assignment target (lvalue): a variable, an array element, or an object
// field. Reuses `lowerExpr`, which produces `var` / `index` / `member` nodes.
function lowerAssignTarget(node: ts.Expression): Expr {
  if (
    ts.isIdentifier(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isPropertyAccessExpression(node)
  ) {
    return lowerExpr(node);
  }
  throw new Error(
    "Assignment target must be a variable, array element, or object field",
  );
}

// Lower an assignment-like expression to an `assign` statement, desugaring
// compound assignment and `++`/`--` into `target = target <op> rhs`.
function lowerAssignLike(expr: ts.Expression): Stmt {
  if (ts.isBinaryExpression(expr)) {
    const target = lowerAssignTarget(expr.left);
    if (expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return { kind: "assign", target, value: lowerExpr(expr.right) };
    }
    const op = compoundOp(expr.operatorToken.kind);
    if (op) {
      return {
        kind: "assign",
        target,
        value: {
          kind: "binary",
          op,
          left: target,
          right: lowerExpr(expr.right),
        },
      };
    }
  }
  if (ts.isPostfixUnaryExpression(expr) || ts.isPrefixUnaryExpression(expr)) {
    const target = lowerAssignTarget(expr.operand);
    const op: BinaryOp =
      expr.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-";
    return {
      kind: "assign",
      target,
      value: {
        kind: "binary",
        op,
        left: target,
        right: { kind: "num", value: 1 },
      },
    };
  }
  throw new Error("Unsupported assignment expression");
}

// A `for` initializer: a single `let`/`const` declaration, or an assignment expr.
function lowerForInit(init: ts.ForInitializer): Stmt {
  if (ts.isVariableDeclarationList(init)) {
    if (init.declarations.length !== 1) {
      throw new Error("for-loop init must declare exactly one variable (v1)");
    }
    return lowerVarDecl(init.declarations[0]);
  }
  return lowerAssignLike(init);
}

// The loop variable name of a `for…of` / `for…in`. Requires a single `let`/`const`
// declaration with a simple identifier (no `var`, no destructuring, no assigning
// to a pre-existing variable). Any type annotation is ignored — the element/key
// type is resolved from the iterable during codegen.
function lowerForBindingName(init: ts.ForInitializer, kw: "of" | "in"): string {
  if (!ts.isVariableDeclarationList(init)) {
    throw new Error(
      `for…${kw} requires a 'let'/'const' binding (v1) — e.g. for (const x ${kw} ...)`,
    );
  }
  if (!(init.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) {
    throw new Error("'var' is not supported — use 'let' or 'const'");
  }
  if (init.declarations.length !== 1) {
    throw new Error(`for…${kw} must declare exactly one variable (v1)`);
  }
  const name = init.declarations[0].name;
  if (!ts.isIdentifier(name)) {
    throw new Error("Only simple identifier bindings are supported (v1)");
  }
  return name.text;
}

// `label: <stmt>` — only loops may be labeled in this subset (so a labeled
// `break`/`continue` has a well-defined target). Lower the wrapped statement and
// require it to be exactly one loop.
// The loop statement kinds — the only statements a label may target (so a
// labeled `break`/`continue` has a well-defined loop to jump to).
const LOOP_KINDS: readonly Stmt["kind"][] = [
  "while",
  "doWhile",
  "for",
  "forOf",
  "forIn",
];

function lowerLabeled(node: ts.LabeledStatement): Stmt {
  const inner: Stmt[] = [];
  lowerStatement(node.statement, inner);
  if (inner.length !== 1 || !LOOP_KINDS.includes(inner[0].kind)) {
    throw new Error(
      `Only loops can be labeled (v1) — '${node.label.text}:' must label a for/while/do-while loop`,
    );
  }
  return { kind: "labeled", label: node.label.text, body: inner[0] };
}

// The thrown value. The subset has no Error objects, so `throw new Error(msg)`
// lowers to throwing the message string (and a bare `new Error()` to `""`); any
// other `throw` lowers its operand directly (codegen requires a string).
function lowerThrowValue(expr: ts.Expression): Expr {
  const inner = skipParens(expr);
  if (
    ts.isNewExpression(inner) &&
    ts.isIdentifier(inner.expression) &&
    inner.expression.text === "Error"
  ) {
    const arg = inner.arguments?.[0];
    return arg ? lowerExpr(arg) : { kind: "str", value: "" };
  }
  return lowerExpr(expr);
}

// `try { } catch (e) { } finally { }`. TypeScript guarantees at least one of
// catch/finally is present. The catch binding (if any) must be a simple
// identifier; its value is bound as a `string` during codegen.
function lowerTry(node: ts.TryStatement): Stmt {
  const block = lowerStmts(node.tryBlock.statements);

  let catchName: string | undefined;
  let catchBody: Stmt[] | undefined;
  if (node.catchClause) {
    catchBody = lowerStmts(node.catchClause.block.statements);
    const decl = node.catchClause.variableDeclaration;
    if (decl) {
      if (!ts.isIdentifier(decl.name)) {
        throw new Error("Only simple catch bindings are supported (v1)");
      }
      catchName = decl.name.text;
    }
  }

  const finallyBody = node.finallyBlock
    ? lowerStmts(node.finallyBlock.statements)
    : undefined;

  return { kind: "try", block, catchName, catchBody, finallyBody };
}

// Lower a sequence of statements into a fresh IR statement array. Used wherever
// a body's statements (a function/method/loop body, a switch clause, a try block)
// lower as a group.
function lowerStmts(statements: readonly ts.Statement[]): Stmt[] {
  const out: Stmt[] = [];
  for (const s of statements) lowerStatement(s, out);
  return out;
}

// A block (`{ ... }`) or a single bare statement (`if (c) stmt;`) -> Stmt[].
function lowerBlock(node: ts.Statement): Stmt[] {
  if (ts.isBlock(node)) return lowerStmts(node.statements);
  const out: Stmt[] = [];
  lowerStatement(node, out);
  return out;
}

// Lower one `let`/`const` declarator into `out`. A simple identifier binding goes
// through `lowerVarDecl` (one `let` stmt, plus the JSON/Map/Set annotated-target
// idioms). A **destructuring** binding (`const [a, b] = …` / `const { x } = …`) is
// *desugared* here into the source temp + per-binding `let`s — so the rest of the
// pipeline only ever sees simple bindings.
function lowerVarDeclInto(decl: ts.VariableDeclaration, out: Stmt[]): void {
  if (ts.isIdentifier(decl.name)) {
    out.push(lowerVarDecl(decl));
    return;
  }
  if (!decl.initializer) {
    throw new Error("A destructuring binding must have an initializer (v1)");
  }
  // Evaluate the initializer once (into a temp unless it's already a variable),
  // then bind each element/property from that stable source.
  const src = stableSource(lowerExpr(decl.initializer), out);
  lowerBindingPattern(decl.name, src, out);
}

// Bind `source` (already a value Expr) according to a binding name: a plain
// identifier becomes `let <name> = source`; an array/object pattern is destructured
// element-by-element. The source is stabilized (bound to a temp unless it is a
// variable) before a pattern reads it repeatedly, so it is evaluated exactly once.
function lowerBindingPattern(
  name: ts.BindingName,
  source: Expr,
  out: Stmt[],
): void {
  if (ts.isIdentifier(name)) {
    out.push({ kind: "let", name: name.text, init: source });
    return;
  }
  const src = stableSource(source, out);
  if (ts.isArrayBindingPattern(name)) lowerArrayPattern(name, src, out);
  else lowerObjectPattern(name, src, out);
}

// Ensure `source` can be referenced repeatedly without re-evaluating it: a `var`
// is already stable; anything else is bound to a fresh temp `let` whose `var` ref
// is returned. (So `const [a, b] = f()` calls `f()` once.)
function stableSource(source: Expr, out: Stmt[]): Expr {
  if (source.kind === "var") return source;
  const t = freshTemp();
  out.push({ kind: "let", name: t, init: source });
  return { kind: "var", name: t };
}

// `const [a, , b, ...rest] = src` — index each element off `src`, skipping holes.
// An element default (`[a = 5]`) is taken only when the index is out of bounds
// (`i < src.length ? src[i] : default`), matching JS (which yields `undefined` for
// a missing element). A rest element (`...rest`) takes `src.slice(i)` — a new array.
function lowerArrayPattern(
  pattern: ts.ArrayBindingPattern,
  src: Expr,
  out: Stmt[],
): void {
  pattern.elements.forEach((el, i) => {
    if (ts.isOmittedExpression(el)) return; // a hole: `[, x]`
    if (el.dotDotDotToken) {
      if (el.initializer) {
        throw new Error("A rest element cannot have a default value");
      }
      const rest: Expr = {
        kind: "methodCall",
        receiver: src,
        method: "slice",
        args: [{ kind: "num", value: i }],
      };
      lowerBindingPattern(el.name, rest, out);
      return;
    }
    let value: Expr = { kind: "index", arr: src, index: { kind: "num", value: i } };
    if (el.initializer) {
      // `i < src.length ? src[i] : <default>` — the default fills an out-of-bounds
      // (absent) element. (The subset's arrays are dense and typed, so this is the
      // only way an element is "missing"; an explicit `undefined` element would
      // need a `T | undefined` element type, which is itself deferred.)
      value = {
        kind: "ternary",
        cond: {
          kind: "binary",
          op: "<",
          left: { kind: "num", value: i },
          right: { kind: "member", obj: src, name: "length" },
        },
        whenTrue: value,
        whenFalse: lowerExpr(el.initializer),
      };
    }
    lowerBindingPattern(el.name, value, out);
  });
}

// `const { x, y: alias, z: { … }, ...rest } = src` — bind each property off `src`.
// A renamed (`y: alias`) or nested (`z: { … }`) property uses `propertyName` as the
// source field; a shorthand (`x`) uses the binding name. A property default is
// ignored: object fields in the subset are always present and non-optional, so the
// default can never fire (an optional `{ x?: T }` field is itself deferred). Object
// rest (`...rest`) needs building a residual object and is deferred (clean error).
function lowerObjectPattern(
  pattern: ts.ObjectBindingPattern,
  src: Expr,
  out: Stmt[],
): void {
  for (const el of pattern.elements) {
    if (el.dotDotDotToken) {
      throw new Error(
        "Object rest in destructuring ('{ ...rest }') is not supported yet (v1)",
      );
    }
    const fieldNode = el.propertyName ?? el.name;
    if (!ts.isIdentifier(fieldNode)) {
      throw new Error(
        "Only identifier property names are supported in object destructuring (v1)",
      );
    }
    const value: Expr = { kind: "member", obj: src, name: fieldNode.text };
    lowerBindingPattern(el.name, value, out);
  }
}

function lowerVarDecl(decl: ts.VariableDeclaration): Stmt {
  if (!ts.isIdentifier(decl.name)) {
    throw new Error("Only simple identifier bindings are supported (v1)");
  }
  // No annotation -> leave type undefined; codegen infers it from the initializer.
  const type = decl.type ? lowerType(decl.type) : undefined;
  if (!decl.initializer) {
    // `let x: T;` — a declaration with no initializer. The annotation is the only
    // source of a type here (no `any`, nothing to infer from), so it's required.
    // (`const x;` is already a TS stage-0 error, so it never reaches lowering.)
    if (type === undefined) {
      throw new Error(
        `'${decl.name.text}' needs a type annotation when declared without an initializer`,
      );
    }
    return { kind: "let", name: decl.name.text, type };
  }
  // `const x: T = JSON.parse(text)` — the variable annotation supplies the parse
  // target type (the common idiom alongside `JSON.parse(text) as T`).
  const initNode = skipParens(decl.initializer);
  if (type !== undefined && isJsonParseCall(initNode)) {
    return {
      kind: "let",
      name: decl.name.text,
      type,
      init: jsonParseNode(initNode, type),
    };
  }
  // `const x: T = await res.json()` — the annotation supplies the JSON target type
  // (the typed-target idiom alongside `await res.json() as T`).
  if (type !== undefined) {
    const jsonCall = responseJsonCall(decl.initializer);
    if (jsonCall) {
      return {
        kind: "let",
        name: decl.name.text,
        type,
        init: responseJsonAwaitNode(jsonCall, type),
      };
    }
  }
  // `const m: Map<K, V> = new Map()` / `const s: Set<T> = new Set(arr)` — the
  // annotation supplies the element types when `new Map()`/`new Set()` is written
  // without type arguments (TypeScript would infer them from the annotation).
  if (
    type !== undefined &&
    typeof type === "object" &&
    (type.kind === "map" || type.kind === "set") &&
    ts.isNewExpression(initNode) &&
    ts.isIdentifier(initNode.expression) &&
    !initNode.typeArguments
  ) {
    const ctor = initNode.expression.text;
    if (ctor === "Map" && type.kind === "map") {
      if (initNode.arguments && initNode.arguments.length > 0) {
        throw new Error(
          "new Map(entries) is not supported (v1) — construct `new Map()` and .set() entries",
        );
      }
      return {
        kind: "let",
        name: decl.name.text,
        type,
        init: { kind: "mapNew", key: type.key, value: type.value },
      };
    }
    if (ctor === "Set" && type.kind === "set") {
      return {
        kind: "let",
        name: decl.name.text,
        type,
        init: setNewNode(type.element, initNode.arguments),
      };
    }
  }
  return {
    kind: "let",
    name: decl.name.text,
    type,
    init: lowerExpr(decl.initializer),
  };
}

function lowerType(node: ts.TypeNode): Type {
  if (node.kind === ts.SyntaxKind.NumberKeyword) return "number";
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return "boolean";
  if (node.kind === ts.SyntaxKind.StringKeyword) return "string";
  // `null` / `undefined` type keywords (also reachable as union members and the
  // optional `?:` desugar). `undefined` is a `LiteralType` wrapping the keyword.
  if (node.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) return "undefined";
  if (
    ts.isLiteralTypeNode(node) &&
    node.literal.kind === ts.SyntaxKind.NullKeyword
  ) {
    return "null";
  }
  // `A | B | …` — a union. Lower each member, then canonicalize (flatten nested
  // unions, dedupe, collapse a singleton, reject empty, sort into a stable order)
  // so `number | string` and `string | number` produce the *same* IR type.
  if (ts.isUnionTypeNode(node)) {
    return canonicalizeUnion(node.types.map(lowerType));
  }
  // `(T)` — a parenthesized type (e.g. around a function type in `(() => R)[]`).
  if (ts.isParenthesizedTypeNode(node)) return lowerType(node.type);
  // `(a: T, b: U) => R` — a function type. Parameter names are irrelevant to the
  // type; an optional param `(a?: T)` widens to `T | undefined` (like a value param).
  if (ts.isFunctionTypeNode(node)) {
    let restParam = false;
    const params = node.parameters.map((p, i) => {
      if (!p.type) {
        throw new Error("Function type parameters need a type annotation");
      }
      let t = lowerType(p.type);
      // `(...xs: T[]) => R` — a rest parameter (the last one). Its type entry is
      // the array `T[]`; `restParam` marks it so a call collects trailing args.
      if (p.dotDotDotToken) {
        if (typeof t !== "object" || t.kind !== "array") {
          throw new Error("A rest parameter in a function type must be 'T[]' (v1)");
        }
        if (i !== node.parameters.length - 1) {
          throw new Error("A rest parameter must be last in a function type");
        }
        restParam = true;
        return t;
      }
      if (p.questionToken) t = canonicalizeUnion([t, "undefined"]);
      return t;
    });
    const ret: RetType =
      node.type.kind === ts.SyntaxKind.VoidKeyword
        ? "void"
        : lowerType(node.type);
    return restParam
      ? { kind: "function", params, ret, restParam: true }
      : { kind: "function", params, ret };
  }
  // `T[]`
  if (ts.isArrayTypeNode(node)) {
    return { kind: "array", element: lowerType(node.elementType) };
  }
  // `{ a: T; b: U }` — an object type literal.
  if (ts.isTypeLiteralNode(node)) return lowerObjectType(node);
  // A named type: a primitive/boxed wrapper, a built-in generic (Array/Map/Set/
  // Promise), `Response`, or a class instance. Returns undefined if it's a named
  // type we don't lower (e.g. a user generic with type args) — fall through.
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const t = lowerTypeReference(node, node.typeName.text);
    if (t !== undefined) return t;
  }
  // `ns.Cls` — a namespace-qualified type name (`import * as ns`). Encode it as a
  // class type whose name carries the `ns.` qualifier; the loader's renamer
  // resolves it to the real class. Only a single `ns.Cls` level is supported.
  if (
    ts.isTypeReferenceNode(node) &&
    ts.isQualifiedName(node.typeName) &&
    ts.isIdentifier(node.typeName.left) &&
    !node.typeArguments
  ) {
    return {
      kind: "class",
      name: `${node.typeName.left.text}.${node.typeName.right.text}`,
    };
  }
  throw new Error(`Unsupported type annotation: ${ts.SyntaxKind[node.kind]}`);
}

// `{ a: T; b: U }` — fields may be any supported type, including arrays and nested
// objects (`{ pts: number[] }`, `{ inner: { x: number } }`). `lowerType` recurses,
// so the nesting is captured structurally; codegen maps each field to its C++ type
// (a `std::vector<...>` member or a nested struct).
function lowerObjectType(node: ts.TypeLiteralNode): Type {
  const fields = node.members.map((m) => {
    if (
      !ts.isPropertySignature(m) ||
      !m.name ||
      !ts.isIdentifier(m.name) ||
      !m.type
    ) {
      throw new Error("Unsupported object type member (v1)");
    }
    // An optional field `x?: T` would be `T | undefined`, but constructing it
    // needs object-literal field-defaulting and nested union coercion (a value
    // widens only at the top level today) — deferred. Reject it cleanly rather
    // than silently dropping the `?` (which would treat the field as required).
    if (m.questionToken) {
      throw new Error(
        `Optional object field '${m.name.text}?' is not supported (v1) — use '${m.name.text}: T | undefined' with an explicit value`,
      );
    }
    return { name: m.name.text, type: lowerType(m.type) };
  });
  return { kind: "object", fields };
}

// A named type reference `n<...>`. Handles the primitives/boxed wrappers, the
// built-in generics (`Array`/`Map`/`Set`/`Promise`), `Response`, and a bare
// identifier as a class instance. Returns `undefined` for a named type the subset
// doesn't lower (so the caller falls through to its "Unsupported type" error).
function lowerTypeReference(
  node: ts.TypeReferenceNode,
  n: string,
): Type | undefined {
  // In our `tsn` dialect, the boxed wrappers `Number`/`Boolean`/`String` are
  // treated as their primitives — we only have one of each.
  if (n === "Number" || n === "number") return "number";
  if (n === "Boolean" || n === "boolean") return "boolean";
  if (n === "String" || n === "string") return "string";
  // `Array<T>`
  if (n === "Array" && node.typeArguments?.length === 1) {
    return { kind: "array", element: lowerType(node.typeArguments[0]) };
  }
  // `Map<K, V>` / `Set<T>` — reference-typed containers (see codegen).
  if (n === "Map" && node.typeArguments?.length === 2) {
    return {
      kind: "map",
      key: lowerType(node.typeArguments[0]),
      value: lowerType(node.typeArguments[1]),
    };
  }
  if (n === "Set" && node.typeArguments?.length === 1) {
    return { kind: "set", element: lowerType(node.typeArguments[0]) };
  }
  // `Promise<T>` — the result type of an async function and a first-class value.
  // `Promise<void>` lowers to a promise with no resolved value (resolves to JS
  // `undefined`). `await` on a promise yields `T` (see codegen).
  if (n === "Promise" && node.typeArguments?.length === 1) {
    const arg = node.typeArguments[0];
    if (arg.kind === ts.SyntaxKind.VoidKeyword) return { kind: "promise" };
    return { kind: "promise", value: lowerType(arg) };
  }
  // `Response` — the built-in result of `fetch(...)` (see codegen). A bare
  // identifier, so it's matched here before the class-instance fallthrough.
  if (n === "Response" && !node.typeArguments) {
    return { kind: "response" };
  }
  // A bare identifier that isn't a known primitive/built-in is treated as a class
  // instance type (`let p: Point`). The emitter validates the class exists.
  // Generic refs (with type arguments) return undefined → "Unsupported type", so
  // e.g. a user `Box<T>` keeps its clear error.
  if (!node.typeArguments) {
    return { kind: "class", name: n };
  }
  return undefined;
}

// A stable structural key for a type — used to dedupe and order union members.
// Order-independent for objects/unions (fields/members sorted), so structurally
// equal types share a key regardless of source order.
function typeKey(t: Type): string {
  if (typeof t === "string") return t;
  switch (t.kind) {
    case "array":
      return `array<${typeKey(t.element)}>`;
    case "set":
      return `set<${typeKey(t.element)}>`;
    case "map":
      return `map<${typeKey(t.key)},${typeKey(t.value)}>`;
    case "object":
      return `object{${t.fields
        .map((f) => `${f.name}:${typeKey(f.type)}`)
        .sort()
        .join(";")}}`;
    case "class":
      return `class:${t.name}`;
    case "promise":
      return `promise<${t.value ? typeKey(t.value) : "void"}>`;
    case "response":
      return "response";
    case "union":
      return `union<${t.members.map(typeKey).sort().join("|")}>`;
    case "function":
      return `fn(${t.params.map(typeKey).join(",")})=>${t.ret === "void" ? "void" : typeKey(t.ret)}`;
  }
}

// Ordinal that sorts scalars (with `undefined`/`null` FIRST) ahead of composite
// kinds. Putting `undefined` (else `null`) at member 0 makes a union's default
// (e.g. a `Map.get` miss with a `T | undefined` value) the JS-correct value.
function typeKindOrdinal(t: Type): number {
  if (t === "undefined") return 0;
  if (t === "null") return 1;
  if (t === "boolean") return 2;
  if (t === "number") return 3;
  if (t === "string") return 4;
  const order: Record<string, number> = {
    array: 5,
    object: 6,
    class: 7,
    map: 8,
    set: 9,
    promise: 10,
    response: 11,
    union: 12,
  };
  return order[t.kind] ?? 99;
}

// Lexicographic 3-way string comparison (by UTF-16 code unit) for `Array.sort`
// comparators — deliberately `<`/`>`, not `localeCompare`, so the ordering is the
// stable byte order the rest of the pipeline assumes.
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Canonicalize a union's members: flatten nested unions, dedupe (structurally),
// collapse a single-member union to that member, reject empty, and sort into a
// stable order (scalars first, `undefined`/`null` at the front). Codegen re-sorts
// the C++ type text by the post-rename C++ type, so two equal unions always emit
// identical `tsn_union<…>` text regardless of class-name mangling.
function canonicalizeUnion(rawMembers: Type[]): Type {
  const flat: Type[] = [];
  const seen = new Set<string>();
  const add = (m: Type) => {
    if (typeof m === "object" && m.kind === "union") {
      m.members.forEach(add);
      return;
    }
    const k = typeKey(m);
    if (!seen.has(k)) {
      seen.add(k);
      flat.push(m);
    }
  };
  rawMembers.forEach(add);
  if (flat.length === 0) throw new Error("Empty union type");
  flat.sort((a, b) => {
    const d = typeKindOrdinal(a) - typeKindOrdinal(b);
    if (d !== 0) return d;
    return byteCompare(typeKey(a), typeKey(b));
  });
  return flat.length === 1 ? flat[0] : { kind: "union", members: flat };
}

function lowerExpr(node: ts.Expression): Expr {
  if (ts.isNumericLiteral(node)) {
    return { kind: "num", value: Number(node.text) };
  }
  // `node.text` is the decoded string value (escapes already resolved by TS).
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { kind: "str", value: node.text };
  }
  // `` `head${e0}mid${e1}tail` `` desugars to string concatenation:
  // head + e0 + mid + e1 + tail. The head (a `str`, possibly empty) anchors the
  // whole chain to `string`, so each interpolated value coerces through the
  // existing `+`-concatenation path (string/number operands; anything else is a
  // clean "Cannot concatenate" error, exactly as for `+`). Empty middle/tail
  // quasis are dropped — the head alone keeps the result string-typed — so the
  // emitted C++ stays free of redundant `+ ""`.
  if (ts.isTemplateExpression(node)) {
    let expr: Expr = { kind: "str", value: node.head.text };
    for (const span of node.templateSpans) {
      expr = {
        kind: "binary",
        op: "+",
        left: expr,
        right: lowerExpr(span.expression),
      };
      if (span.literal.text !== "") {
        expr = {
          kind: "binary",
          op: "+",
          left: expr,
          right: { kind: "str", value: span.literal.text },
        };
      }
    }
    return expr;
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword)
    return { kind: "bool", value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword)
    return { kind: "bool", value: false };
  // `null` literal and the `undefined` identifier — value types `null`/`undefined`,
  // used mostly as union members (`T | null`) and the optional `?:` desugar.
  if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: "null" };
  if (node.kind === ts.SyntaxKind.ThisKeyword) return { kind: "this" };
  if (ts.isIdentifier(node)) {
    if (node.text === "undefined") return { kind: "undefined" };
    return { kind: "var", name: node.text };
  }
  // `typeof e` — a `string` ("number"/"string"/"boolean"/"object"/"undefined").
  // For a union operand codegen resolves it at runtime; as `typeof x === "…"` in a
  // guard it also drives flow narrowing (see codegen).
  if (ts.isTypeOfExpression(node)) {
    return { kind: "typeof", operand: lowerExpr(node.expression) };
  }
  // Arrow functions and (anonymous) function expressions become closures.
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return lowerClosure(node);
  }
  if (ts.isNewExpression(node)) return lowerNew(node);
  // `await e` — suspend the enclosing async function until `e`'s promise settles
  // and yield its resolved value. Lowered to an `await` IR node (codegen emits
  // `co_await`); codegen enforces it appears only inside an async function.
  if (ts.isAwaitExpression(node)) {
    return { kind: "await", expr: lowerExpr(node.expression) };
  }
  if (ts.isParenthesizedExpression(node)) return lowerExpr(node.expression);
  // `e!` (non-null assertion) only narrows the *static* type (drops null/undefined)
  // — no runtime effect — so it lowers transparently. This is what lets the common
  // `map.get(k)!` idiom type-check (Map.get is `V | undefined`) and still lower.
  if (ts.isNonNullExpression(node)) return lowerExpr(node.expression);
  if (ts.isAsExpression(node)) return lowerAsExpr(node);
  if (ts.isArrayLiteralExpression(node)) {
    return {
      kind: "array",
      elements: node.elements.map((el) => {
        // `[...arr]` — a spread element splices `arr`'s items into the literal.
        if (ts.isSpreadElement(el)) {
          return { kind: "spread", arg: lowerExpr(el.expression) };
        }
        // `[, x]` — an array hole. Holes only make sense in *destructuring*
        // patterns (handled in lowerVarDecl); in a value literal they'd be the
        // `undefined` element type, which the subset can't represent.
        if (ts.isOmittedExpression(el)) {
          throw new Error("Array holes ('[ , x ]') are not supported in a value (v1)");
        }
        return lowerExpr(el);
      }),
    };
  }
  if (ts.isObjectLiteralExpression(node)) {
    return {
      kind: "object",
      properties: node.properties.map((p) => {
        if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) {
          throw new Error(
            "Only simple { name: value } object properties are supported (v1)",
          );
        }
        return { name: p.name.text, value: lowerExpr(p.initializer) };
      }),
    };
  }
  if (ts.isElementAccessExpression(node)) {
    return {
      kind: "index",
      arr: lowerExpr(node.expression),
      index: lowerExpr(node.argumentExpression),
    };
  }
  // Both `obj.field` and `arr.length`; resolved by type during codegen.
  if (ts.isPropertyAccessExpression(node)) {
    // `Math.PI` / `Math.E` / … are builtin constants, not member access on a
    // value (`Math` is not a runtime object in the subset). A `Math.<fn>` not in
    // call position would be a bare function reference (no first-class functions).
    if (ts.isIdentifier(node.expression) && node.expression.text === "Math") {
      return lowerMathConst(node.name.text);
    }
    return {
      kind: "member",
      obj: lowerExpr(node.expression),
      name: node.name.text,
    };
  }
  if (ts.isCallExpression(node)) return lowerCall(node);
  // Prefix `!e`, `-e`, `+e`. (`++`/`--` are handled as assignments, not here.)
  if (ts.isPrefixUnaryExpression(node)) {
    if (node.operator === ts.SyntaxKind.ExclamationToken) {
      return { kind: "unary", op: "!", operand: lowerExpr(node.operand) };
    }
    if (node.operator === ts.SyntaxKind.MinusToken) {
      return { kind: "unary", op: "-", operand: lowerExpr(node.operand) };
    }
    if (node.operator === ts.SyntaxKind.PlusToken) {
      return { kind: "unary", op: "+", operand: lowerExpr(node.operand) };
    }
  }
  if (ts.isBinaryExpression(node)) {
    return {
      kind: "binary",
      op: lowerBinaryOp(node.operatorToken.kind),
      left: lowerExpr(node.left),
      right: lowerExpr(node.right),
    };
  }
  if (ts.isConditionalExpression(node)) {
    return {
      kind: "ternary",
      cond: lowerExpr(node.condition),
      whenTrue: lowerExpr(node.whenTrue),
      whenFalse: lowerExpr(node.whenFalse),
    };
  }
  throw new Error(`Unsupported expression: ${ts.SyntaxKind[node.kind]}`);
}

// `new C(args)` — also intercepts the `new Map`/`new Set` builtins (reference
// containers, not class instances) and rejects `new Promise(executor)` (closures).
function lowerNew(node: ts.NewExpression): Expr {
  // `new ns.Cls(args)` — a namespace-qualified constructor (`import * as ns`). The
  // class name carries the `ns.` qualifier; the loader's renamer resolves it to the
  // real (possibly mangled) class. Only a single `ns.Cls` level is supported.
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression)
  ) {
    return {
      kind: "new",
      className: `${node.expression.expression.text}.${node.expression.name.text}`,
      args: node.arguments ? lowerArgs(node.arguments) : [],
    };
  }
  if (!ts.isIdentifier(node.expression)) {
    throw new Error("'new' requires a class name (v1)");
  }
  const ctor = node.expression.text;
  if (ctor === "Map") return lowerNewMap(node);
  if (ctor === "Set") return lowerNewSet(node);
  // `new Promise(executor)` needs a first-class function (the executor) and
  // capture machinery — out of subset. Async functions / Promise.resolve cover
  // the common cases without it.
  if (ctor === "Promise") {
    throw new Error(
      "new Promise(executor) is not supported (v1) — it needs first-class function values (closures); use an async function or Promise.resolve",
    );
  }
  return {
    kind: "new",
    className: ctor,
    args: node.arguments ? lowerArgs(node.arguments) : [],
  };
}

// `e as T` — supported as the type carrier for `JSON.parse(text) as T` and
// `await res.json() as T` (both produce an `any`, so the assertion supplies the
// value's static type). A general type assertion has no representation in the
// typed subset.
function lowerAsExpr(node: ts.AsExpression): Expr {
  const inner = skipParens(node.expression);
  if (isJsonParseCall(inner)) {
    return jsonParseNode(inner, lowerType(node.type));
  }
  const jsonCall = responseJsonCall(node.expression);
  if (jsonCall) {
    return responseJsonAwaitNode(jsonCall, lowerType(node.type));
  }
  throw new Error(
    "Type assertions ('as T') are only supported on JSON.parse(...) and `await res.json()` (v1)",
  );
}

// Lower a call/new argument list, turning a `...arg` spread element into a
// `spread` IR node (valid only when it targets a rest parameter — codegen checks).
function lowerArgs(args: ts.NodeArray<ts.Expression>): Expr[] {
  return args.map((a) =>
    ts.isSpreadElement(a)
      ? { kind: "spread", arg: lowerExpr(a.expression) }
      : lowerExpr(a),
  );
}

// A call expression. The namespaced/global builtins (`JSON.*`, `Math.*`,
// `Promise.*`, `fetch`) are intercepted before the generic `recv.method(args)`
// method-call and `f(args)` named-call paths.
function lowerCall(node: ts.CallExpression): Expr {
  const json = tryLowerJsonCall(node);
  if (json) return json;
  const math = tryLowerMathCall(node);
  if (math) return math;
  const promise = tryLowerPromiseCall(node);
  if (promise) return promise;
  const fetched = tryLowerFetchCall(node);
  if (fetched) return fetched;
  // `recv.method(args)` -> methodCall (e.g. xs.push(v)). Codegen disambiguates a
  // genuine method from a call of a function-valued field (`obj.fn(args)`).
  if (ts.isPropertyAccessExpression(node.expression)) {
    return {
      kind: "methodCall",
      receiver: lowerExpr(node.expression.expression),
      method: node.expression.name.text,
      args: lowerArgs(node.arguments),
    };
  }
  // `f(args)` where `f` is a bare identifier — a direct named call (codegen resolves
  // it to a top-level function or a function-typed variable).
  if (ts.isIdentifier(node.expression)) {
    return {
      kind: "call",
      callee: node.expression.text,
      args: lowerArgs(node.arguments),
    };
  }
  // `expr(args)` where `expr` is any other expression (a call result `getFn()(x)`,
  // an indexed element `fns[0](x)`, an IIFE, …) — call a function *value*.
  return {
    kind: "callValue",
    callee: lowerExpr(node.expression),
    args: lowerArgs(node.arguments),
  };
}

// Lower an arrow function or function expression to a `closure` IR node. Parameters
// need type annotations (lowering doesn't thread the checker's contextual types);
// the return type is taken from an explicit annotation, else inferred at codegen.
// An expression-bodied arrow `(x) => e` lowers its body to a single `return e`.
function lowerClosure(
  node: ts.ArrowFunction | ts.FunctionExpression,
): Expr {
  if (hasAsync(node)) {
    throw new Error(
      "async arrow functions / function expressions are not supported yet (v1)",
    );
  }
  if (ts.isFunctionExpression(node) && node.asteriskToken) {
    throw new Error("Generator functions are not supported (v1)");
  }
  const { params, prelude } = lowerParams(node.parameters);
  let returnType: RetType | undefined;
  if (node.type) {
    returnType =
      node.type.kind === ts.SyntaxKind.VoidKeyword
        ? "void"
        : lowerType(node.type);
  }
  let body: Stmt[];
  if (ts.isBlock(node.body)) {
    body = [...prelude, ...lowerStmts(node.body.statements)];
  } else {
    // Expression-bodied arrow: the body expression is the (single) return value
    // (any destructuring-param prelude runs first).
    body = [...prelude, { kind: "return", value: lowerExpr(node.body) }];
  }
  return { kind: "closure", params, returnType, body, async: false };
}

function lowerBinaryOp(kind: ts.SyntaxKind): BinaryOp {
  switch (kind) {
    case ts.SyntaxKind.PlusToken:
      return "+";
    case ts.SyntaxKind.MinusToken:
      return "-";
    case ts.SyntaxKind.AsteriskToken:
      return "*";
    case ts.SyntaxKind.SlashToken:
      return "/";
    case ts.SyntaxKind.PercentToken:
      return "%";
    case ts.SyntaxKind.LessThanToken:
      return "<";
    case ts.SyntaxKind.LessThanEqualsToken:
      return "<=";
    case ts.SyntaxKind.GreaterThanToken:
      return ">";
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return ">=";
    // Loose `==`/`!=` are treated as strict in our dialect.
    case ts.SyntaxKind.EqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
      return "===";
    case ts.SyntaxKind.ExclamationEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      return "!==";
    case ts.SyntaxKind.AmpersandAmpersandToken:
      return "&&";
    case ts.SyntaxKind.BarBarToken:
      return "||";
    default:
      throw new Error(`Unsupported binary operator: ${ts.SyntaxKind[kind]}`);
  }
}

function isConsoleLog(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "console" &&
    expr.name.text === "log"
  );
}

// Strip enclosing parentheses so a call wrapped like `(JSON.parse(x))` is still
// recognized. (lowerExpr already unwraps parens for emission; this is just for
// the structural `isJsonParseCall` check before lowering.)
function skipParens(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

// Is this call `JSON.<method>(...)`? Returns the method name, or null otherwise.
function jsonMethod(node: ts.CallExpression): string | null {
  const callee = node.expression;
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "JSON"
  ) {
    return callee.name.text;
  }
  return null;
}

function isJsonParseCall(node: ts.Expression): node is ts.CallExpression {
  return ts.isCallExpression(node) && jsonMethod(node) === "parse";
}

// Build a `jsonParse` IR node from a `JSON.parse(text)` call and its target type.
function jsonParseNode(call: ts.CallExpression, type: Type): Expr {
  if (call.arguments.length !== 1) {
    throw new Error("JSON.parse expects exactly one argument (v1)");
  }
  return { kind: "jsonParse", text: lowerExpr(call.arguments[0]), type };
}

// Recognize the `JSON.*` builtins in call position. `JSON.stringify(x)` lowers
// directly; `JSON.parse(x)` only lowers with a target type (from `as T` or a
// variable annotation, handled by the AsExpression branch / lowerVarDecl), so a
// bare `JSON.parse(x)` reaching here is a clear error. Returns null for a non-JSON
// call (it falls through to the normal method/function-call lowering).
function tryLowerJsonCall(node: ts.CallExpression): Expr | null {
  const method = jsonMethod(node);
  if (method === null) return null;
  if (method === "stringify") {
    if (node.arguments.length !== 1) {
      throw new Error("JSON.stringify expects exactly one argument (v1)");
    }
    return { kind: "jsonStringify", arg: lowerExpr(node.arguments[0]) };
  }
  if (method === "parse") {
    throw new Error(
      "JSON.parse needs a target type — write `JSON.parse(text) as T` or annotate the target (`const x: T = JSON.parse(text)`)",
    );
  }
  throw new Error(`Unsupported JSON method 'JSON.${method}' (v1)`);
}

// The `Math.<fn>(...)` functions the subset supports (all `number -> number`).
// Most map straight to <cmath>; the JS-divergent ones (round, sign, min/max, …)
// use a small `tsn_math_*` helper in the runtime (see emit.ts / tsn_runtime.h).
const MATH_FUNCTIONS = new Set([
  // unary
  "abs",
  "floor",
  "ceil",
  "round",
  "trunc",
  "sign",
  "sqrt",
  "cbrt",
  "exp",
  "log",
  "log2",
  "log10",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "sinh",
  "cosh",
  "tanh",
  // binary
  "pow",
  "atan2",
  // variadic
  "min",
  "max",
  "hypot",
  // no args
  "random",
]);

// The `Math.<name>` constants the subset supports (all `number`).
const MATH_CONSTANTS = new Set([
  "PI",
  "E",
  "LN2",
  "LN10",
  "LOG2E",
  "LOG10E",
  "SQRT2",
  "SQRT1_2",
]);

// Recognize a `Math.<fn>(...)` builtin call. Returns a `mathCall` node, or null
// for a non-Math call (it falls through to the normal method/function lowering).
// An unknown `Math.<fn>` is a clear error (rather than a member/method miscompile).
function tryLowerMathCall(node: ts.CallExpression): Expr | null {
  const callee = node.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Math"
  ) {
    return null;
  }
  const fn = callee.name.text;
  if (!MATH_FUNCTIONS.has(fn)) {
    throw new Error(`Unsupported Math function 'Math.${fn}' (v1)`);
  }
  return { kind: "mathCall", fn, args: node.arguments.map(lowerExpr) };
}

// Recognize the `Promise.*` static builtins in call position (like `JSON.*` /
// `Math.*`). `Promise.resolve(x)` and `Promise.all(arr)` are supported; the rest
// (reject/race/any/allSettled — and `new Promise`) are clean errors. Returns null
// for a non-Promise call (it falls through to the normal method/function path).
function tryLowerPromiseCall(node: ts.CallExpression): Expr | null {
  const callee = node.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Promise"
  ) {
    return null;
  }
  const method = callee.name.text;
  if (method === "resolve") {
    if (node.arguments.length !== 1) {
      throw new Error(
        "Promise.resolve expects exactly one argument (v1) — Promise.resolve() with no value is out of subset",
      );
    }
    return { kind: "promiseResolve", arg: lowerExpr(node.arguments[0]) };
  }
  if (method === "all") {
    if (node.arguments.length !== 1) {
      throw new Error(
        "Promise.all expects exactly one argument (an array of promises) (v1)",
      );
    }
    return { kind: "promiseAll", arg: lowerExpr(node.arguments[0]) };
  }
  if (method === "reject") {
    throw new Error(
      "Promise.reject is not supported (v1) — `throw` inside an async function to reject its promise",
    );
  }
  if (method === "race" || method === "any" || method === "allSettled") {
    throw new Error(`Promise.${method} is not supported (v1)`);
  }
  throw new Error(`Unsupported Promise method 'Promise.${method}' (v1)`);
}

// Recognize a `fetch(url)` builtin call — a plain call to the global `fetch`,
// intercepted before generic call lowering (like JSON/Math/Promise). Exactly one
// string URL argument; request options (a 2nd arg) need optional object fields,
// so they're a clean v1 error. Returns null for any other call.
function tryLowerFetchCall(node: ts.CallExpression): Expr | null {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "fetch") {
    return null;
  }
  if (node.arguments.length !== 1) {
    throw new Error(
      "fetch supports only a URL (GET) in v1 — request options (method/headers/body) need optional object fields (blocked on union types)",
    );
  }
  return { kind: "fetch", url: lowerExpr(node.arguments[0]) };
}

// Recognize `await <recv>.json()` (zero-arg). Returns the `.json()` call (so the
// receiver can be extracted), or null. `Response.json()` is `Promise<any>`, which
// the subset can't represent, so a target type must be supplied up front — this is
// matched only at the call sites that have one (`as T` / an annotated target).
function responseJsonCall(node: ts.Expression): ts.CallExpression | null {
  const inner = skipParens(node);
  if (!ts.isAwaitExpression(inner)) return null;
  const call = skipParens(inner.expression);
  if (
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "json" &&
    call.arguments.length === 0
  ) {
    return call;
  }
  return null;
}

// Build `await (responseJson)` from an `await recv.json()` call and its target
// type. (`responseJson` is a `Promise<type>`; the `await` unwraps it to `type`,
// matching the `as T` / annotation that supplied the type.)
function responseJsonAwaitNode(call: ts.CallExpression, type: Type): Expr {
  const recv = (call.expression as ts.PropertyAccessExpression).expression;
  return {
    kind: "await",
    expr: { kind: "responseJson", receiver: lowerExpr(recv), type },
  };
}

// Lower a `Math.<name>` constant reference to a `mathConst` node. An unknown name
// is a clear error (a bare `Math.<fn>` reference — no first-class functions — too).
function lowerMathConst(name: string): Expr {
  if (!MATH_CONSTANTS.has(name)) {
    throw new Error(
      `Unsupported Math member 'Math.${name}' (v1) — Math methods must be called`,
    );
  }
  return { kind: "mathConst", name };
}

// `new Map<K, V>()` — the subset constructs only an *empty* map (entries are
// added via `.set`); the `new Map(entries)` iterable form needs tuples (out of
// subset). Type arguments are required here (the annotated-target form
// `const m: Map<K, V> = new Map()` is handled in lowerVarDecl).
function lowerNewMap(node: ts.NewExpression): Expr {
  const ta = node.typeArguments;
  if (!ta || ta.length !== 2) {
    throw new Error(
      "new Map requires explicit type arguments (v1) — write `new Map<K, V>()`",
    );
  }
  if (node.arguments && node.arguments.length > 0) {
    throw new Error(
      "new Map(entries) is not supported (v1) — construct `new Map<K, V>()` and .set() entries",
    );
  }
  return { kind: "mapNew", key: lowerType(ta[0]), value: lowerType(ta[1]) };
}

// `new Set<T>()` / `new Set<T>(arr)`. Type arguments are required (the annotated
// form is handled in lowerVarDecl). An optional single argument seeds the set and
// must be a `T[]` (an array is the only iterable the subset supports).
function lowerNewSet(node: ts.NewExpression): Expr {
  const ta = node.typeArguments;
  if (!ta || ta.length !== 1) {
    throw new Error(
      "new Set requires an explicit type argument (v1) — write `new Set<T>()`",
    );
  }
  return setNewNode(lowerType(ta[0]), node.arguments);
}

// Build a `setNew` node from an element type and the constructor arguments (an
// optional array initializer). More than one argument is rejected.
function setNewNode(element: Type, args?: ts.NodeArray<ts.Expression>): Expr {
  if (args && args.length > 1) {
    throw new Error("new Set expects at most one argument (an array) (v1)");
  }
  const init = args && args.length === 1 ? lowerExpr(args[0]) : undefined;
  return { kind: "setNew", element, init };
}
