import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import type { GraphNode, GraphEdge } from "./types.js";
import { isGitHubRepoUrl, ingestGitHubRepo } from "./repo-ingester.js";

export interface IngestionResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  title: string;
  summary: string;
  savedPath: string;
}

export async function ingestTarget(target: string, workspaceRoot: string): Promise<IngestionResult> {
  const trimmed = target.trim();

  // 1. GitHub Repositories
  if (isGitHubRepoUrl(trimmed)) {
    return ingestGitHubRepo(trimmed, workspaceRoot);
  }

  // 2. Remote Web Documentation
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return ingestUrlToVault(trimmed, workspaceRoot);
  }

  // 3. Local Files
  return ingestLocalFileToVault(trimmed, workspaceRoot);
}

function cleanHtml(rawHtml: string): string {
  return rawHtml
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "")
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, "")
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "")
    .replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, "")
    .replace(/<div[^>]*class=["'][^"']*(?:sidebar|toc|menu|nav|breadcrumbs)[^"']*["'][^>]*>.*?<\/div>/gis, "");
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Converts sanitized HTML into clean, readable Markdown.
 */
function htmlToMarkdown(html: string): string {
  let md = html
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, "\n# $1\n\n")
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, "\n## $1\n\n")
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, "\n### $1\n\n")
    .replace(/<h4[^>]*>(.*?)<\/h4>/gi, "\n#### $1\n\n")
    .replace(/<p[^>]*>(.*?)<\/p>/gis, "$1\n\n")
    .replace(/<pre><code(?: class=["'](?:language-)?([a-z0-9_-]+)["'])?[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_m, lang, code) => {
      const cleanCode = code
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
      return `\n\`\`\`${lang || ""}\n${cleanCode.trim()}\n\`\`\`\n\n`;
    })
    .replace(/<code>(.*?)<\/code>/gi, "`$1`")
    .replace(/<li[^>]*>(.*?)<\/li>/gis, "* $1\n")
    .replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gis, "$1\n")
    .replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gis, "$1\n");

  return stripTags(md)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function ingestUrlToVault(urlStr: string, workspaceRoot: string): Promise<IngestionResult> {
  const url = new URL(urlStr);
  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PiGraphifyBot/1.0; +https://github.com/Graphify-Labs/graphify)",
      Accept: "text/html,text/markdown,text/plain,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${urlStr}: ${response.status} ${response.statusText}`);
  }

  const rawHtml = await response.text();
  const cleanedHtml = cleanHtml(rawHtml);

  // Extract Page Title
  const titleMatch = cleanedHtml.match(/<title>(.*?)<\/title>/i) || cleanedHtml.match(/<h1[^>]*>(.*?)<\/h1>/i);
  const pageTitle = titleMatch ? stripTags(titleMatch[1]).replace(/\s*·.*$/, "").trim() : url.pathname;

  // Convert to Markdown
  const markdownContent = [
    `# ${pageTitle}`,
    `Source: ${url.toString()}`,
    `Ingested: ${new Date().toISOString()}`,
    ``,
    htmlToMarkdown(cleanedHtml),
  ].join("\n");

  // Determine local destination path in .pi/knowledge/docs/
  const sanitizedPath = url.pathname.replace(/^\/|\/$/g, "").replace(/\//g, "-") || "index";
  const relativeVaultPath = join(".pi", "knowledge", "docs", url.hostname, `${sanitizedPath}.md`);
  const absoluteVaultPath = join(workspaceRoot, relativeVaultPath);

  // Save the full Markdown document locally
  mkdirSync(dirname(absoluteVaultPath), { recursive: true });
  writeFileSync(absoluteVaultPath, markdownContent, "utf-8");

  // Parse lines to build indexed graph nodes with exact line numbers
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const lines = markdownContent.split("\n");

  const rootDocNodeId = `doc://${url.hostname}/${sanitizedPath}`;
  const docSummary = lines.slice(4, 15).join(" ").slice(0, 300);

  nodes.push({
    id: rootDocNodeId,
    name: pageTitle,
    kind: "doc",
    path: relativeVaultPath,
    sourceUrl: urlStr,
    summary: docSummary || `Documentation for ${pageTitle}`,
    lineStart: 1,
    lineEnd: lines.length,
    metadata: {
      hostname: url.hostname,
      sourceUrl: urlStr,
    },
  });

  // Extract Section Nodes with precise line bounds
  let currentSection: { name: string; start: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(/^(#{2,3})\s+(.+)$/);

    if (headerMatch) {
      if (currentSection) {
        // Finalize previous section
        const sectionSlug = encodeURIComponent(currentSection.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
        const sectionId = `${rootDocNodeId}#${sectionSlug}`;
        const sectionText = lines.slice(currentSection.start - 1, i).join(" ").slice(0, 400);

        nodes.push({
          id: sectionId,
          name: currentSection.name,
          kind: "concept",
          path: relativeVaultPath,
          sourceUrl: urlStr,
          summary: sectionText,
          lineStart: currentSection.start,
          lineEnd: i,
        });

        edges.push({
          source: rootDocNodeId,
          target: sectionId,
          relation: "defines",
          provenance: "EXTRACTED",
        });
      }

      currentSection = {
        name: headerMatch[2].trim(),
        start: i + 1,
      };
    }
  }

  // Finalize last section
  if (currentSection) {
    const sectionSlug = encodeURIComponent(currentSection.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
    const sectionId = `${rootDocNodeId}#${sectionSlug}`;
    const sectionText = lines.slice(currentSection.start - 1).join(" ").slice(0, 400);

    nodes.push({
      id: sectionId,
      name: currentSection.name,
      kind: "concept",
      path: relativeVaultPath,
      sourceUrl: urlStr,
      summary: sectionText,
      lineStart: currentSection.start,
      lineEnd: lines.length,
    });

    edges.push({
      source: rootDocNodeId,
      target: sectionId,
      relation: "defines",
      provenance: "EXTRACTED",
    });
  }

  return {
    nodes,
    edges,
    title: pageTitle,
    summary: `Saved document to ${relativeVaultPath} and indexed ${nodes.length} sections.`,
    savedPath: relativeVaultPath,
  };
}

export async function ingestLocalFileToVault(filePath: string, workspaceRoot: string): Promise<IngestionResult> {
  const absPath = join(workspaceRoot, filePath);
  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = readFileSync(absPath, "utf-8");
  const relPath = relative(workspaceRoot, absPath);
  const lines = content.split("\n");

  const nodes: GraphNode[] = [{
    id: `file://${relPath}`,
    name: relPath,
    kind: "file",
    path: relPath,
    summary: lines.slice(0, 5).join(" ").slice(0, 200),
    lineStart: 1,
    lineEnd: lines.length,
  }];

  return {
    nodes,
    edges: [],
    title: relPath,
    summary: `Indexed local file ${relPath}`,
    savedPath: relPath,
  };
}