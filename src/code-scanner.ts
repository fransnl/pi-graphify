import { readdirSync, readFileSync } from "node:fs";
import { join, relative, extname, resolve } from "node:path";
import type { KnowledgeGraph, GraphNode, GraphEdge } from "./types.js";
import { parseAgentsRules } from "./agents-md-parser.js";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".pi",
  ".next",
  "__pycache__",
  "venv",
  ".venv",
]);

export async function scanCodebase(targetDir: string): Promise<KnowledgeGraph> {
  const rootPath = resolve(targetDir);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // 1. Ingest Constitutional Rules from AGENTS.md / CLAUDE.md
  const ruleResult = parseAgentsRules(rootPath);
  nodes.push(...ruleResult.nodes);
  edges.push(...ruleResult.edges);

  function walk(currentDir: string): void {
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".env.example")) {
        continue;
      }

      const fullPath = join(currentDir, entry.name);
      const relPath = relative(rootPath, fullPath) || entry.name;

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        parseSourceFile(fullPath, relPath, nodes, edges);
      }
    }
  }

  walk(rootPath);

  return {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
  };
}

function parseSourceFile(fullPath: string, relPath: string, nodes: GraphNode[], edges: GraphEdge[]): void {
  const ext = extname(fullPath).toLowerCase();
  const fileNodeId = `file://${relPath}`;

  let docHeader = "";
  try {
    const raw = readFileSync(fullPath, "utf-8");
    const firstLines = raw.split("\n").slice(0, 10).join(" ");
    const headerMatch = firstLines.match(/\/\*\*?([\s\S]*?)\*\//) || firstLines.match(/"""([\s\S]*?)"""/);
    if (headerMatch) docHeader = headerMatch[1].replace(/[*#]/g, "").trim().slice(0, 200);
  } catch {
    // Non-text
  }

  nodes.push({
    id: fileNodeId,
    name: relPath,
    kind: "file",
    path: relPath,
    summary: docHeader || `Source file ${relPath}`,
  });

  if (![".ts", ".js", ".tsx", ".jsx", ".py", ".go", ".rs", ".java", ".sql", ".md", ".json"].includes(ext)) {
    return;
  }

  try {
    const content = readFileSync(fullPath, "utf-8");
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // TS/JS Imports
      const tsImport = line.match(/import\s+.*?from\s+['"](.*?)['"]/);
      if (tsImport) {
        edges.push({
          source: fileNodeId,
          target: tsImport[1].startsWith(".") ? `file://${tsImport[1]}` : `pkg://${tsImport[1]}`,
          relation: "imports",
          provenance: "EXTRACTED",
        });
      }

      // Classes
      const classMatch = line.match(/(?:export\s+)?class\s+([A-Za-z0-9_]+)/);
      if (classMatch) {
        const classNodeId = `${fileNodeId}#${classMatch[1]}`;
        nodes.push({
          id: classNodeId,
          name: classMatch[1],
          kind: "class",
          path: relPath,
          lineStart: i + 1,
          lineEnd: i + 1,
          summary: `Class ${classMatch[1]} in ${relPath}`,
        });
        edges.push({ source: fileNodeId, target: classNodeId, relation: "defines", provenance: "EXTRACTED" });
      }

      // Functions
      const fnMatch = line.match(/(?:export\s+)?(?:async\s+)?(?:def|function|func|fn)\s+([A-Za-z0-9_]+)/);
      if (fnMatch) {
        const fnNodeId = `${fileNodeId}#${fnMatch[1]}`;
        nodes.push({
          id: fnNodeId,
          name: fnMatch[1],
          kind: "function",
          path: relPath,
          lineStart: i + 1,
          lineEnd: i + 1,
          summary: `Function ${fnMatch[1]} in ${relPath}`,
        });
        edges.push({ source: fileNodeId, target: fnNodeId, relation: "defines", provenance: "EXTRACTED" });
      }

      // SQL Tables
      const sqlMatch = line.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/i);
      if (sqlMatch) {
        const tableNodeId = `db://table/${sqlMatch[1]}`;
        nodes.push({
          id: tableNodeId,
          name: sqlMatch[1],
          kind: "table",
          path: relPath,
          lineStart: i + 1,
          lineEnd: i + 1,
          summary: `Database table ${sqlMatch[1]}`,
        });
        edges.push({ source: fileNodeId, target: tableNodeId, relation: "defines", provenance: "EXTRACTED" });
      }
    }
  } catch {
    // Binary or unreadable
  }
}