// Stage 1 + 2: parse with the official TypeScript parser, then lower its AST
// into our internal IR. We read type annotations straight off the AST; a full
// ts.Program + TypeChecker comes later (see CLAUDE.md roadmap).

import * as ts from "typescript";
import { Module, Stmt, Expr, BinaryOp, Type, Func, RetType } from "../ir/nodes";

export function lower(fileName: string, source: string): Module {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true
  );
  const functions: Func[] = [];
  const main: Stmt[] = [];
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt)) {
      functions.push(lowerFunction(stmt));
      continue;
    }
    if (ts.isReturnStatement(stmt)) {
      throw new Error("'return' is only allowed inside a function");
    }
    lowerStatement(stmt, main);
  }
  return { functions, main };
}

function lowerFunction(fn: ts.FunctionDeclaration): Func {
  if (!fn.name) throw new Error("Function declarations must be named (v1)");
  if (!fn.body) throw new Error(`Function '${fn.name.text}' must have a body`);

  const params = fn.parameters.map((p) => {
    if (!ts.isIdentifier(p.name)) {
      throw new Error("Only simple parameter names are supported (v1)");
    }
    if (!p.type) {
      throw new Error(`Parameter '${p.name.text}' needs a type annotation`);
    }
    const type = lowerType(p.type);
    if (typeof type !== "string") {
      throw new Error("Function parameters must be number, boolean, or string (v1)");
    }
    return { name: p.name.text, type };
  });

  if (!fn.type) {
    throw new Error(`Function '${fn.name.text}' needs a return type annotation`);
  }
  let returnType: RetType;
  if (fn.type.kind === ts.SyntaxKind.VoidKeyword) {
    returnType = "void";
  } else {
    const t = lowerType(fn.type);
    if (typeof t !== "string") {
      throw new Error("Function return type must be number, boolean, string, or void (v1)");
    }
    returnType = t;
  }

  const body: Stmt[] = [];
  for (const s of fn.body.statements) lowerStatement(s, body);
  return { name: fn.name.text, params, returnType, body };
}

function lowerStatement(node: ts.Statement, out: Stmt[]): void {
  if (ts.isVariableStatement(node)) {
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
  if (ts.isExpressionStatement(node)) {
    const expr = node.expression;
    if (ts.isCallExpression(expr) && isConsoleLog(expr.expression)) {
      if (expr.arguments.length !== 1) {
        throw new Error("console.log expects exactly one argument (v1)");
      }
      out.push({ kind: "log", arg: lowerExpr(expr.arguments[0]) });
      return;
    }
    if (ts.isCallExpression(expr)) {
      out.push({ kind: "exprStmt", expr: lowerExpr(expr) });
      return;
    }
  }
  throw new Error(`Unsupported statement: ${ts.SyntaxKind[node.kind]}`);
}

function lowerVarDecl(decl: ts.VariableDeclaration): Stmt {
  if (!ts.isIdentifier(decl.name)) {
    throw new Error("Only simple identifier bindings are supported (v1)");
  }
  if (!decl.initializer) {
    throw new Error(`'${decl.name.text}' must be initialized (v1)`);
  }
  const type: Type = decl.type ? lowerType(decl.type) : "number";
  return { kind: "let", name: decl.name.text, type, init: lowerExpr(decl.initializer) };
}

function lowerType(node: ts.TypeNode): Type {
  if (node.kind === ts.SyntaxKind.NumberKeyword) return "number";
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return "boolean";
  if (node.kind === ts.SyntaxKind.StringKeyword) return "string";
  // `T[]`
  if (ts.isArrayTypeNode(node)) {
    return { kind: "array", element: lowerType(node.elementType) };
  }
  // `{ a: T; b: U }`
  if (ts.isTypeLiteralNode(node)) {
    const fields = node.members.map((m) => {
      if (!ts.isPropertySignature(m) || !m.name || !ts.isIdentifier(m.name) || !m.type) {
        throw new Error("Unsupported object type member (v1)");
      }
      const t = lowerType(m.type);
      if (typeof t !== "string") {
        throw new Error("Object fields must be number, boolean, or string (v1)");
      }
      return { name: m.name.text, type: t };
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
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: "bool", value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "bool", value: false };
  if (ts.isIdentifier(node)) return { kind: "var", name: node.text };
  if (ts.isParenthesizedExpression(node)) return lowerExpr(node.expression);
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
          throw new Error("Only simple { name: value } object properties are supported (v1)");
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
    return { kind: "member", obj: lowerExpr(node.expression), name: node.name.text };
  }
  if (ts.isCallExpression(node)) {
    if (!ts.isIdentifier(node.expression)) {
      throw new Error("Only direct calls to named functions are supported (v1)");
    }
    return {
      kind: "call",
      callee: node.expression.text,
      args: node.arguments.map(lowerExpr),
    };
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
