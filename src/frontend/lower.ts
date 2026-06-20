// Stage 1 + 2: parse with the official TypeScript parser, then lower its AST
// into our internal IR. We read type annotations straight off the AST; a full
// ts.Program + TypeChecker comes later (see CLAUDE.md roadmap).

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
} from "../ir/nodes";

export function lower(fileName: string, source: string): Module {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
  );
  const classes: ClassDecl[] = [];
  const functions: Func[] = [];
  const main: Stmt[] = [];
  for (const stmt of sf.statements) {
    // `import`/`export` declarations are handled by the module loader
    // (src/frontend/modules.ts): imports drove which files to include, and an
    // `export` modifier on a declaration is otherwise ignored. We skip the
    // statements here so they don't fall through to the "unsupported" throw. A
    // bare `export {...}` / re-export is rejected by the loader before we get here.
    if (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) {
      continue;
    }
    if (ts.isClassDeclaration(stmt)) {
      classes.push(lowerClass(stmt));
      continue;
    }
    if (ts.isFunctionDeclaration(stmt)) {
      functions.push(lowerFunction(stmt));
      continue;
    }
    if (ts.isReturnStatement(stmt)) {
      throw new Error("'return' is only allowed inside a function");
    }
    lowerStatement(stmt, main);
  }
  // A single lowered file has no dependency modules of its own; the module loader
  // (modules.ts) assembles cross-file programs and fills in `modules`.
  return { classes, functions, main, modules: [] };
}

// Lower a typed parameter list (function, method, or constructor). Each param
// needs a simple name and an explicit type annotation.
function lowerParams(params: ts.NodeArray<ts.ParameterDeclaration>): Param[] {
  return params.map((p) => {
    if (!ts.isIdentifier(p.name)) {
      throw new Error("Only simple parameter names are supported (v1)");
    }
    // A parameter-property (`constructor(private x: number)`) implicitly declares
    // and assigns a field — out of subset; declare the field explicitly instead.
    if (p.modifiers && p.modifiers.length > 0) {
      throw new Error(
        "Constructor parameter properties are not supported (v1) — declare the field explicitly",
      );
    }
    if (!p.type) {
      throw new Error(`Parameter '${p.name.text}' needs a type annotation`);
    }
    return { name: p.name.text, type: lowerType(p.type) };
  });
}

// `static` is the one modifier that changes semantics (no `this`); reject it.
// Access modifiers (public/private/protected/readonly) are accepted and ignored
// — we don't enforce visibility yet, and they don't affect generated code.
function hasStatic(node: ts.HasModifiers): boolean {
  return (
    ts
      .getModifiers(node)
      ?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false
  );
}

