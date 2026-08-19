---
name: graphify
description: Instructions for exploring code symbols, AGENTS.md rules, architectural decisions, and documentation from the Graphify knowledge graph.
---

# Graphify Knowledge & Memory Skill

The active workspace maintains an in-memory knowledge graph containing:
1. **Constitutional Rules & Constraints (Tier 1)**: From `AGENTS.md` and user directives (decay rate: 0%).
2. **Architectural Decisions (Tier 2)**: Persistent decisions (superseded when newer choices are recorded).
3. **AST Symbols & Ingested Docs**: Code files, classes, functions, and documentation stored in the local vault (`.pi/knowledge/`).

## Directives

1. **Pre-Cognitive Priming Awareness**: Context from `AGENTS.md` and relevant decisions is pre-activated on each turn. Follow all active `[RULE]` and `[CONSTRAINT]` directives strictly.
2. **Two-Tier Retrieval**:
   * Use `graphify_query(query: "...")` for high-level structure and line ranges.
   * Use `graphify_read(nodeId: "...")` to read exact full markdown sections or code slices.
3. **Record Architectural Decisions**: When you make an architectural choice or solve a complex problem, call `graphify_remember` to record the decision in the graph.