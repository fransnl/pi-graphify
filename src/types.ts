export type NodeKind =
  | "file"
  | "class"
  | "function"
  | "table"
  | "doc"
  | "endpoint"
  | "module"
  | "symbol"
  | "concept"
  | "api";

export type RelationKind =
  | "imports"
  | "calls"
  | "defines"
  | "references"
  | "inherits"
  | "implements"
  | "depends_on";

export type ProvenanceKind = "EXTRACTED" | "INFERRED";

export interface GraphNode {
  id: string;
  name: string;
  kind: NodeKind;
  path: string;
  summary?: string;
  community?: number;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: RelationKind;
  provenance?: ProvenanceKind;
  weight?: number;
  description?: string;
}

export interface CommunityCluster {
  id: number;
  name: string;
  nodeIds: string[];
  description?: string;
}

export interface KnowledgeGraph {
  version: string;
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities?: CommunityCluster[];
}