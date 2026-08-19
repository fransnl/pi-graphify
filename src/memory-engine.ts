import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { GraphNode, GraphEdge } from "./types.js";
import type { GraphStore } from "./graph-store.js";

export class MemoryEngine {
  private memoryFilePath: string;

  constructor(workspaceRoot: string) {
    this.memoryFilePath = join(workspaceRoot, ".pi", "knowledge", "memory", "memory.json");
  }

  public saveMemories(nodes: GraphNode[]): void {
    try {
      mkdirSync(dirname(this.memoryFilePath), { recursive: true });
      const memoryNodes = nodes.filter((n) => ["constraint", "decision", "plan", "fact"].includes(n.kind));
      writeFileSync(
        this.memoryFilePath,
        JSON.stringify({ version: "1.0.0", updatedAt: new Date().toISOString(), items: memoryNodes }, null, 2),
        "utf-8"
      );
    } catch (err) {
      console.error("[pi-graphify] Failed to save memory:", err);
    }
  }

  public extractTurnMemories(userPrompt: string, assistantResponse: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const now = new Date().toISOString();

    const constraintMatches = userPrompt.match(/(?:always|never|do not|from now on|remember that|make sure to)\s+([^.!?\n]+)/gi);
    if (constraintMatches) {
      for (const match of constraintMatches) {
        const text = match.trim();
        const slug = encodeURIComponent(text.slice(0, 30).toLowerCase().replace(/[^a-z0-9]+/g, "-"));
        const id = `constraint://user/${slug}-${Date.now().toString().slice(-4)}`;

        nodes.push({
          id,
          name: `User Directive: ${text.slice(0, 40)}`,
          kind: "constraint",
          path: ".pi/knowledge/memory/memory.json",
          tier: 1,
          decayable: false,
          summary: text,
          createdAt: now,
          accessCount: 1,
          lastAccessedAt: now,
        });
      }
    }

    const decisionMatches = assistantResponse.match(/(?:we decided to|chosen|refactored|architecture decision|using)\s+([^.!?\n]{15,100})/gi);
    if (decisionMatches && decisionMatches.length > 0) {
      const text = decisionMatches[0].trim();
      const slug = encodeURIComponent(text.slice(0, 30).toLowerCase().replace(/[^a-z0-9]+/g, "-"));
      const id = `decision://arch/${slug}-${Date.now().toString().slice(-4)}`;

      nodes.push({
        id,
        name: `Decision: ${text.slice(0, 40)}`,
        kind: "decision",
        path: ".pi/knowledge/memory/memory.json",
        tier: 2,
        decayable: false,
        summary: text,
        createdAt: now,
        accessCount: 1,
        lastAccessedAt: now,
      });
    }

    return { nodes, edges };
  }

  public handleSupersession(newDecision: GraphNode, store: GraphStore): void {
    const existingDecisions = store.nodes.filter(
      (n) => n.kind === "decision" && !n.supersededBy && n.id !== newDecision.id
    );

    for (const old of existingDecisions) {
      const oldWords = new Set(old.name.toLowerCase().split(/\s+/));
      const newWords = newDecision.name.toLowerCase().split(/\s+/);
      const overlap = newWords.filter((w) => w.length > 3 && oldWords.has(w)).length;

      if (overlap >= 2) {
        old.supersededBy = newDecision.id;
        store.mergeGraph(
          [old],
          [
            {
              source: newDecision.id,
              target: old.id,
              relation: "supersedes",
              provenance: "INFERRED",
              description: `Superseded previous decision ${old.id}`,
            },
          ]
        );
      }
    }
  }

  public decayEphemeralMemories(store: GraphStore): number {
    const now = Date.now();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    let pruned = 0;

    const remainingNodes = store.nodes.filter((node) => {
      if (node.tier === 3 && node.decayable) {
        const lastAccess = node.lastAccessedAt ? new Date(node.lastAccessedAt).getTime() : 0;
        if (now - lastAccess > SEVEN_DAYS_MS && (node.accessCount || 0) < 3) {
          pruned++;
          return false;
        }
      }
      return true;
    });

    if (pruned > 0) {
      store.setGraph({
        version: "1.0.0",
        generatedAt: new Date().toISOString(),
        nodes: remainingNodes,
        edges: store.edges.filter((e) => remainingNodes.some((n) => n.id === e.source) && remainingNodes.some((n) => n.id === e.target)),
      });
      this.saveMemories(remainingNodes);
    }

    return pruned;
  }
}