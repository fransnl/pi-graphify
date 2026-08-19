import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { KnowledgeGraph, GraphNode, GraphEdge, CommunityCluster, RelationKind, NodeKind } from "./types.js";

export class GraphStore {
  private graph: KnowledgeGraph = {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    nodes: [],
    edges: [],
    communities: [],
  };

  private isInitialized = false;
  private nodeMap = new Map<string, GraphNode>();
  private adjacency = new Map<string, Array<{ target: string; relation: RelationKind }>>();
  private reverseAdjacency = new Map<string, Array<{ source: string; relation: RelationKind }>>();

  constructor(private readonly storagePath: string) {
    this.load();
  }

  public get isLoaded(): boolean {
    return this.isInitialized;
  }

  public get nodes(): GraphNode[] {
    return this.graph.nodes;
  }

  public get edges(): GraphEdge[] {
    return this.graph.edges;
  }

  public get communities(): CommunityCluster[] {
    return this.graph.communities || [];
  }

  public setGraph(graph: KnowledgeGraph): void {
    this.graph = graph;
    this.isInitialized = true;
    this.rebuildIndices();
    this.save();
  }

  public mergeGraph(incomingNodes: GraphNode[], incomingEdges: GraphEdge[]): { addedNodes: number; addedEdges: number } {
    const existingNodeMap = new Map(this.graph.nodes.map((n) => [n.id, n]));
    const existingEdgeKeys = new Set(this.graph.edges.map((e) => `${e.source}->${e.relation}->${e.target}`));

    let addedNodes = 0;
    let addedEdges = 0;

    for (const node of incomingNodes) {
      if (!existingNodeMap.has(node.id)) {
        this.graph.nodes.push(node);
        existingNodeMap.set(node.id, node);
        addedNodes++;
      } else {
        const existing = existingNodeMap.get(node.id)!;
        if (!existing.summary && node.summary) existing.summary = node.summary;
        if (node.supersededBy) existing.supersededBy = node.supersededBy;
      }
    }

    for (const edge of incomingEdges) {
      const key = `${edge.source}->${edge.relation}->${edge.target}`;
      if (!existingEdgeKeys.has(key)) {
        this.graph.edges.push(edge);
        existingEdgeKeys.add(key);
        addedEdges++;
      }
    }

    this.isInitialized = true;
    this.rebuildIndices();
    this.save();

    return { addedNodes, addedEdges };
  }

  public load(): boolean {
    if (!existsSync(this.storagePath)) return false;
    try {
      const raw = readFileSync(this.storagePath, "utf-8");
      this.graph = JSON.parse(raw);
      this.isInitialized = true;
      this.rebuildIndices();
      return true;
    } catch {
      return false;
    }
  }

  public save(): void {
    try {
      mkdirSync(dirname(this.storagePath), { recursive: true });
      writeFileSync(this.storagePath, JSON.stringify(this.graph, null, 2), "utf-8");
    } catch (err) {
      console.error(`[pi-graphify] Save failed: ${this.storagePath}`, err);
    }
  }

  private rebuildIndices(): void {
    this.nodeMap.clear();
    this.adjacency.clear();
    this.reverseAdjacency.clear();

    for (const node of this.graph.nodes) {
      this.nodeMap.set(node.id, node);
      this.adjacency.set(node.id, []);
      this.reverseAdjacency.set(node.id, []);
    }

    for (const edge of this.graph.edges) {
      if (!this.adjacency.has(edge.source)) this.adjacency.set(edge.source, []);
      this.adjacency.get(edge.source)?.push({ target: edge.target, relation: edge.relation });

      if (!this.reverseAdjacency.has(edge.target)) this.reverseAdjacency.set(edge.target, []);
      this.reverseAdjacency.get(edge.target)?.push({ source: edge.source, relation: edge.relation });
    }
  }

  public searchNodes(query: string, limit = 10): Array<{ node: GraphNode; score: number }> {
    const queryTokens = query.toLowerCase().split(/[\s,/:#.-]+/).filter((t) => t.length > 1);
    if (queryTokens.length === 0) {
      return this.graph.nodes.slice(0, limit).map((node) => ({ node, score: 1 }));
    }

    const scored = this.graph.nodes.map((node) => {
      let score = 0;
      const idLower = node.id.toLowerCase();
      const nameLower = node.name.toLowerCase();
      const pathLower = node.path.toLowerCase();
      const summaryLower = (node.summary || "").toLowerCase();

      // Tier Priority Weights
      if (node.tier === 1) score += 25; // Tier 1 constitutional rules
      if (node.tier === 2 && !node.supersededBy) score += 15; // Active decisions

      for (const token of queryTokens) {
        if (nameLower === token) score += 30;
        else if (nameLower.includes(token)) score += 15;

        if (idLower.includes(token)) score += 10;
        if (summaryLower.includes(token)) score += 8;
        if (pathLower.includes(token)) score += 5;
      }

      return { node, score };
    });

    return scored
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  public getNodeNeighbors(nodeId: string, _depth = 1) {
    const node = this.nodeMap.get(nodeId);
    if (!node) return null;

    const outbound = (this.adjacency.get(nodeId) || []).map((e) => ({
      target: this.nodeMap.get(e.target) || { id: e.target, name: e.target, kind: "symbol" as NodeKind, path: "" },
      relation: e.relation,
    }));

    const inbound = (this.reverseAdjacency.get(nodeId) || []).map((e) => ({
      source: this.nodeMap.get(e.source) || { id: e.source, name: e.source, kind: "symbol" as NodeKind, path: "" },
      relation: e.relation,
    }));

    return { node, outbound, inbound };
  }

  public tracePath(sourceId: string, targetId: string): string[] | null {
    if (!this.nodeMap.has(sourceId) || !this.nodeMap.has(targetId)) return null;

    const queue: Array<{ id: string; path: string[] }> = [{ id: sourceId, path: [sourceId] }];
    const visited = new Set<string>([sourceId]);

    while (queue.length > 0) {
      const { id, path } = queue.shift()!;
      if (id === targetId) return path;

      for (const next of (this.adjacency.get(id) || []).map((e) => e.target)) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push({ id: next, path: [...path, next] });
        }
      }
    }
    return null;
  }

  public getGodNodes(limit = 6) {
    const degrees = this.graph.nodes.map((node) => {
      const outDeg = this.adjacency.get(node.id)?.length || 0;
      const inDeg = this.reverseAdjacency.get(node.id)?.length || 0;
      return { node, degree: outDeg + inDeg, inDegree: inDeg, outDegree: outDeg };
    });

    return degrees.sort((a, b) => b.degree - a.degree).slice(0, limit);
  }

  public getSummary() {
    const kinds: Record<string, number> = {};
    for (const n of this.graph.nodes) kinds[n.kind] = (kinds[n.kind] || 0) + 1;

    return {
      totalNodes: this.graph.nodes.length,
      totalEdges: this.graph.edges.length,
      totalCommunities: this.graph.communities?.length || 0,
      kinds,
      topCentralNodes: this.getGodNodes(6).map((g) => ({
        id: g.node.id,
        name: g.node.name,
        kind: g.node.kind,
        degree: g.degree,
      })),
    };
  }
}