import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { GraphNode, GraphEdge } from "./types.js";
import { isGitHubRepoUrl, ingestGitHubRepo } from "./repo-ingester.js";

export interface IngestionResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  title: string;
  summary: string;
}

export async function ingestTarget(target: string): Promise<IngestionResult> {
  const trimmed = target.trim();

  // 1. GitHub Repository URL
  if (isGitHubRepoUrl(trimmed)) {
    const repoResult = await ingestGitHubRepo(trimmed);
    return {
      nodes: repoResult.nodes,
      edges: repoResult.edges,
      title: repoResult.repoName,
      summary: `Cloned and scanned GitHub repository ${repoResult.repoName} (${repoResult.totalFiles} files).`,
    };
  }

  // 2. Standard Web Documentation URL
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return ingestUrl(trimmed);
  }

  // 3. Local File / Path
  return ingestLocalFile(trimmed);
}

/**
 * Strips scripts, styles, navigation bars, headers, footers, and table-of-contents elements.
 */
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

/**
 * Strips remaining HTML tags and normalizes whitespace.
 */
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

export async function ingestUrl(urlStr: string): Promise<IngestionResult> {
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

  const raw = await response.text();
  return parseDocumentContent(raw, url.toString(), url.hostname + url.pathname);
}

export async function ingestLocalFile(filePath: string): Promise<IngestionResult> {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const content = readFileSync(absPath, "utf-8");
  return parseDocumentContent(content, filePath, filePath);
}

function parseDocumentContent(rawContent: string, sourcePath: string, rootIdKey: string): IngestionResult {
  const isHtml = /<[a-z][\s\S]*>/i.test(rawContent);
  const cleaned = isHtml ? cleanHtml(rawContent) : rawContent;

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Extract Page / Document Title
  const titleMatch = cleaned.match(/<title>(.*?)<\/title>/i) || cleaned.match(/^#\s+(.+)$/m);
  const title = titleMatch ? stripTags(titleMatch[1]).replace(/\s*·.*$/, "") : rootIdKey;

  const docNodeId = `doc://${rootIdKey.replace(/^[./]+/, "")}`;

  // Extract first 2-3 paragraphs for top-level document summary
  const paragraphMatches = cleaned.match(/<p\b[^>]*>(.*?)<\/p>/gis) || [];
  const paragraphs = paragraphMatches
    .map(stripTags)
    .filter((p) => p.length > 30)
    .slice(0, 3);
  const docSummary = paragraphs.join(" ");

  nodes.push({
    id: docNodeId,
    name: title,
    kind: "doc",
    path: sourcePath,
    summary: docSummary || `Documentation for ${title}`,
    metadata: {
      source: sourcePath,
      indexedAt: new Date().toISOString(),
    },
  });

  // Extract Structured Sections (H1, H2, H3 or Markdown #, ##, ###)
  const sectionPattern = isHtml
    ? /<h([1-3])[^>]*>(.*?)<\/h\1>([\s\S]*?)(?=<h[1-3]|$)/gi
    : /^(#{1,3})\s+(.+)$([\s\S]*?)(?=^#{1,3}\s+|$)/gim;

  let sectionMatch: RegExpExecArray | null;
  const seenSections = new Set<string>();

  while ((sectionMatch = sectionPattern.exec(cleaned)) !== null) {
    const rawHeading = isHtml ? sectionMatch[2] : sectionMatch[2];
    const sectionBody = isHtml ? sectionMatch[3] : sectionMatch[3];

    const headingText = stripTags(rawHeading).trim();
    if (!headingText || headingText.toLowerCase() === title.toLowerCase() || headingText.length > 80) {
      continue;
    }

    // Skip generic navigation headings
    if (/^(on this page|navigation|table of contents|menu|footer|related)$/i.test(headingText)) {
      continue;
    }

    const cleanSummary = stripTags(sectionBody)
      .replace(/\s+/g, " ")
      .slice(0, 500);

    const sectionSlug = encodeURIComponent(headingText.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
    const sectionNodeId = `${docNodeId}#${sectionSlug}`;

    if (!seenSections.has(sectionNodeId)) {
      seenSections.add(sectionNodeId);

      nodes.push({
        id: sectionNodeId,
        name: headingText,
        kind: "concept",
        path: sourcePath,
        summary: cleanSummary || `Section details for ${headingText}`,
        metadata: { parentDoc: docNodeId },
      });

      edges.push({
        source: docNodeId,
        target: sectionNodeId,
        relation: "defines",
        provenance: "EXTRACTED",
        description: `Defines concept and section: ${headingText}`,
      });
    }
  }

  // Extract API Symbols and Code Constructs
  const codeRegex = /<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>|```(?:[a-z]*\n)?([\s\S]*?)```/gi;
  let codeMatch: RegExpExecArray | null;
  const seenSymbols = new Set<string>();

  while ((codeMatch = codeRegex.exec(cleaned)) !== null) {
    const codeSnippet = codeMatch[1] || codeMatch[2];
    if (!codeSnippet) continue;

    // Match symbol declarations (functions, methods, registers, tools, hooks)
    const identifierMatches = codeSnippet.match(/\b(registerTool|registerCommand|on|execute|handle|[A-Za-z0-9_]{3,30})\b/g) || [];

    for (const ident of identifierMatches) {
      if (
        ident.length >= 4 &&
        !["const", "function", "return", "import", "export", "class", "async", "await"].includes(ident)
      ) {
        if (!seenSymbols.has(ident)) {
          seenSymbols.add(ident);
          const symbolNodeId = `api://${ident}`;

          nodes.push({
            id: symbolNodeId,
            name: ident,
            kind: "api",
            path: sourcePath,
            summary: `API symbol extracted from ${title}: ${ident}`,
          });

          edges.push({
            source: docNodeId,
            target: symbolNodeId,
            relation: "references",
            provenance: "EXTRACTED",
          });
        }
      }
    }
  }

  return {
    nodes,
    edges,
    title,
    summary: docSummary,
  };
}