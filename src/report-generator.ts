import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { GraphStore } from "./graph-store.js";

export function generateArtifacts(store: GraphStore, outputDir: string): { reportPath: string; htmlPath: string; jsonPath: string } {
  mkdirSync(outputDir, { recursive: true });

  const jsonPath = join(outputDir, "graph.json");
  const reportPath = join(outputDir, "GRAPH_REPORT.md");
  const htmlPath = join(outputDir, "graph.html");

  // 1. graph.json
  writeFileSync(jsonPath, JSON.stringify({
    version: "1.0.0",
    nodes: store.nodes,
    edges: store.edges,
    communities: store.communities,
  }, null, 2), "utf-8");

  // 2. GRAPH_REPORT.md
  const summary = store.getSummary();
  const godNodes = store.getGodNodes(8);
  const reportContent = [
    `# Graphify Knowledge Graph Audit Report`,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `## Summary Statistics`,
    `- **Total Nodes**: ${summary.totalNodes}`,
    `- **Total Edges**: ${summary.totalEdges}`,
    `- **Communities**: ${summary.totalCommunities}`,
    `- **Symbol Breakdown**: ${Object.entries(summary.kinds).map(([k, v]) => `${k}: ${v}`).join(", ")}`,
    ``,
    `## High-Centrality Hubs (God Nodes)`,
    `Hubs with highest dependency blast radiuses:`,
    ...godNodes.map((g) => `- **\`${g.node.id}\`** [${g.node.kind}] — Total Degree: ${g.degree} (In: ${g.inDegree}, Out: ${g.outDegree})`),
    ``,
    `## Suggested Agent Exploration Queries`,
    `- \`graphify_query(query: "${godNodes[0]?.node.name || "main"}")\``,
    `- \`graphify_query(query: "api")\``,
    `- \`graphify_query(query: "concept")\``,
  ].join("\n");
  writeFileSync(reportPath, reportContent, "utf-8");

  // 3. graph.html (Interactive SVG / D3 Visualizer)
  const graphDataJson = JSON.stringify({ nodes: store.nodes, edges: store.edges });
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Graphify Visualizer</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    body { margin: 0; background: #0f172a; color: #f8fafc; font-family: sans-serif; overflow: hidden; }
    #toolbar { position: absolute; top: 10px; left: 10px; z-index: 10; background: #1e293b; padding: 10px; border-radius: 8px; }
    input { background: #334155; border: 1px solid #475569; color: white; padding: 6px; border-radius: 4px; }
    #sidebar { position: absolute; top: 10px; right: 10px; width: 320px; max-height: 90vh; background: #1e293b; padding: 15px; border-radius: 8px; overflow-y: auto; display: none; }
    line { stroke: #475569; stroke-opacity: 0.6; }
    circle { stroke: #fff; stroke-width: 1.5px; cursor: pointer; }
    text { font-size: 10px; fill: #cbd5e1; pointer-events: none; }
  </style>
</head>
<body>
  <div id="toolbar">
    <strong>Graphify Graph</strong> | Nodes: ${summary.totalNodes} | Edges: ${summary.totalEdges}
    <br/><br/>
    <input type="text" id="search" placeholder="Filter nodes..." oninput="filterGraph(this.value)" />
  </div>
  <div id="sidebar"></div>
  <svg width="100vw" height="100vh"></svg>
  <script>
    const data = ${graphDataJson};
    const svg = d3.select("svg");
    const width = window.innerWidth;
    const height = window.innerHeight;

    const color = d3.scaleOrdinal(d3.schemeCategory10);
    const simulation = d3.forceSimulation(data.nodes)
      .force("link", d3.forceLink(data.edges).id(d => d.id).distance(60))
      .force("charge", d3.forceManyBody().strength(-120))
      .force("center", d3.forceCenter(width / 2, height / 2));

    const g = svg.append("g");
    svg.call(d3.zoom().on("zoom", (e) => g.attr("transform", e.transform)));

    const link = g.append("g").selectAll("line").data(data.edges).enter().append("line");
    const node = g.append("g").selectAll("circle").data(data.nodes).enter().append("circle")
      .attr("r", d => d.kind === "doc" ? 8 : (d.kind === "concept" ? 6 : 5))
      .attr("fill", d => color(d.kind))
      .on("click", (e, d) => showDetails(d));

    const label = g.append("g").selectAll("text").data(data.nodes).enter().append("text")
      .text(d => d.name)
      .attr("x", 8).attr("y", 3);

    simulation.on("tick", () => {
      link.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      node.attr("cx", d => d.x).attr("cy", d => d.y);
      label.attr("x", d => d.x + 8).attr("y", d => d.y + 3);
    });

    function showDetails(d) {
      const sb = document.getElementById("sidebar");
      sb.style.display = "block";
      sb.innerHTML = "<h3>" + d.name + "</h3><p><strong>Kind:</strong> " + d.kind + "</p><p><strong>ID:</strong> " + d.id + "</p><p><strong>Summary:</strong> " + (d.summary || "None") + "</p>";
    }

    function filterGraph(val) {
      const q = val.toLowerCase();
      node.style("opacity", d => d.name.toLowerCase().includes(q) || d.id.toLowerCase().includes(q) ? 1 : 0.1);
      label.style("opacity", d => d.name.toLowerCase().includes(q) || d.id.toLowerCase().includes(q) ? 1 : 0.1);
    }
  </script>
</body>
</html>`;

  writeFileSync(htmlPath, htmlContent, "utf-8");
  return { reportPath, htmlPath, jsonPath };
}