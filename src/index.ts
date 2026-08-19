import { join, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { GraphStore } from "./graph-store.js";
import { scanCodebase } from "./code-scanner.js";
import { ingestTarget } from "./doc-ingester.js";
import { generateArtifacts } from "./report-generator.js";
import { MemoryEngine } from "./memory-engine.js";
import { getAssociativePrimedContext } from "./associative-primer.js";
import type { GraphNode } from "./types.js";

export default function (pi: ExtensionAPI) {
  let store: GraphStore | null = null;
  let memoryEngine: MemoryEngine | null = null;

  function getOrInitStore(cwd?: string): { store: GraphStore; memory: MemoryEngine } {
    const root = resolve(cwd || process.cwd());
    const graphFilePath = join(root, ".pi", "graph.json");

    if (!store) store = new GraphStore(graphFilePath);
    if (!memoryEngine) memoryEngine = new MemoryEngine(root);

    return { store, memory: memoryEngine };
  }

  // Session Initialization
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const { store: currentStore, memory } = getOrInitStore(ctx.cwd);

    // Initial rescan if unindexed
    if (!currentStore.isLoaded || currentStore.nodes.length === 0) {
      const rootDir = ctx.cwd || process.cwd();
      const graph = await scanCodebase(rootDir);
      currentStore.setGraph(graph);
    }

    // Decay stale ephemeral memories
    memory.decayEphemeralMemories(currentStore);

    const summary = currentStore.getSummary();
    const rules = currentStore.nodes.filter((n) => n.kind === "rule" || n.kind === "constraint");
    ctx.ui.setStatus("graphify", `Graph: ${summary.totalNodes} nodes (${rules.length} rules)`);
  });

  // Pre-Cognitive Associative Priming Interceptor (Zero-Turn Retrieval)
  pi.on("turn_start", async (event: any, ctx: ExtensionContext) => {
    const { store: currentStore } = getOrInitStore(ctx.cwd);
    const userPrompt = typeof event?.prompt === "string" ? event.prompt : "";

    if (userPrompt && currentStore.isLoaded) {
      const primed = getAssociativePrimedContext(userPrompt, currentStore, 400);

      if (primed.hasContext) {
        ctx.ui.notify(`[Associative Priming] Activated ${primed.matchedNodeIds.length} graph/rule nodes (~${primed.tokenEstimate} tokens).`, "info");
      }
    }
  });

  // Turn End: Automatic Background Memory Capture
  pi.on("turn_end", async (event: any, ctx: ExtensionContext) => {
    const { store: currentStore, memory } = getOrInitStore(ctx.cwd);
    const userPrompt = typeof event?.prompt === "string" ? event.prompt : "";
    const assistantResponse = typeof event?.response === "string" ? event.response : "";

    if (userPrompt && assistantResponse) {
      const { nodes, edges } = memory.extractTurnMemories(userPrompt, assistantResponse);

      if (nodes.length > 0) {
        for (const node of nodes) {
          if (node.kind === "decision") memory.handleSupersession(node, currentStore);
        }

        const { addedNodes } = currentStore.mergeGraph(nodes, edges);
        if (addedNodes > 0) {
          ctx.ui.notify(`[Memory Engine] Recorded ${addedNodes} new memory nodes.`, "info");
          ctx.ui.setStatus("graphify", `Graph: ${currentStore.nodes.length} nodes`);
        }
      }
    }
  });

  // TOOL 1: Build / Rescan Codebase
  pi.registerTool({
    name: "graphify_build",
    label: "Build Knowledge Graph",
    description: "Indexes repository AST, AGENTS.md rules, and schemas into a queryable knowledge graph.",
    parameters: Type.Object({
      force: Type.Optional(Type.Boolean({ description: "Force re-indexing" })),
    }),
    execute: async (_toolCallId, params, _signal, _update, ctx) => {
      const { store: currentStore } = getOrInitStore(ctx.cwd);
      const rootDir = ctx.cwd || process.cwd();

      if (currentStore.isLoaded && currentStore.nodes.length > 0 && !params.force) {
        return {
          content: [{ type: "text", text: `Graph already built with ${currentStore.nodes.length} nodes. Pass force=true to rebuild.` }],
          details: { nodeCount: currentStore.nodes.length, edgeCount: currentStore.edges.length, rebuilt: false },
        };
      }

      ctx.ui.notify("Indexing repository codebase & AGENTS.md rules...", "info");
      const graph = await scanCodebase(rootDir);
      currentStore.setGraph(graph);

      const outDir = join(rootDir, "graphify-out");
      generateArtifacts(currentStore, outDir);
      ctx.ui.setStatus("graphify", `Graph: ${currentStore.nodes.length} nodes`);

      const summary = currentStore.getSummary();
      return {
        content: [{ type: "text", text: `Knowledge graph generated: ${summary.totalNodes} nodes (${summary.kinds["rule"] || 0} rules, ${summary.totalEdges} edges).` }],
        details: summary,
      };
    },
  });

  // TOOL 2: Add Document / GitHub Repo
  pi.registerTool({
    name: "graphify_add",
    label: "Add Document or Repo to Knowledge Graph",
    description: "Fetches and saves documentation or GitHub repositories into the local vault (.pi/knowledge/) and indexes symbols.",
    parameters: Type.Object({
      target: Type.String({ description: "The HTTP/HTTPS URL, GitHub repo URL, or local file path" }),
    }),
    execute: async (_toolCallId, params, _signal, _update, ctx) => {
      const { store: currentStore } = getOrInitStore(ctx.cwd);
      const targetStr = params.target?.trim() ?? "";
      const rootDir = ctx.cwd || process.cwd();

      if (!targetStr) {
        return { content: [{ type: "text", text: "Target cannot be empty." }], details: { error: "EMPTY_TARGET" } };
      }

      try {
        ctx.ui.notify(`Ingesting ${targetStr}...`, "info");
        const docResult = await ingestTarget(targetStr, rootDir);
        const { addedNodes, addedEdges } = currentStore.mergeGraph(docResult.nodes, docResult.edges);

        generateArtifacts(currentStore, join(rootDir, "graphify-out"));
        ctx.ui.setStatus("graphify", `Graph: ${currentStore.nodes.length} nodes`);

        return {
          content: [
            {
              type: "text",
              text: [
                `Successfully ingested "${docResult.title}":`,
                `- Saved locally to: \`${docResult.savedPath}\``,
                `- Added: ${addedNodes} nodes and ${addedEdges} connections.`,
              ].join("\n"),
            },
          ],
          details: { title: docResult.title, savedPath: docResult.savedPath, addedNodes, totalNodes: currentStore.nodes.length },
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Failed to ingest target: ${err.message}` }], details: { error: err.message } };
      }
    },
  });

  // TOOL 3: Explicit Memory Registration
  pi.registerTool({
    name: "graphify_remember",
    label: "Record Architectural Decision or Rule",
    description: "Explicitly records a persistent architectural decision, user constraint, or plan in the knowledge graph.",
    parameters: Type.Object({
      title: Type.String({ description: "Short title of the rule, decision, or fact" }),
      summary: Type.String({ description: "Complete explanation or directive" }),
      kind: Type.Union([Type.Literal("constraint"), Type.Literal("decision"), Type.Literal("plan"), Type.Literal("fact")]),
      targets: Type.Optional(Type.Array(Type.String({ description: "Target file paths or symbol IDs that this memory governs" }))),
    }),
    execute: async (_toolCallId, params, _signal, _update, ctx) => {
      const { store: currentStore, memory } = getOrInitStore(ctx.cwd);
      const slug = encodeURIComponent(params.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
      const id = `${params.kind}://custom/${slug}-${Date.now().toString().slice(-4)}`;

      const newNode: GraphNode = {
        id,
        name: params.title,
        kind: params.kind,
        path: ".pi/knowledge/memory/memory.json",
        tier: params.kind === "constraint" ? 1 : 2,
        decayable: false,
        summary: params.summary,
        createdAt: new Date().toISOString(),
      };

      if (params.kind === "decision") memory.handleSupersession(newNode, currentStore);

      const newEdges = (params.targets || []).map((tgt) => ({
        source: id,
        target: tgt.startsWith("file://") ? tgt : `file://${tgt}`,
        relation: "governs" as const,
        provenance: "USER_STATED" as const,
      }));

      currentStore.mergeGraph([newNode], newEdges);
      ctx.ui.setStatus("graphify", `Graph: ${currentStore.nodes.length} nodes`);

      return {
        content: [{ type: "text", text: `Recorded [${params.kind.toUpperCase()}] "${params.title}" into the knowledge graph.` }],
        details: { nodeId: id },
      };
    },
  });

  // TOOL 4: Query Knowledge Graph
  pi.registerTool({
    name: "graphify_query",
    label: "Query Knowledge Graph",
    description: "Searches symbols, documentation, rules, and decisions in the knowledge graph. Returns summaries, line numbers, and local paths.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query for symbols, concepts, rules, or topics" }),
      depth: Type.Optional(Type.Number({ description: "Traversal depth", default: 1 })),
    }),
    execute: async (_toolCallId, params, _signal, _update, ctx) => {
      const { store: currentStore } = getOrInitStore(ctx.cwd);

      if (!currentStore.isLoaded || currentStore.nodes.length === 0) {
        return { content: [{ type: "text", text: "Knowledge graph is unindexed. Run `graphify_build` first." }], details: { error: "NOT_INDEXED" } };
      }

      const queryStr = params.query?.trim() ?? "";
      if (!queryStr) {
        return { content: [{ type: "text", text: "Query cannot be empty." }], details: { error: "EMPTY_QUERY" } };
      }

      const searchResults = currentStore.searchNodes(queryStr, 6);
      if (searchResults.length === 0) {
        return { content: [{ type: "text", text: `No matching nodes found for "${queryStr}".` }], details: { matches: [] } };
      }

      const formattedResults = searchResults.map(({ node, score }) => {
        const neighbors = currentStore.getNodeNeighbors(node.id, params.depth ?? 1);
        const outList = neighbors?.outbound.map((o) => `    -> [${o.relation}] ${o.target.name || o.target.id} (${o.target.kind})`).join("\n") || "    (none)";
        const inList = neighbors?.inbound.map((i) => `    <- [${i.relation}] ${i.source.name || i.source.id} (${i.source.kind})`).join("\n") || "    (none)";
        const linesInfo = node.lineStart ? ` (Lines: ${node.lineStart}-${node.lineEnd})` : "";

        return [
          `### [${node.kind.toUpperCase()}] ${node.name} (Tier ${node.tier || "Standard"}, Score: ${score})`,
          `Node ID: \`${node.id}\``,
          `Local File Path: \`${node.path}\`${linesInfo}`,
          node.summary ? `Summary: ${node.summary}` : "",
          `Connections:`,
          `  Outbound:`,
          outList,
          `  Inbound:`,
          inList,
        ].filter(Boolean).join("\n");
      });

      return {
        content: [{ type: "text", text: formattedResults.join("\n\n---\n\n") }],
        details: { matchCount: searchResults.length, topNodeId: searchResults[0].node.id },
      };
    },
  });

  // TOOL 5: Read Node Content
  pi.registerTool({
    name: "graphify_read",
    label: "Read Knowledge Node Content",
    description: "Reads the full Markdown section, code, or documentation slice corresponding to a specific node ID or local path.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "The node ID or local file path to read" }),
    }),
    execute: async (_toolCallId, params, _signal, _update, ctx) => {
      const { store: currentStore } = getOrInitStore(ctx.cwd);
      const rootDir = ctx.cwd || process.cwd();
      const target = params.nodeId.trim();

      const matchedNode = currentStore.nodes.find((n) => n.id === target || n.path === target);
      const filePath = matchedNode ? matchedNode.path : target;
      const absFilePath = resolve(rootDir, filePath);

      if (!existsSync(absFilePath)) {
        return { content: [{ type: "text", text: `File not found: ${filePath}` }], details: { error: "FILE_NOT_FOUND" } };
      }

      try {
        const fullContent = readFileSync(absFilePath, "utf-8");
        const lines = fullContent.split("\n");

        if (matchedNode && matchedNode.lineStart && matchedNode.lineEnd) {
          const slice = lines.slice(matchedNode.lineStart - 1, matchedNode.lineEnd).join("\n");
          return {
            content: [{ type: "text", text: `## ${matchedNode.name} (${matchedNode.path}:${matchedNode.lineStart}-${matchedNode.lineEnd})\n\n${slice}` }],
            details: { path: matchedNode.path, lines: [matchedNode.lineStart, matchedNode.lineEnd] },
          };
        }

        return { content: [{ type: "text", text: fullContent }], details: { path: filePath, totalLines: lines.length } };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error reading file: ${err.message}` }], details: { error: err.message } };
      }
    },
  });

  // Slash Command: /graphify
  pi.registerCommand("graphify", {
    description: "Graphify Knowledge & Memory Manager (add, rebuild, remember, rules, report)",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const { store: currentStore, memory } = getOrInitStore(ctx.cwd);
      const rootDir = ctx.cwd || process.cwd();

      // /graphify remember <text>
      if (trimmed.startsWith("remember ")) {
        const text = trimmed.slice(9).trim();
        const slug = encodeURIComponent(text.slice(0, 25).toLowerCase().replace(/[^a-z0-9]+/g, "-"));
        const id = `constraint://user/${slug}-${Date.now().toString().slice(-4)}`;

        currentStore.mergeGraph([
          {
            id,
            name: `User Rule: ${text.slice(0, 35)}`,
            kind: "constraint",
            path: ".pi/knowledge/memory/memory.json",
            tier: 1,
            decayable: false,
            summary: text,
            createdAt: new Date().toISOString(),
          },
        ], []);

        ctx.ui.setStatus("graphify", `Graph: ${currentStore.nodes.length} nodes`);
        ctx.ui.notify(`Remembered permanent constraint: "${text}"`, "info");
        return;
      }

      // /graphify rules
      if (trimmed === "rules") {
        const rules = currentStore.nodes.filter((n) => n.kind === "rule" || n.kind === "constraint");
        ctx.ui.notify(`Active Rules (${rules.length}):\n` + rules.map((r) => `- [${r.kind.toUpperCase()}] ${r.name}: ${r.summary}`).join("\n"), "info");
        return;
      }

      // /graphify add <target>
      if (trimmed.startsWith("add ")) {
        const target = trimmed.slice(4).trim();
        ctx.ui.notify(`Ingesting ${target}...`, "info");
        try {
          const res = await ingestTarget(target, rootDir);
          const { addedNodes, addedEdges } = currentStore.mergeGraph(res.nodes, res.edges);
          generateArtifacts(currentStore, join(rootDir, "graphify-out"));
          ctx.ui.setStatus("graphify", `Graph: ${currentStore.nodes.length} nodes`);
          ctx.ui.notify(`Ingested "${res.title}": +${addedNodes} nodes, +${addedEdges} edges.`, "info");
        } catch (err: any) {
          ctx.ui.notify(`Failed: ${err.message}`, "error");
        }
        return;
      }

      // /graphify rebuild
      if (trimmed === "rebuild" || !currentStore.isLoaded || currentStore.nodes.length === 0) {
        ctx.ui.notify("Rebuilding graph & AGENTS.md rules...", "info");
        const graph = await scanCodebase(rootDir);
        currentStore.setGraph(graph);
        const artifacts = generateArtifacts(currentStore, join(rootDir, "graphify-out"));
        ctx.ui.setStatus("graphify", `Graph: ${graph.nodes.length} nodes`);
        ctx.ui.notify(`Graph built: ${graph.nodes.length} nodes. Report: ${artifacts.reportPath}`, "info");
        return;
      }

      const summary = currentStore.getSummary();
      ctx.ui.notify(`Knowledge Graph: ${summary.totalNodes} nodes, ${summary.totalEdges} edges, ${summary.totalCommunities} communities.`, "info");
    },
  });
}