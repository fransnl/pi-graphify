import type { GraphStore } from "./graph-store.js";
import type { GraphNode } from "./types.js";

export interface PrimedContextResult {
  hasContext: boolean;
  tokenEstimate: number;
  contextBlock: string;
  matchedNodeIds: string[];
}

/**
 * Executes local associative graph walk and formats high-density context for the agent prompt.
 */
export function getAssociativePrimedContext(
  userPrompt: string,
  store: GraphStore,
  maxTokenBudget = 400
): PrimedContextResult {
  const query = userPrompt.trim();

  // Fast-path bypass for trivial queries
  if (!query || query.length < 5 || /^(hi|hello|thanks|thank you|ok|yes|no)$/i.test(query)) {
    return { hasContext: false, tokenEstimate: 0, contextBlock: "", matchedNodeIds: [] };
  }

  // 1. Gather all Tier 1 Constitutional Rules
  const constitutionalRules = store.nodes.filter(
    (n) => (n.kind === "rule" || n.kind === "constraint") && n.tier === 1
  );

  // 2. Perform Ranked Search over In-Memory Index
  const searchResults = store.searchNodes(query, 8);
  if (searchResults.length === 0 && constitutionalRules.length === 0) {
    return { hasContext: false, tokenEstimate: 0, contextBlock: "", matchedNodeIds: [] };
  }

  const sections: string[] = [];
  let tokenCount = 0;
  const matchedIds: string[] = [];

  // Helper for approx token count (1 token ~= 4 characters)
  const estimateTokens = (text: string) => Math.ceil(text.length / 4);

  // Priority 1: Matched Constitutional Rules & Constraints (Budget: ~120 tokens)
  const matchedRules = constitutionalRules.filter((r) => {
    const rText = `${r.name} ${r.summary || ""}`.toLowerCase();
    const qTokens = query.toLowerCase().split(/\s+/);
    return qTokens.some((t) => t.length > 3 && rText.includes(t));
  }).slice(0, 3);

  if (matchedRules.length > 0) {
    const ruleLines = matchedRules.map((r) => {
      matchedIds.push(r.id);
      return `* [RULE] ${r.name}: ${r.summary} (from ${r.path})`;
    });
    const block = `### Active Constraints & Rules:\n${ruleLines.join("\n")}`;
    tokenCount += estimateTokens(block);
    sections.push(block);
  }

  // Priority 2: Architectural Decisions & Memories (Budget: ~130 tokens)
  const matchedDecisions = searchResults
    .map((s) => s.node)
    .filter((n) => (n.kind === "decision" || n.kind === "fact") && !n.supersededBy)
    .slice(0, 2);

  if (matchedDecisions.length > 0 && tokenCount < maxTokenBudget) {
    const decisionLines = matchedDecisions.map((d) => {
      matchedIds.push(d.id);
      return `* [DECISION] ${d.name}: ${d.summary} (${d.path})`;
    });
    const block = `### Prior Architectural Decisions:\n${decisionLines.join("\n")}`;
    tokenCount += estimateTokens(block);
    sections.push(block);
  }

  // Priority 3: Code AST Symbols, Concepts & Exact File Pointers (Budget: ~150 tokens)
  const matchedSymbols = searchResults
    .map((s) => s.node)
    .filter((n) => !["rule", "constraint", "decision"].includes(n.kind))
    .slice(0, 4);

  if (matchedSymbols.length > 0 && tokenCount < maxTokenBudget) {
    const symbolLines = matchedSymbols.map((sym) => {
      matchedIds.push(sym.id);
      const lineRange = sym.lineStart ? `:${sym.lineStart}-${sym.lineEnd}` : "";
      return `* [${sym.kind.toUpperCase()}] \`${sym.name}\` -> \`${sym.path}${lineRange}\` (${sym.summary?.slice(0, 100) || "indexed"})`;
    });
    const block = `### Relevant Knowledge Graph Symbols:\n${symbolLines.join("\n")}`;
    tokenCount += estimateTokens(block);
    sections.push(block);
  }

  if (sections.length === 0) {
    return { hasContext: false, tokenEstimate: 0, contextBlock: "", matchedNodeIds: [] };
  }

  const finalContextBlock = [
    `\n<!-- Graphify Knowledge Priming (Pre-Retrieved) -->`,
    sections.join("\n\n"),
    `<!-- End Graphify Context -->\n`,
  ].join("\n");

  return {
    hasContext: true,
    tokenEstimate: estimateTokens(finalContextBlock),
    contextBlock: finalContextBlock,
    matchedNodeIds: matchedIds,
  };
}