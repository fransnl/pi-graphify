import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { GraphStore } from "./graph-store.js";
import { scanCodebase } from "./code-scanner.js";
import { ingestTarget } from "./doc-ingester.js";
import { generateArtifacts } from "./report-generator.js";

export default function (pi: ExtensionAPI) {
  let store: GraphStore | null = null;

  function getOrInitStore(cwd?: string): GraphStore {
    const root = resolve(cwd || process.cwd());
    const graphFilePath = join(root, ".pi", "graph.json");

    if (!store) {
      store = new GraphStore(graphFilePath);
    }
    return store;
  }

  // Session Initialization
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const currentStore = getOrInitStore(ctx.cwd);

    if (currentStore.isLoaded && currentStore.nodes.length > 0) {
      ctx.ui.setStatus("graphify", `Graph: ${currentStore.nodes.length} nodes`);
    } else {
      ctx.ui.setStatus("graphify", "Graph: unindexed");
    }
  });

  // TOOL 1: Build / Rescan Codebase
  pi.registerTool({
    name: "graphify_build",
    label: "Build Knowledge Graph",
    description: "Indexes repository AST, schemas, routes, and configs into a queryable knowledge graph and outputs report artifacts.",
    parameters: Type.Object({
      force: Type.Optional(Type.Boolean({ description: "Force full re-indexing of codebase" })),
    }),
    execute: async (_toolCallId, params, _signal, _update, ctx) => {
      const currentStore = getOrInitStore(ctx.cwd);
      const rootDir = ctx.cwd || process.cwd();

      if (currentStore.isLoaded && currentStore.nodes.length > 0 && !params.force) {
        return {
          content: [
            {
              type: "text",
              text: `Graph already built with ${currentStore.nodes.length} nodes and ${currentStore.edges.length} connections. Pass force=true to rebuild.`,
            },
          ],
          details: { nodeCount: currentStore.nodes.length, edgeCount: currentStore.edges.length, rebuilt: false },
        };
      }

      ctx.ui.notify("Indexing repository codebase into knowledge graph...", "info");
      const graph = await scanCodebase(rootDir);
      currentStore.setGraph(graph);

      // Export Graphify artifacts (graph.json, GRAPH_REPORT.md, graph.html)
      const outDir = join(rootDir, "graphify-out");
      const artifacts = generateArtifacts(currentStore, outDir);

      ctx.ui.setStatus("graphify", `Graph: ${currentStore.nodes.length} nodes`);
      const summary = currentStore.getSummary();

      return {
        content: [
          {
            type: "text",
            text: [
              `Knowledge graph successfully generated.`,
              `- Nodes: ${summary.totalNodes}`,
              `- Edges: ${summary.totalEdges}`,
              `- Communities: ${summary.totalCommunities}`,
              `- Artifacts generated in: ${outDir}`,
              `  * ${artifacts.jsonPath}`,
              `  * ${artifacts.reportPath}`,
              `  * ${artifacts.htmlPath}`,
            ].join("\n"),
          },
        ],
        details: summary,
      };
    },
  });

  // TOOL 2: Add Document / URL
  pi.registerTool({
    name: "graphify_add",
    label: "Add Document to Knowledge Graph",
    description: "Fetches and indexes remote documentation URLs or local markdown/text files into the knowledge graph.",
    parameters: Type.Object({
      target: Type.String({ description: "The HTTP/HTTPS URL or local filepath to ingest" }),
    }),
    execute: async (_toolCallId, params, _signal, _update, ctx) => {
      const currentStore = getOrInitStore(ctx.cwd);
      const targetStr = params.target?.trim() ?? "";

      if (!targetStr) {
        return {
          content: [{ type: "text", text: "Target URL or path cannot be empty." }],
          details: { error: "EMPTY_TARGET" },
        };
      }

      try {
        ctx.ui.notify(`Ingesting ${targetStr}...`, "info");
        const docResult = await ingestTarget(targetStr);
        const { addedNodes, addedEdges } = currentStore.mergeGraph(docResult.nodes, docResult.edges);

        // Update artifacts
        const rootDir = ctx.cwd || process.cwd();
        generateArtifacts(currentStore, join(rootDir, "graphify-out"));

        ctx.ui.setStatus("graphify", `Graph: ${currentStore.nodes.length} nodes`);

        return {
          content: [
            {
              type: "text",
              text: `Ingested "${docResult.title}": added ${addedNodes} concept/doc nodes and ${addedEdges} connections to the graph.`,
            },
          ],
          details: { title: docResult.title, addedNodes, addedEdges, totalNodes: currentStore.nodes.length },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Failed to ingest target: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });

  // TOOL 3: Query Knowledge Graph
  pi.registerTool({
    name: "graphify_query",
    label: "Query Knowledge Graph",
    description: "Queries symbols, documentation, concepts, and relationships in the knowledge graph.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query for symbol names, concepts, or topics" }),
      depth: Type.Optional(Type.Number({ description: "Traversal depth for neighborhood queries", default: 1 })),
    }),
    execute: async (_toolCallId, params, _signal, _update, ctx) => {
      const currentStore = getOrInitStore(ctx.cwd);

      if (!currentStore.isLoaded || currentStore.nodes.length === 0) {
        return {
          content: [{ type: "text", text: "Knowledge graph is unindexed. Run `graphify_build` first." }],
          details: { error: "NOT_INDEXED" },
        };
      }

      const queryStr = params.query?.trim() ?? "";
      if (!queryStr) {
        return {
          content: [{ type: "text", text: "Query cannot be empty." }],
          details: { error: "EMPTY_QUERY" },
        };
      }

      const searchResults = currentStore.searchNodes(queryStr, 6);

      if (searchResults.length === 0) {
        return {
          content: [{ type: "text", text: `No matching nodes found for "${queryStr}".` }],
          details: { matches: [] },
        };
      }

      const formattedResults = searchResults.map(({ node, score }) => {
        const neighbors = currentStore.getNodeNeighbors(node.id, params.depth ?? 1);
        const outList = neighbors?.outbound.map((o) => `    -> [${o.relation}] ${o.target.name || o.target.id} (${o.target.kind})`).join("\n") || "    (none)";
        const inList = neighbors?.inbound.map((i) => `    <- [${i.relation}] ${i.source.name || i.source.id} (${i.source.kind})`).join("\n") || "    (none)";

        return [
          `### [${node.kind.toUpperCase()}] ${node.name} (Match Score: ${score})`,
          `ID: \`${node.id}\``,
          `Path: ${node.path}`,
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

  // TOOL 4: Shortest Path Dependency Trace
  pi.registerTool({
    name: "graphify_trace",
    label: "Trace Path Between Concepts",
    description: "Computes the shortest dependency or reference chain connecting two symbols or concepts.",
    parameters: Type.Object({
      source: Type.String({ description: "Source node ID or symbol name" }),
      target: Type.String({ description: "Target node ID or symbol name" }),
    }),
    execute: async (_toolCallId, params, _signal, _update, ctx) => {
      const currentStore = getOrInitStore(ctx.cwd);
      const srcMatches = currentStore.searchNodes(params.source, 1);
      const tgtMatches = currentStore.searchNodes(params.target, 1);

      if (srcMatches.length === 0 || tgtMatches.length === 0) {
        return {
          content: [{ type: "text", text: `Unable to find matching source or target node.` }],
          details: { error: "NODE_NOT_FOUND" },
        };
      }

      const path = currentStore.tracePath(srcMatches[0].node.id, tgtMatches[0].node.id);
      if (!path) {
        return {
          content: [{ type: "text", text: `No connection path exists between ${srcMatches[0].node.id} and ${tgtMatches[0].node.id}.` }],
          details: { connected: false },
        };
      }

      return {
        content: [{ type: "text", text: `Connection Path (${path.length - 1} hops):\n` + path.map((id, idx) => `${idx + 1}. ${id}`).join("\n -> ") }],
        details: { connected: true, path },
      };
    },
  });

  // Slash Command: /graphify
  pi.registerCommand("graphify", {
    description: "Graphify Knowledge Graph Manager (add, rebuild, report, query, trace)",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const currentStore = getOrInitStore(ctx.cwd);
      const rootDir = ctx.cwd || process.cwd();

      // /graphify add <url_or_path>
      if (trimmed.startsWith("add ")) {
        const target = trimmed.slice(4).trim();
        ctx.ui.notify(`Ingesting ${target}...`, "info");
        try {
          const res = await ingestTarget(target);
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
        ctx.ui.notify("Rebuilding repository knowledge graph...", "info");
        const graph = await scanCodebase(rootDir);
        currentStore.setGraph(graph);
        const artifacts = generateArtifacts(currentStore, join(rootDir, "graphify-out"));
        ctx.ui.setStatus("graphify", `Graph: ${graph.nodes.length} nodes`);
        ctx.ui.notify(`Graph built: ${graph.nodes.length} nodes. Report saved to ${artifacts.reportPath}`, "info");
        return;
      }

      // /graphify report
      if (trimmed === "report") {
        const summary = currentStore.getSummary();
        const godNodes = currentStore.getGodNodes(3);
        ctx.ui.notify(
          `Graph: ${summary.totalNodes} nodes, ${summary.totalEdges} edges. Top Hub: ${godNodes[0]?.node.id ?? "none"} (${godNodes[0]?.degree ?? 0} connections)`,
          "info"
        );
        return;
      }

      // Default: Status
      const summary = currentStore.getSummary();
      ctx.ui.notify(`Knowledge Graph: ${summary.totalNodes} nodes, ${summary.totalEdges} edges, ${summary.totalCommunities} communities.`, "info");
    },
  });
}