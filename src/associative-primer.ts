import type { GraphStore } from "./graph-store.js";

export interface PrimedContextResult {
  hasContext: boolean;
  tokenEstimate: number;
  contextBlock: string;
  matchedNodeIds: string[];
}

export function getAssociativePrimedContext(
  userPrompt: string,
  store: GraphStore,
  maxDynamicBudget = 400
): PrimedContextResult {
  const sections: string[] = [];
  let tokenCount = 0;
  const matchedIds: string[] = [];

  const estimateTokens = (text: string) => Math.ceil(text.length / 4);

  // 1. BASELINE: Always inject all active constitutional rules
  const constitutionalRules = store.nodes.filter(
    (n) => (n.kind === "rule" || n.kind === "constraint") && n.tier === 1
  );

  if (constitutionalRules.length > 0) {
    const ruleLines = constitutionalRules.map((r) => {
      matchedIds.push(r.id);
      return `- Rule: ${r.summary || r.name}`;
    });
    const block = `## Active Rules to follow:\n${ruleLines.join("\n")}`;
    tokenCount += estimateTokens(block);
    sections.push(block);
  }

  // 2. DYNAMIC: Search for related decisions, files, and docs
  const query = userPrompt?.trim() || "";
  const isTrivial = !query || query.length < 3 || /^(hi|hello|thanks|thank you|ok|yes|no)$/i.test(query);

  if (!isTrivial && store.isLoaded) {
    const searchResults = store.searchNodes(query, 8);

    // Prior Decisions & Notes
    const matchedDecisions = searchResults
      .map((s) => s.node)
      .filter((n) => (n.kind === "decision" || n.kind === "fact") && !n.supersededBy)
      .slice(0, 3);

    if (matchedDecisions.length > 0 && tokenCount < maxDynamicBudget) {
      const decisionLines = matchedDecisions.map((d) => {
        matchedIds.push(d.id);
        return `- ${d.name}: ${d.summary}`;
      });
      const block = `## Previous decisions and notes:\n${decisionLines.join("\n")}`;
      tokenCount += estimateTokens(block);
      sections.push(block);
    }

    // Relevant Files & Symbols
    const matchedSymbols = searchResults
      .map((s) => s.node)
      .filter((n) => !["rule", "constraint", "decision", "fact"].includes(n.kind))
      .slice(0, 4);

    if (matchedSymbols.length > 0 && tokenCount < maxDynamicBudget) {
      const symbolLines = matchedSymbols.map((sym) => {
        matchedIds.push(sym.id);
        const lineRange = sym.lineStart ? ` (lines ${sym.lineStart}-${sym.lineEnd})` : "";
        return `- ${sym.name} in file: \`${sym.path}\`${lineRange}`;
      });
      const block = `## Files found in knowledge graph:\n${symbolLines.join("\n")}\nUse \`graphify_read\` to read any of these files.`;
      tokenCount += estimateTokens(block);
      sections.push(block);
    }
  }

  if (sections.length === 0) {
    return { hasContext: false, tokenEstimate: 0, contextBlock: "", matchedNodeIds: [] };
  }

  const finalContextBlock = [
    `# Knowledge Graph Context`,
    sections.join("\n\n"),
  ].join("\n");

  return {
    hasContext: true,
    tokenEstimate: estimateTokens(finalContextBlock),
    contextBlock: finalContextBlock,
    matchedNodeIds: matchedIds,
  };
}