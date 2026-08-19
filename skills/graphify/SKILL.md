---
name: graphify
description: Instructions for querying, reading, and exploring codebase symbols, AGENTS.md rules, and ingested documentation using the Graphify knowledge graph.
---

# Graphify Knowledge Graph & Memory Skill

You have access to a deterministic knowledge graph stored in `.pi/knowledge/` and `.pi/graph.json`. It indexes all project code, constitutional rules (`AGENTS.md`), user directives, and external documentation.

---

## 3 Absolute Rules (Never Break)

1. **NEVER use `bash`, `find`, `grep`, or `read` on directories to discover architecture.**
   * ALWAYS call `graphify_query` first.
2. **NEVER pass a URL (`http://` or `https://`) to the `read` tool.**
   * All external docs are saved locally. Use `graphify_read(nodeId: "...")` or read the `Local File Path` returned by `graphify_query`.
3. **NEVER guess code locations or invent file paths.**
   * Look up the symbol with `graphify_query` to obtain the exact file path and line numbers.

---

## Tool Selection Matrix

| If your task is... | Use this tool | Do NOT use |
| :--- | :--- | :--- |
| Answering "How does X work?", "Where is Y defined?", "Explain Z" | `graphify_query` | `read`, `bash`, `find` |
| Reading the full code or full text of a concept / section | `graphify_read` | `read <url>` |
| Ingesting a new web link or GitHub repository | `graphify_add` | `curl`, `wget`, `git clone` |
| Recording a user rule or architectural decision | `graphify_remember` | Writing to text files |
| Rescanning code after making major edits | `graphify_build` | `bash` scripts |

---

## Step-by-Step Execution Workflows

### Workflow A: Answering Questions & Explaining Code/Docs

#### Step 1: Query the Graph
Call `graphify_query` with a single, concise keyword (e.g. "extensions", "auth", "config").

Example call:
```json
{
  "query": "extensions"
}
```

#### Step 2: Evaluate the Output
* **If matches are found**:
  * Note the `Node ID` (e.g. `doc://pi.dev/docs-latest-extensions#customization`) and `Local File Path` (e.g. `.pi/knowledge/docs/pi.dev/docs-latest-extensions.md`).
  * If the summary is sufficient to answer the user, write the response.
  * If you need exact code snippets or complete section text, proceed to **Step 3**.
* **If NO matches are found**:
  * Try a broader, single-word keyword (e.g., if `"pi extensions"` fails, try `"extensions"` or `"plugin"`).

#### Step 3: Read Full Details (If Needed)
Pass the `Node ID` or `Local File Path` to `graphify_read`.

Example call:
```json
{
  "nodeId": "doc://pi.dev/docs-latest-extensions#customization"
}
```

---

### Workflow B: Ingesting External Links or Repositories

When the user asks you to read, ingest, or analyze a URL or GitHub repository:

Example for Web Documentation:
```json
{
  "target": "https://pi.dev/docs/latest/extensions"
}
```

Example for a GitHub Repository:
```json
{
  "target": "https://github.com/Graphify-Labs/graphify"
}
```

---

### Workflow C: Remembering User Rules & Architectural Decisions

When the user gives a permanent rule (e.g., *"Always use pnpm"*), or when you finalize an architecture decision:

Example call:
```json
{
  "title": "Use pnpm only",
  "summary": "Always use pnpm instead of npm or yarn for all package management commands.",
  "kind": "constraint",
  "targets": ["file://package.json"]
}
```

---

## Fallback & Recovery Checklist

* **Issue**: `No matching nodes found for "..."`
  * **Fix**: Reduce search string to a single root word (e.g., change `"authentication middleware system"` to `"auth"`).
* **Issue**: `File not found in workspace or vault`
  * **Fix**: Call `graphify_query(query: "...")` to obtain the current local relative path under `.pi/knowledge/`.
* **Issue**: `Knowledge graph is unindexed`
  * **Fix**: Call `graphify_build(force: true)` to scan the repository.