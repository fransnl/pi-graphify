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
  | "api"
  | "rule"
  | "constraint"
  | "decision"
  | "plan"
  | "fact";

export type RelationKind =
  | "imports"
  | "calls"
  | "defines"
  | "references"
  | "inherits"
  | "implements"
  | "depends_on"
  | "governs"
  | "applies_to"
  | "supersedes"
  | "targets";

export type ProvenanceKind = "EXTRACTED" | "INFERRED" | "USER_STATED" | "SYSTEM_RULE";

export type MemoryTier = 1 | 2 | 3; // 1: Permanent Constitutional, 2: Architectural (Supersedable), 3: Ephemeral (Decayable)

export interface GraphNode {
  id: string;
  name: string;
  kind: NodeKind;
  /** Real local path relative to workspace root (e.g. .pi/knowledge/docs/... or AGENTS.md) */
  path: string;
  sourceUrl?: string;
  summary?: string;
  lineStart?: number;
  lineEnd?: number;
  community?: number;
  tier?: MemoryTier;
  decayable?: boolean;
  supersededBy?: string;
  accessCount?: number;
  lastAccessedAt?: string;
  createdAt?: string;
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