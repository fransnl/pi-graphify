---
name: graphify
description: Instructions on how to explore, navigate, and query the codebase and ingested documentation using the Graphify knowledge graph.
---

# Graphify Knowledge Graph Skill

This workspace maintains a structured knowledge graph containing code AST symbols (classes, functions, database schemas, routes) and ingested documentation (APIs, concepts, summaries) with directional relationships (`imports`, `calls`, `defines`, `references`, `depends_on`).

## Decision Heuristics

1. **Query Before File Reading**: Whenever asked to explain concepts, locate architecture, find dependencies, or inspect documentation, **always** call `graphify_query` before using `read`, `find`, or `bash`.
2. **Concept Lookups**: Do not attempt to read whole documentation trees or repository folders to understand high-level features. The knowledge graph contains distilled semantic summaries for every indexed topic.
3. **Dependency and Blast-Radius Analysis**: Use `graphify_trace` to compute exact connection paths between symbols rather than manually tracing imports across multiple files.

---

## Tool Reference

### 1. `graphify_query(query: string, depth?: number)`
Searches symbol names, documentation summaries, and paths, returning matching nodes and their inbound/outbound connections.
* **When to use**: Answering "How does X work?", "Where is Y defined?", "What depends on Z?".
* **Example**: `graphify_query(query: "extensions")`

### 2. `graphify_trace(source: string, target: string)`
Computes the shortest dependency or reference chain connecting two symbols.
* **When to use**: Finding how a frontend route reaches a database model, or tracing call chains across services.
* **Example**: `graphify_trace(source: "AuthMiddleware", target: "users_table")`

### 3. `graphify_add(target: string)`
Fetches and indexes remote documentation URLs or local markdown/text files.
* **When to use**: When new web documentation or external guides need to be ingested into the active knowledge graph.
* **Example**: `graphify_add(target: "https://pi.dev/docs/latest/extensions")`

### 4. `graphify_build(force?: boolean)`
Performs an AST rescan of the workspace repository.
* **When to use**: When significant code modifications have been made and the graph needs to be synchronized.
* **Example**: `graphify_build(force: true)`

---

## Standard Workflow Example

When asked: *"Explain pi extensions."*

1. **Step 1**: Call `graphify_query(query: "extensions")`.
2. **Step 2**: Inspect the matched `doc` or `concept` nodes and their summaries.
3. **Step 3**: If a concept references specific APIs (e.g. `api://registerTool`), query `graphify_query(query: "registerTool")` to inspect parameters and usage.
4. **Step 4**: Synthesize the final answer directly using the structured graph data without executing raw file reads.