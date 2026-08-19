import { readdirSync, readFileSync } from "node:fs";
import { join, relative, extname, resolve } from "node:path";
import type { KnowledgeGraph, GraphNode, GraphEdge } from "./types.js";

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
  ".cache",
]);

export async function scanCodebase(targetDir: string): Promise<KnowledgeGraph> {
  const rootPath = resolve(targetDir);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

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
    if (headerMatch) {
      docHeader = headerMatch[1].replace(/[*#]/g, "").trim().slice(0, 200);
    }
  } catch {
    // Non-text file
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

    for (const line of lines) {
      // TS/JS Imports
      const tsImport = line.match(/import\s+.*?from\s+['"](.*?)['"]/);
      if (tsImport) {
        const target = tsImport[1];
        edges.push({
          source: fileNodeId,
          target: target.startsWith(".") ? `file://${target}` : `pkg://${target}`,
          relation: "imports",
          provenance: "EXTRACTED",
        });
      }

      // Python Imports
      const pyImport = line.match(/^(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.]+))/);
      if (pyImport) {
        const mod = pyImport[1] || pyImport[2];
        edges.push({
          source: fileNodeId,
          target: `py://${mod}`,
          relation: "imports",
          provenance: "EXTRACTED",
        });
      }

      // Classes
      const classMatch = line.match(/(?:export\s+)?class\s+([A-Za-z0-9_]+)/);
      if (classMatch) {
        const className = classMatch[1];
        const classNodeId = `${fileNodeId}#${className}`;
        nodes.push({
          id: classNodeId,
          name: className,
          kind: "class",
          path: relPath,
          summary: `Class ${className} declared in ${relPath}`,
        });
        edges.push({
          source: fileNodeId,
          target: classNodeId,
          relation: "defines",
          provenance: "EXTRACTED",
        });
      }

      // Functions
      const fnMatch = line.match(/(?:export\s+)?(?:async\s+)?(?:def|function|func|fn)\s+([A-Za-z0-9_]+)/);
      if (fnMatch) {
        const fnName = fnMatch[1];
        const fnNodeId = `${fileNodeId}#${fnName}`;
        nodes.push({
          id: fnNodeId,
          name: fnName,
          kind: "function",
          path: relPath,
          summary: `Function ${fnName} in ${relPath}`,
        });
        edges.push({
          source: fileNodeId,
          target: fnNodeId,
          relation: "defines",
          provenance: "EXTRACTED",
        });
      }

      // SQL Tables
      const sqlMatch = line.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/i);
      if (sqlMatch) {
        const tableName = sqlMatch[1];
        const tableNodeId = `db://table/${tableName}`;
        nodes.push({
          id: tableNodeId,
          name: tableName,
          kind: "table",
          path: relPath,
          summary: `Database table ${tableName} defined in ${relPath}`,
        });
        edges.push({
          source: fileNodeId,
          target: tableNodeId,
          relation: "defines",
          provenance: "EXTRACTED",
        });
      }
    }
  } catch {
    // Skip binary/unreadable files
  }
}