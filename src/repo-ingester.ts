import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanCodebase } from "./code-scanner.js";
import type { GraphNode, GraphEdge } from "./types.js";

const execFileAsync = promisify(execFile);

export interface RepoIngestionResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  repoName: string;
  totalFiles: number;
}

/**
 * Checks if a string is a GitHub repository URL.
 */
export function isGitHubRepoUrl(target: string): boolean {
  return /^https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(target);
}

/**
 * Clones a repository shallowly to a temporary directory, runs the AST codebase scanner,
 * prefixes node IDs with the repository namespace, and cleans up the temporary files.
 */
export async function ingestGitHubRepo(repoUrl: string): Promise<RepoIngestionResult> {
  const urlObj = new URL(repoUrl.replace(/\.git$/, ""));
  const parts = urlObj.pathname.replace(/^\/+|\/+$/g, "").split("/");
  const repoName = `${parts[0]}/${parts[1]}`;
  const repoNamespace = `repo://github.com/${repoName}`;

  // Create temporary directory in OS temp
  const tempDir = mkdtempSync(join(tmpdir(), "pi-graphify-repo-"));

  try {
    // Perform shallow clone (depth = 1) for fast downloading
    await execFileAsync("git", ["clone", "--depth", "1", repoUrl, tempDir]);

    // Run AST & source scanner over cloned repository
    const rawGraph = await scanCodebase(tempDir);

    // Namespace node IDs and file paths
    const namespacedNodes: GraphNode[] = rawGraph.nodes.map((node) => {
      const isFileRoot = node.id.startsWith("file://");
      const relativeId = isFileRoot ? node.id.replace("file://", "") : node.id;
      const namespacedId = `${repoNamespace}/${relativeId}`;

      return {
        ...node,
        id: namespacedId,
        path: `${repoName}/${node.path}`,
        metadata: {
          ...node.metadata,
          repository: repoUrl,
          repoName,
        },
      };
    });

    // Namespace edge sources and targets
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
      path: repoUrl,
      summary: `External GitHub repository: ${repoName}`,
      metadata: {
        type: "github_repository",
        url: repoUrl,
      },
    });

    return {
      nodes: namespacedNodes,
      edges: namespacedEdges,
      repoName,
      totalFiles: rawGraph.nodes.filter((n) => n.kind === "file").length,
    };
  } finally {
    // Always clean up temp directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}