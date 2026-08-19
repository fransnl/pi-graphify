import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { GraphNode, GraphEdge } from "./types.js";

const AGENT_RULE_FILES = ["AGENTS.md", ".pi/AGENTS.md", "CLAUDE.md", ".cursorrules"];

export function parseAgentsRules(workspaceRoot: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const fileName of AGENT_RULE_FILES) {
    const fullPath = join(workspaceRoot, fileName);
    if (!existsSync(fullPath)) continue;

    try {
      const content = readFileSync(fullPath, "utf-8");
      const lines = content.split(/\r?\n/);
      const rootDocId = `doc://${fileName}`;

      // Root Document Node
      nodes.push({
        id: rootDocId,
        name: fileName,
        kind: "doc",
        path: fileName,
        tier: 1,
        decayable: false,
        summary: `Constitutional rules and directives defined in ${fileName}`,
        lineStart: 1,
        lineEnd: lines.length,
        createdAt: new Date().toISOString(),
      });

      let currentCategory = "General";
      let ruleIndex = 1;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const headerMatch = line.match(/^#{1,4}\s+(.+)$/);

        if (headerMatch) {
          currentCategory = headerMatch[1].trim();
          continue;
        }

        // Match bullet points, numbered items, or blockquotes declaring instructions
        const ruleMatch = line.match(/^(?:[-*+]|\d+\.)\s+(.+)$/) || line.match(/^>\s+(.+)$/);
        if (ruleMatch) {
          const ruleText = ruleMatch[1].trim();
          if (ruleText.length < 10) continue;

          const slug = encodeURIComponent(
            `${currentCategory}-${ruleIndex}`.toLowerCase().replace(/[^a-z0-9]+/g, "-")
          );
          const ruleId = `rule://${fileName.toLowerCase().replace(/[^a-z0-9]/g, "-")}/${slug}`;

          const isConstraint = /\b(never|always|do not|must|prohibited|only use|disallowed)\b/i.test(ruleText);

          const ruleNode: GraphNode = {
            id: ruleId,
            name: `${currentCategory}: Rule #${ruleIndex}`,
            kind: isConstraint ? "constraint" : "rule",
            path: fileName,
            tier: 1,
            decayable: false,
            summary: ruleText,
            lineStart: i + 1,
            lineEnd: i + 1,
            createdAt: new Date().toISOString(),
            metadata: { category: currentCategory, sourceFile: fileName },
          };

          nodes.push(ruleNode);

          edges.push({
            source: rootDocId,
            target: ruleId,
            relation: "defines",
            provenance: "SYSTEM_RULE",
            description: `Constitutional rule in ${currentCategory}`,
          });

          // Check if rule mentions known file paths or package managers
          const fileRefMatch = ruleText.match(/([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)/g);
          if (fileRefMatch) {
            for (const ref of fileRefMatch) {
              edges.push({
                source: ruleId,
                target: `file://${ref}`,
                relation: "governs",
                provenance: "SYSTEM_RULE",
              });
            }
          }

          ruleIndex++;
        }
      }
    } catch {
      // Ignore unreadable rule file
    }
  }

  return { nodes, edges };
}