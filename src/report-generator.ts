import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { GraphStore } from "./graph-store.js";

export function generateArtifacts(store: GraphStore, outputDir: string): { reportPath: string; htmlPath: string; jsonPath: string } {
  mkdirSync(outputDir, { recursive: true });

  const jsonPath = join(outputDir, "graph.json");
  const reportPath = join(outputDir, "GRAPH_REPORT.md");
  const htmlPath = join(outputDir, "graph.html");

  writeFileSync(
    jsonPath,
    JSON.stringify({
      version: "1.0.0",
      nodes: store.nodes,
      edges: store.edges,
      communities: store.communities,
    }, null, 2),
    "utf-8"
  );

  const summary = store.getSummary();
  const godNodes = store.getGodNodes(6);
  const rules = store.nodes.filter((n) => n.kind === "rule" || n.kind === "constraint");

  const reportContent = [
    `# Graphify Knowledge Graph & Memory Audit`,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `## Summary Statistics`,
    `- **Total Nodes**: ${summary.totalNodes}`,
    `- **Total Edges**: ${summary.totalEdges}`,
    `- **Active Rules & Constraints**: ${rules.length}`,
    `- **Symbol Distribution**: ${Object.entries(summary.kinds).map(([k, v]) => `${k}: ${v}`).join(", ")}`,
    ``,
    `## Active Constitutional Rules (Tier 1)`,
    ...rules.map((r) => `- **[${r.kind.toUpperCase()}]** \`${r.name}\`: ${r.summary} (${r.path})`),
    ``,
    `## High-Centrality Hubs (God Nodes)`,
    ...godNodes.map((g) => `- **\`${g.node.id}\`** [${g.node.kind}] — Degree: ${g.degree} (In: ${g.inDegree}, Out: ${g.outDegree})`),
  ].join("\n");

  writeFileSync(reportPath, reportContent, "utf-8");

  const graphDataJson = JSON.stringify({ nodes: store.nodes, edges: store.edges });
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Graphify Visualizer & Memory Map</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    body { margin: 0; background: #0f172a; color: #f8fafc; font-family: sans-serif; overflow: hidden; }
    #toolbar { position: absolute; top: 10px; left: 10px; z-index: 10; background: #1e293b; padding: 12px; border-radius: 8px; font-size: 13px; }
    input { background: #334155; border: 1px solid #475569; color: white; padding: 6px; border-radius: 4px; }
    #sidebar { position: absolute; top: 10px; right: 10px; width: 340px; max-height: 90vh; background: #1e293b; padding: 16px; border-radius: 8px; overflow-y: auto; display: none; }
    line { stroke: #475569; stroke-opacity: 0.6; }
    circle { stroke: #fff; stroke-width: 1.5px; cursor: pointer; }
    text { font-size: 10px; fill: #cbd5e1; pointer-events: none; }
  </style>
</head>
<body>
  <div id="toolbar">
    <strong>Graphify Knowledge & Memory Graph</strong><br/>
    Nodes: ${summary.totalNodes} | Edges: ${summary.totalEdges} | Rules: ${rules.length}<br/><br/>
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
      .force("link", d3.forceLink(data.edges).id(d => d.id).distance(65))
      .force("charge", d3.forceManyBody().strength(-140))
      .force("center", d3.forceCenter(width / 2, height / 2));

    const g = svg.append("g");
    svg.call(d3.zoom().on("zoom", (e) => g.attr("transform", e.transform)));

    const link = g.append("g").selectAll("line").data(data.edges).enter().append("line");
    const node = g.append("g").selectAll("circle").data(data.nodes).enter().append("circle")
      .attr("r", d => d.kind === "rule" || d.kind === "constraint" ? 9 : (d.kind === "doc" ? 8 : 5))
      .attr("fill", d => d.kind === "rule" || d.kind === "constraint" ? "#ef4444" : (d.kind === "decision" ? "#f59e0b" : color(d.kind)))
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
      sb.innerHTML = "<h3>" + d.name + "</h3><p><strong>Kind:</strong> " + d.kind + " (Tier " + (d.tier || "Standard") + ")</p><p><strong>ID:</strong> " + d.id + "</p><p><strong>Path:</strong> " + d.path + "</p><p><strong>Summary:</strong> " + (d.summary || "None") + "</p>";
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