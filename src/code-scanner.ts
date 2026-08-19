import { readdirSync, readFileSync, existsSync } from "node:fs";
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

  // 2. Scan Local Project Source Files
  function walkLocal(currentDir: string): void {
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
        walkLocal(fullPath);
      } else if (entry.isFile()) {
        parseSourceFile(fullPath, relPath, nodes, edges);
      }
    }
  }

  walkLocal(rootPath);

  // 3. Rescan and Restore Persistent Knowledge Vault (.pi/knowledge/)
  await scanKnowledgeVault(rootPath, nodes, edges);

  return {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
  };
}

/**
 * Rescans all persistent documents, cloned repos, and memories from .pi/knowledge/
 */
async function scanKnowledgeVault(workspaceRoot: string, nodes: GraphNode[], edges: GraphEdge[]): Promise<void> {
  const vaultPath = join(workspaceRoot, ".pi", "knowledge");
  if (!existsSync(vaultPath)) return;

  // A. Rescan Ingested Web Docs (.pi/knowledge/docs/)
  const docsVault = join(vaultPath, "docs");
  if (existsSync(docsVault)) {
    function walkDocs(currentDir: string): void {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        const relPath = relative(workspaceRoot, fullPath);

        if (entry.isDirectory()) {
          walkDocs(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          parseVaultDocFile(fullPath, relPath, nodes, edges);
        }
      }
    }
    try {
      walkDocs(docsVault);
    } catch {
      // Ignore directory read errors
    }
  }

  // B. Rescan Ingested Cloned Repositories (.pi/knowledge/repos/)
  const reposVault = join(vaultPath, "repos");
  if (existsSync(reposVault)) {
    try {
      const owners = readdirSync(reposVault, { withFileTypes: true }).filter((e) => e.isDirectory());
      for (const owner of owners) {
        const ownerPath = join(reposVault, owner.name);
        const repoDirs = readdirSync(ownerPath, { withFileTypes: true }).filter((e) => e.isDirectory());

        for (const repo of repoDirs) {
          const repoFullPath = join(ownerPath, repo.name);
          const repoName = `${owner.name}/${repo.name}`;
          const repoNamespace = `repo://${repoName}`;
          const relativeRepoPath = relative(workspaceRoot, repoFullPath);

          // Root Module Node
          nodes.push({
            id: repoNamespace,
            name: repoName,
            kind: "module",
            path: relativeRepoPath,
            summary: `Cloned repository: ${repoName}`,
          });

          // Scan repo source files
          function walkRepo(currentDir: string): void {
            const entries = readdirSync(currentDir, { withFileTypes: true });
            for (const entry of entries) {
              if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
              const subPath = join(currentDir, entry.name);
              const subRelPath = relative(workspaceRoot, subPath);

              if (entry.isDirectory()) {
                walkRepo(subPath);
              } else if (entry.isFile()) {
                parseSourceFile(subPath, subRelPath, nodes, edges);
              }
            }
          }
          walkRepo(repoFullPath);
        }
      }
    } catch {
      // Ignore repo scan errors
    }
  }

  // C. Rescan Persistent Memories (.pi/knowledge/memory/memory.json)
  const memoryFile = join(vaultPath, "memory", "memory.json");
  if (existsSync(memoryFile)) {
    try {
      const raw = readFileSync(memoryFile, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.items)) {
        for (const item of parsed.items) {
          nodes.push(item);
        }
      }
    } catch {
      // Ignore corrupted memory file
    }
  }
}

/**
 * Parses Markdown files stored in .pi/knowledge/docs/ and reconstructs concept nodes with line ranges
 */
function parseVaultDocFile(fullPath: string, relPath: string, nodes: GraphNode[], edges: GraphEdge[]): void {
  try {
    const content = readFileSync(fullPath, "utf-8");
    const lines = content.split(/\r?\n/);
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : relPath;

    const parts = relPath.replace(/^(\.pi\/knowledge\/docs\/)/, "").split("/");
    const docNodeId = `doc://${parts.join("/")}`;

    // Root Document Node
    nodes.push({
      id: docNodeId,
      name: title,
      kind: "doc",
      path: relPath,
      summary: lines.slice(4, 12).join(" ").slice(0, 300) || `Documentation for ${title}`,
      lineStart: 1,
      lineEnd: lines.length,
    });

    // Re-index Section Concept Nodes
    let currentSection: { name: string; start: number } | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headerMatch = line.match(/^(#{2,3})\s+(.+)$/);

      if (headerMatch) {
        if (currentSection) {
          const sectionSlug = encodeURIComponent(currentSection.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
          const sectionId = `${docNodeId}#${sectionSlug}`;
          const sectionText = lines.slice(currentSection.start - 1, i).join(" ").slice(0, 400);

          nodes.push({
            id: sectionId,
            name: currentSection.name,
            kind: "concept",
            path: relPath,
            summary: sectionText,
            lineStart: currentSection.start,
            lineEnd: i,
          });

          edges.push({
            source: docNodeId,
            target: sectionId,
            relation: "defines",
            provenance: "EXTRACTED",
          });
        }

        currentSection = {
          name: headerMatch[2].trim(),
          start: i + 1,
        };
      }
    }

    if (currentSection) {
      const sectionSlug = encodeURIComponent(currentSection.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
      const sectionId = `${docNodeId}#${sectionSlug}`;
      const sectionText = lines.slice(currentSection.start - 1).join(" ").slice(0, 400);

      nodes.push({
        id: sectionId,
        name: currentSection.name,
        kind: "concept",
        path: relPath,
        summary: sectionText,
        lineStart: currentSection.start,
        lineEnd: lines.length,
      });

      edges.push({
        source: docNodeId,
        target: sectionId,
        relation: "defines",
        provenance: "EXTRACTED",
      });
    }
  } catch {
    // Non-parseable file
  }
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

      // Imports
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
    // Non-parseable
  }
}