function lowerClass(cls: ts.ClassDeclaration): ClassDecl {
  if (!cls.name) throw new Error("Class declarations must be named (v1)");
  const name = cls.name.text;
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
      const body: Stmt[] = [];
      for (const s of m.body.statements) lowerStatement(s, body);
      ctor = { params: lowerParams(m.parameters), body };
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
      const returnType: RetType =
        m.type.kind === ts.SyntaxKind.VoidKeyword ? "void" : lowerType(m.type);
      const body: Stmt[] = [];
      for (const s of m.body.statements) lowerStatement(s, body);
      methods.push({
        name: m.name.text,
        params: lowerParams(m.parameters),
        returnType,
        body,
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

function lowerFunction(fn: ts.FunctionDeclaration): Func {
  if (!fn.name) throw new Error("Function declarations must be named (v1)");
  if (!fn.body) throw new Error(`Function '${fn.name.text}' must have a body`);

  // Params may be any supported type — scalars, arrays, objects, or class
  // instances. Codegen passes aggregates by `const&` and instances by value.
  const params = lowerParams(fn.parameters);

  if (!fn.type) {
    throw new Error(
      `Function '${fn.name.text}' needs a return type annotation`,
    );
  }
  let returnType: RetType;
  if (fn.type.kind === ts.SyntaxKind.VoidKeyword) {
    returnType = "void";
  } else {
    // Returns may be any supported type now (scalars, arrays, objects).
    // Codegen returns aggregates by value, leaning on C++ RVO/move so the cost
    // is paid only where the result is bound or used (see emit.ts).
    returnType = lowerType(fn.type);
  }

  const body: Stmt[] = [];
  for (const s of fn.body.statements) lowerStatement(s, body);
  return { name: fn.name.text, params, returnType, body };
}

function lowerStatement(node: ts.Statement, out: Stmt[]): void {
  if (ts.isVariableStatement(node)) {
    // Only `let` / `const` — `var` is intentionally unsupported.
    const flags = node.declarationList.flags;
    if (!(flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) {
      throw new Error("'var' is not supported — use 'let' or 'const'");
    }
    for (const decl of node.declarationList.declarations) {
      out.push(lowerVarDecl(decl));
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

// A block (`{ ... }`) or a single bare statement (`if (c) stmt;`) -> Stmt[].
function lowerBlock(node: ts.Statement): Stmt[] {
  const out: Stmt[] = [];
  if (ts.isBlock(node)) {
    for (const s of node.statements) lowerStatement(s, out);
  } else {
    lowerStatement(node, out);
  }
  return out;
}

function lowerVarDecl(decl: ts.VariableDeclaration): Stmt {
  if (!ts.isIdentifier(decl.name)) {
    throw new Error("Only simple identifier bindings are supported (v1)");
  }
  if (!decl.initializer) {
    throw new Error(`'${decl.name.text}' must be initialized (v1)`);
  }
  // No annotation -> leave type undefined; codegen infers it from the initializer.
  const type = decl.type ? lowerType(decl.type) : undefined;
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
  // `T[]`
  if (ts.isArrayTypeNode(node)) {
    return { kind: "array", element: lowerType(node.elementType) };
  }
  // `{ a: T; b: U }` — fields may be any supported type now, including arrays and
  // nested objects (`{ pts: number[] }`, `{ inner: { x: number } }`). `lowerType`
  // recurses, so the nesting is captured structurally; codegen maps each field to
  // its C++ type (a `std::vector<...>` member or a nested struct).
  if (ts.isTypeLiteralNode(node)) {
    const fields = node.members.map((m) => {
      if (
        !ts.isPropertySignature(m) ||
        !m.name ||
        !ts.isIdentifier(m.name) ||
        !m.type
      ) {
        throw new Error("Unsupported object type member (v1)");
      }
      return { name: m.name.text, type: lowerType(m.type) };
    });
    return { kind: "object", fields };
  }
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const n = node.typeName.text;
    // In our `tsn` dialect, the boxed wrappers `Number`/`Boolean`/`String` are
    // treated as their primitives — we only have one of each.
    if (n === "Number" || n === "number") return "number";
    if (n === "Boolean" || n === "boolean") return "boolean";
    if (n === "String" || n === "string") return "string";
    // `Array<T>`
    if (n === "Array" && node.typeArguments?.length === 1) {
      return { kind: "array", element: lowerType(node.typeArguments[0]) };
    }
    // A bare identifier that isn't a known primitive/built-in is treated as a
    // class instance type (`let p: Point`). The emitter validates the class
    // exists. Generic refs (with type arguments) still fall through as
    // unsupported, so e.g. `Map<K, V>` keeps its clear "Unsupported type" error.
    if (!node.typeArguments) {
      return { kind: "class", name: n };
    }
  }
  throw new Error(`Unsupported type annotation: ${ts.SyntaxKind[node.kind]}`);
}

function lowerExpr(node: ts.Expression): Expr {
  if (ts.isNumericLiteral(node)) {
    return { kind: "num", value: Number(node.text) };
  }
  // `node.text` is the decoded string value (escapes already resolved by TS).
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { kind: "str", value: node.text };
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword)
    return { kind: "bool", value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword)
    return { kind: "bool", value: false };
  if (node.kind === ts.SyntaxKind.ThisKeyword) return { kind: "this" };
  if (ts.isIdentifier(node)) return { kind: "var", name: node.text };
  if (ts.isNewExpression(node)) {
    if (!ts.isIdentifier(node.expression)) {
      throw new Error("'new' requires a class name (v1)");
    }
    return {
      kind: "new",
      className: node.expression.text,
      args: node.arguments ? node.arguments.map(lowerExpr) : [],
    };
  }
  if (ts.isParenthesizedExpression(node)) return lowerExpr(node.expression);
  // `e as T` — only supported as the type carrier for `JSON.parse(text) as T`
  // (JSON.parse is `any`, so the assertion supplies the value's static type). A
  // general type assertion has no representation in the typed subset.
  if (ts.isAsExpression(node)) {
    const inner = skipParens(node.expression);
    if (isJsonParseCall(inner)) {
      return jsonParseNode(inner, lowerType(node.type));
    }
    throw new Error(
      "Type assertions ('as T') are only supported on JSON.parse(...) (v1)",
    );
  }
  if (ts.isArrayLiteralExpression(node)) {
    return {
      kind: "array",
      elements: node.elements.map((el) => {
        if (ts.isSpreadElement(el)) {
          throw new Error("Spread elements in arrays are not supported (v1)");
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
    return {
      kind: "member",
      obj: lowerExpr(node.expression),
      name: node.name.text,
    };
  }
  if (ts.isCallExpression(node)) {
    // `JSON.stringify(x)` / `JSON.parse(x)` are builtins, not method calls —
    // intercept before the generic `recv.method(args)` path.
    const json = tryLowerJsonCall(node);
    if (json) return json;
    // `recv.method(args)` -> methodCall (e.g. xs.push(v)).
    if (ts.isPropertyAccessExpression(node.expression)) {
      return {
        kind: "methodCall",
        receiver: lowerExpr(node.expression.expression),
        method: node.expression.name.text,
        args: node.arguments.map(lowerExpr),
      };
    }
    if (!ts.isIdentifier(node.expression)) {
      throw new Error(
        "Only direct calls to named functions are supported (v1)",
      );
    }
    return {
      kind: "call",
      callee: node.expression.text,
      args: node.arguments.map(lowerExpr),
    };
  }
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
  throw new Error(`Unsupported expression: ${ts.SyntaxKind[node.kind]}`);
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
