// Stage 1 + 2: parse with the official TypeScript parser, then lower its AST
// into our internal IR. We read type annotations straight off the AST; a full
// ts.Program + TypeChecker comes later (see CLAUDE.md roadmap).

import * as ts from "typescript";
import { Module, Stmt, Expr, BinaryOp, Type } from "../ir/nodes";

export function lower(fileName: string, source: string): Module {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true
  );
  const stmts: Stmt[] = [];
  for (const stmt of sf.statements) {
    lowerStatement(stmt, stmts);
  }
  return { stmts };
}

function lowerStatement(node: ts.Statement, out: Stmt[]): void {
  if (ts.isVariableStatement(node)) {
    for (const decl of node.declarationList.declarations) {
      out.push(lowerVarDecl(decl));
    }
    return;
  }
  if (ts.isExpressionStatement(node)) {
    const call = node.expression;
    if (ts.isCallExpression(call) && isConsoleLog(call.expression)) {
      if (call.arguments.length !== 1) {
        throw new Error("console.log expects exactly one argument (v1)");
      }
      out.push({ kind: "log", arg: lowerExpr(call.arguments[0]) });
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
  // In our `tsn` dialect, the boxed wrappers `Number`/`Boolean`/`String` are
  // treated as their primitives — we only have one of each.
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const n = node.typeName.text;
    if (n === "Number" || n === "number") return "number";
    if (n === "Boolean" || n === "boolean") return "boolean";
    if (n === "String" || n === "string") return "string";
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
