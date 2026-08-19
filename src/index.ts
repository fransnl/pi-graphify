import { join, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { GraphNode } from "./types.js";
import { GraphStore } from "./graph-store.js";
import { scanCodebase } from "./code-scanner.js";
import { ingestTarget } from "./doc-ingester.js";
import { generateArtifacts } from "./report-generator.js";
import { MemoryEngine } from "./memory-engine.js";
import { getAssociativePrimedContext } from "./associative-primer.js";

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

  // Session Start
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const { store: currentStore, memory } = getOrInitStore(ctx.cwd);

    if (!currentStore.isLoaded || currentStore.nodes.length === 0) {
      const rootDir = ctx.cwd || process.cwd();
      const graph = await scanCodebase(rootDir);
      currentStore.setGraph(graph);
    }

    memory.decayEphemeralMemories(currentStore);

    const summary = currentStore.getSummary();
    const rules = currentStore.nodes.filter((n) => n.kind === "rule" || n.kind === "constraint");
    ctx.ui.setStatus("graphify", `Graph: ${summary.totalNodes} nodes (${rules.length} rules)`);
  });

  // Inject Knowledge and Rules into System Prompt
  pi.on("before_agent_start", async (event: any, ctx: ExtensionContext) => {
    const { store: currentStore } = getOrInitStore(ctx.cwd);
    const baseSystemPrompt = event?.systemPrompt || "";
    const userPrompt = typeof event?.prompt === "string" ? event.prompt : "";

    if (!currentStore.isLoaded) {
      return { systemPrompt: baseSystemPrompt };
    }

    const primed = getAssociativePrimedContext(userPrompt, currentStore, 500);

    if (primed.hasContext) {
      return {
        systemPrompt: `${baseSystemPrompt}\n\n${primed.contextBlock}`,
      };
    }

    return { systemPrompt: baseSystemPrompt };
  });

  // Automatic Background Memory Capture
  pi.on("agent_end", async (event: any, ctx: ExtensionContext) => {
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
          memory.saveMemories(currentStore.nodes);
          ctx.ui.setStatus("graphify", `Graph: ${currentStore.nodes.length} nodes`);
        }
      }
    }
  });

  // TOOL 1: graphify_query
  pi.registerTool({
    name: "graphify_query",
    label: "Query Knowledge Graph",
    description: "Queries the knowledge graph for information. Returns the path to the file that contains the information, line numbers, and summaries.",
    parameters: Type.Object({
      query: Type.String({ description: "The keyword or phrase to search for in the knowledge graph." }),
      depth: Type.Optional(Type.Number({ description: "How many connection hops to explore. Default is 1.", default: 1 })),
    }),
    execute: async (_toolCallId, params, _signal, _update, ctx) => {
      const { store: currentStore } = getOrInitStore(ctx.cwd);

      if (!currentStore.isLoaded || currentStore.nodes.length === 0) {
        return {
          content: [{ type: "text", text: "The knowledge graph is empty. Use `graphify_build` to index the project." }],
          details: { error: "NOT_INDEXED" },
        };
      }

      const queryStr = params.query?.trim() ?? "";
      if (!queryStr) {
        return {
          content: [{ type: "text", text: "Please provide a search keyword." }],
          details: { error: "EMPTY_QUERY" },
        };
      }

      const searchResults = currentStore.searchNodes(queryStr, 6);
      if (searchResults.length === 0) {
        return {
          content: [{ type: "text", text: `No information found for "${queryStr}". Try searching for a simpler keyword, or use graphify_add if you need to fetch external documentation.` }],
          details: { matches: [] },
        };
      }

      const formattedResults = searchResults.map(({ node }) => {
        const linesInfo = node.lineStart ? ` (lines ${node.lineStart}-${node.lineEnd})` : "";
        return [
          `- Name: ${node.name}`,
          `  Type: ${node.kind}`,
          `  File path: ${node.path}${linesInfo}`,
          node.summary ? `  Summary: ${node.summary}` : "",
          `  To read this file: use graphify_read with nodeId "${node.id}" or path "${node.path}"`,
        ].filter(Boolean).join("\n");
      });

      return {
        content: [
          {
            type: "text",
            text: `Found information in the knowledge graph:\n\n${formattedResults.join("\n\n")}`,
          },
        ],
        details: { matchCount: searchResults.length, topNodeId: searchResults[0].node.id },
      };
    },
  });

  // TOOL 2: graphify_read
  pi.registerTool({
    name: "graphify_read",
    label: "Read File from Knowledge Graph",
    description: "Reads a file or a section of a file from the knowledge graph.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "The file path or node ID to read." }),
    }),
    execute: async (_toolCallId, params, _signal, _update, ctx) => {
      const { store: currentStore } = getOrInitStore(ctx.cwd);
      const rootDir = ctx.cwd || process.cwd();
      const target = params.nodeId.trim();

      const matchedNode = currentStore.nodes.find((n) => n.id === target || n.path === target);
      const filePath = matchedNode ? matchedNode.path : target;
      const absFilePath = resolve(rootDir, filePath);

      if (!existsSync(absFilePath)) {
        return {
          content: [{ type: "text", text: `File not found: "${filePath}". Use graphify_query to find the correct file path.` }],
          details: { error: "FILE_NOT_FOUND" },
        };
      }

      try {
        const fullContent = readFileSync(absFilePath, "utf-8");
        const lines = fullContent.split("\n");

        if (matchedNode && matchedNode.lineStart && matchedNode.lineEnd) {
          const slice = lines.slice(matchedNode.lineStart - 1, matchedNode.lineEnd).join("\n");
          return {
            content: [{ type: "text", text: slice }],
            details: { path: matchedNode.path, lines: [matchedNode.lineStart, matchedNode.lineEnd] },
          };
        }

        return {
          content: [{ type: "text", text: fullContent }],
          details: { path: filePath, totalLines: lines.length },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error reading file: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });

  // TOOL 3: graphify_add
  pi.registerTool({
    name: "graphify_add",
    label: "Add Website or Repository",
    description: "Fetches a website URL or clones a GitHub repository and adds its information to the knowledge graph.",
    parameters: Type.Object({
      target: Type.String({ description: "The website URL, GitHub repository URL, or local file path to add." }),
    }),
    execute: async (_toolCallId, params, _signal, _update, ctx) => {
      const { store: currentStore } = getOrInitStore(ctx.cwd);
      const targetStr = params.target?.trim() ?? "";
      const rootDir = ctx.cwd || process.cwd();

      if (!targetStr) {
        return {
          content: [{ type: "text", text: "Please provide a website URL or repository URL to add." }],
          details: { error: "EMPTY_TARGET" },
        };
      }

      try {
        ctx.ui.notify(`Adding ${targetStr} to knowledge graph...`, "info");
        const docResult = await ingestTarget(targetStr, rootDir);
        const { addedNodes, addedEdges } = currentStore.mergeGraph(docResult.nodes, docResult.edges);

        generateArtifacts(currentStore, join(rootDir, "graphify-out"));
        ctx.ui.setStatus("graphify", `Graph: ${currentStore.nodes.length} nodes`);

        return {
          content: [
            {
              type: "text",
              text: `Successfully added "${docResult.title}" to the knowledge graph (${addedNodes} new items saved to ${docResult.savedPath}). You can now use graphify_query to search for information from it.`,
            },
          ],
          details: { title: docResult.title, savedPath: docResult.savedPath, addedNodes, totalNodes: currentStore.nodes.length },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Failed to add target: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });

  // TOOL 4: graphify_remember
  pi.registerTool({
    name: "graphify_remember",
    label: "Save Rule or Decision to Memory",
    description: "Saves a rule, instruction, plan, decision, or note to your memory in the knowledge graph.",
    parameters: Type.Object({
      title: Type.String({ description: "Short title of the instruction, rule, or decision." }),
      summary: Type.String({ description: "The full rule, instruction, plan, or note to remember." }),
      kind: Type.Union([
        Type.Literal("constraint"),
        Type.Literal("decision"),
        Type.Literal("plan"),
        Type.Literal("fact"),
      ], { description: "The type: 'constraint' for rules/instructions, 'decision' for architecture choices, 'plan' for plans/steps, 'fact' for notes/facts." }),
      targets: Type.Optional(Type.Array(Type.String({ description: "Optional file paths related to this memory." }))),
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
      memory.saveMemories(currentStore.nodes);
      ctx.ui.setStatus("graphify", `Graph: ${currentStore.nodes.length} nodes`);

      return {
        content: [{ type: "text", text: `Successfully saved "${params.title}" to memory.` }],
        details: { nodeId: id },
      };
    },
  });

  // TOOL 5: graphify_build
  pi.registerTool({
    name: "graphify_build",
    label: "Rebuild Knowledge Graph",
    description: "Rebuilds the knowledge graph for the repository. Use this after making major code changes or when instructed.",
    parameters: Type.Object({
      force: Type.Optional(Type.Boolean({ description: "Set to true to force rebuilding the knowledge graph." })),
    }),
    execute: async (_toolCallId, params, _signal, _update, ctx) => {
      const { store: currentStore } = getOrInitStore(ctx.cwd);
      const rootDir = ctx.cwd || process.cwd();

      if (currentStore.isLoaded && currentStore.nodes.length > 0 && !params.force) {
        return {
          content: [{ type: "text", text: `Knowledge graph is already built (${currentStore.nodes.length} items). Pass force: true if you want to force a full rebuild.` }],
          details: { nodeCount: currentStore.nodes.length, edgeCount: currentStore.edges.length, rebuilt: false },
        };
      }

      ctx.ui.notify("Rebuilding knowledge graph...", "info");
      const graph = await scanCodebase(rootDir);
      currentStore.setGraph(graph);

      const outDir = join(rootDir, "graphify-out");
      generateArtifacts(currentStore, outDir);
      ctx.ui.setStatus("graphify", `Graph: ${currentStore.nodes.length} nodes`);

      const summary = currentStore.getSummary();
      return {
        content: [{ type: "text", text: `Knowledge graph successfully rebuilt with ${summary.totalNodes} items.` }],
        details: summary,
      };
    },
  });

  // Slash Command: /graphify
  pi.registerCommand("graphify", {
    description: "Manage the knowledge graph (remember, rules, add, rebuild)",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const { store: currentStore, memory } = getOrInitStore(ctx.cwd);
      const rootDir = ctx.cwd || process.cwd();

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

        memory.saveMemories(currentStore.nodes);
        ctx.ui.setStatus("graphify", `Graph: ${currentStore.nodes.length} nodes`);
        ctx.ui.notify(`Saved rule to memory: "${text}"`, "info");
        return;
      }

      if (trimmed === "rules") {
        const rules = currentStore.nodes.filter((n) => n.kind === "rule" || n.kind === "constraint");
        ctx.ui.notify(`Active Rules (${rules.length}):\n` + rules.map((r) => `- [${r.kind.toUpperCase()}] ${r.name}: ${r.summary}`).join("\n"), "info");
        return;
      }

      if (trimmed.startsWith("add ")) {
        const target = trimmed.slice(4).trim();
        ctx.ui.notify(`Adding ${target}...`, "info");
        try {
          const res = await ingestTarget(target, rootDir);
          const { addedNodes, addedEdges } = currentStore.mergeGraph(res.nodes, res.edges);
          generateArtifacts(currentStore, join(rootDir, "graphify-out"));
          ctx.ui.setStatus("graphify", `Graph: ${currentStore.nodes.length} nodes`);
          ctx.ui.notify(`Added "${res.title}" (+${addedNodes} items)`, "info");
        } catch (err: any) {
          ctx.ui.notify(`Failed: ${err.message}`, "error");
        }
        return;
      }

      if (trimmed === "rebuild" || !currentStore.isLoaded || currentStore.nodes.length === 0) {
        ctx.ui.notify("Rebuilding knowledge graph...", "info");
        const graph = await scanCodebase(rootDir);
        currentStore.setGraph(graph);
        const artifacts = generateArtifacts(currentStore, join(rootDir, "graphify-out"));
        ctx.ui.setStatus("graphify", `Graph: ${graph.nodes.length} nodes`);
        ctx.ui.notify(`Knowledge graph rebuilt (${graph.nodes.length} items). Report saved to ${artifacts.reportPath}`, "info");
        return;
      }

      const summary = currentStore.getSummary();
      ctx.ui.notify(`Knowledge Graph: ${summary.totalNodes} items, ${summary.totalEdges} connections.`, "info");
    },
  });
}