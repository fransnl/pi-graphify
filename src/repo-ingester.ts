import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { scanCodebase } from "./code-scanner.js";
import type { GraphNode, GraphEdge } from "./types.js";
import type { IngestionResult } from "./doc-ingester.js";

const execFileAsync = promisify(execFile);

export function isGitHubRepoUrl(target: string): boolean {
  return /^https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(target);
}

export async function ingestGitHubRepo(repoUrl: string, workspaceRoot: string): Promise<IngestionResult> {
  const urlObj = new URL(repoUrl.replace(/\.git$/, ""));
  const parts = urlObj.pathname.replace(/^\/+|\/+$/g, "").split("/");
  const owner = parts[0];
  const repo = parts[1];
  const repoName = `${owner}/${repo}`;

  // Store in persistent vault under .pi/knowledge/repos/owner/repo
  const relativeRepoPath = join(".pi", "knowledge", "repos", owner, repo);
  const absoluteRepoPath = join(workspaceRoot, relativeRepoPath);

  // Clone or pull updates
  if (!existsSync(absoluteRepoPath)) {
    mkdirSync(join(workspaceRoot, ".pi", "knowledge", "repos", owner), { recursive: true });
    await execFileAsync("git", ["clone", "--depth", "1", repoUrl, absoluteRepoPath]);
  } else {
    try {
      await execFileAsync("git", ["pull"], { cwd: absoluteRepoPath });
    } catch {
      // Ignore if disconnected; use cached clone
    }
  }

  // Run AST scanner over the persistent clone directory
  const rawGraph = await scanCodebase(absoluteRepoPath);
  const repoNamespace = `repo://${repoName}`;

  // Map all nodes so their path is a valid workspace-relative path
  const namespacedNodes: GraphNode[] = rawGraph.nodes.map((node) => {
    const isFileRoot = node.id.startsWith("file://");
    const relativeId = isFileRoot ? node.id.replace("file://", "") : node.id;
    const namespacedId = `${repoNamespace}/${relativeId}`;
    const localWorkspacePath = join(relativeRepoPath, node.path);

    return {
      ...node,
      id: namespacedId,
      path: localWorkspacePath,
      sourceUrl: `${repoUrl}/blob/main/${node.path}`,
      metadata: {
        ...node.metadata,
        repository: repoUrl,
        repoName,
      },
    };
  });

  const namespacedEdges: GraphEdge[] = rawGraph.edges.map((edge) => {
    const fixId = (id: string) => {
      if (id.startsWith("file://")) {
        return `${repoNamespace}/${id.replace("file://", "")}`;
      }
      return id;
    };

    return {
      ...edge,
      source: fixId(edge.source),
      target: fixId(edge.target),
    };
  });

  // Root repository node
  namespacedNodes.unshift({
    id: repoNamespace,
    name: repoName,
    kind: "module",
    path: relativeRepoPath,
    sourceUrl: repoUrl,
    summary: `Persistent GitHub repository: ${repoName} (${rawGraph.nodes.length} symbols)`,
    metadata: {
      type: "github_repository",
      url: repoUrl,
    },
  });

  return {
    nodes: namespacedNodes,
    edges: namespacedEdges,
    title: repoName,
    summary: `Cloned and stored repository to ${relativeRepoPath} (${rawGraph.nodes.length} symbols).`,
    savedPath: relativeRepoPath,
  };
}