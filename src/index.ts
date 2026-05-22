/**
 * LiteParse pi extension
 *
 * Exposes the @llamaindex/liteparse library to the agent as three tools:
 *
 *   - liteparse_parse       Parse a document and return its text (with
 *                           optional per-page text items / bounding boxes).
 *   - liteparse_screenshot  Render page screenshots as image content blocks
 *                           the LLM can look at directly.
 *   - liteparse_search      Search a parsed document for a phrase and get
 *                           back hits with page numbers + bounding boxes
 *                           (handy for visual citations / RAG).
 *
 * LiteParse runs entirely locally — no cloud, no LLMs, no API calls.
 */

import path, { resolve } from "node:path";

import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  LiteParse,
  searchItems,
  type LiteParseConfig,
  type ParseResult,
  type TextItem,
} from "@llamaindex/liteparse";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "bmp",
  "tiff",
  "webp",
  "svg",
];

/** Normalize a user-supplied path: strip leading `@`, resolve against cwd. */
function normalizePath(input: string, cwd: string): string {
  const stripped = input.startsWith("@") ? input.slice(1) : input;
  return resolve(cwd, stripped);
}

/** Build a LiteParse config from optional tool args. */
function buildConfig(args: {
  path: string;
  ocrEnabled?: boolean;
  ocrLanguage?: string;
  dpi?: number;
  targetPages?: string;
  password?: string;
}): Partial<LiteParseConfig> {
  const cfg: Partial<LiteParseConfig> = { quiet: true };
  const extension = path.extname(args.path);
  if (args.ocrEnabled !== undefined) cfg.ocrEnabled = args.ocrEnabled;
  if (!cfg.ocrEnabled && IMAGE_EXTENSIONS.includes(extension)) {
    cfg.ocrEnabled = true;
  }
  if (args.ocrLanguage) cfg.ocrLanguage = args.ocrLanguage;
  if (args.dpi !== undefined) cfg.dpi = args.dpi;
  if (args.targetPages) cfg.targetPages = args.targetPages;
  if (args.password) cfg.password = args.password;
  return cfg;
}

/** Light-weight per-page summary safe to send to the LLM. */
function summarizePages(result: ParseResult) {
  return result.pages.map((p) => ({
    pageNum: p.pageNum,
    width: p.width,
    height: p.height,
    textLength: p.text.length,
    textItems: p.textItems.length,
  }));
}

// ---------------------------------------------------------------------------
// Tool: liteparse_parse
// ---------------------------------------------------------------------------

const parseTool = defineTool({
  name: "liteparse_parse",
  label: "LiteParse",
  description:
    "Parse a local document (PDF, image, Office file, etc.) with LiteParse " +
    "and return its extracted text. Runs entirely locally — no cloud, no LLM. " +
    "Use `includeItems: true` to also get per-text-item bounding boxes (useful " +
    "for visual citations). Text output is truncated to ~50KB / 2000 lines.",
  promptSnippet:
    "Parse local PDFs / images / Office docs into text with optional bounding boxes",
  promptGuidelines: [
    "Use liteparse_parse instead of `read` when the user points you at a PDF, scanned image, or Office document and wants its textual contents.",
    "Use liteparse_parse with `targetPages` (e.g. '1-3,7') when only specific pages are needed — it is much faster than parsing the whole document.",
  ],
  parameters: Type.Object({
    path: Type.String({
      description:
        "Path to the document to parse (relative paths resolve to cwd).",
    }),
    targetPages: Type.Optional(
      Type.String({
        description:
          "Optional page range, e.g. '1-3', '2,5,8', '1-10'. Defaults to all pages.",
      }),
    ),
    ocrEnabled: Type.Optional(
      Type.Boolean({
        description:
          "Enable OCR fallback for scanned pages / embedded images. Default false.",
      }),
    ),
    ocrLanguage: Type.Optional(
      Type.String({
        description:
          "Tesseract language code (e.g. 'eng', 'fra'). Default 'eng'.",
      }),
    ),
    dpi: Type.Optional(
      Type.Number({
        description: "Rendering DPI for OCR / images. Default 150.",
      }),
    ),
    password: Type.Optional(
      Type.String({ description: "Password for encrypted documents." }),
    ),
    includeItems: Type.Optional(
      Type.Boolean({
        description:
          "If true, include per-page text items with bounding boxes in `details`. " +
          "This is not sent to the LLM directly but is available for follow-up " +
          "tool calls (e.g. liteparse_search).",
      }),
    ),
  }),

  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }], details: {} };
    }

    const absPath = normalizePath(params.path, ctx.cwd);
    const parser = new LiteParse(buildConfig(params));

    const result = await parser.parse(absPath);

    const truncation = truncateHead(result.text, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });

    const pages = summarizePages(result);
    let summary =
      `Parsed ${result.pages.length} page(s) from ${params.path}` +
      ` (${formatSize(truncation.totalBytes)} of text).\n\n` +
      truncation.content;

    if (truncation.truncated) {
      summary +=
        `\n\n[Text truncated: ${truncation.outputLines} of ${truncation.totalLines} lines` +
        ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).` +
        ` Re-run with a narrower \`targetPages\` to get more.]`;
    }

    return {
      content: [{ type: "text", text: summary }],
      details: {
        path: absPath,
        pageCount: result.pages.length,
        pages,
        truncated: truncation.truncated,
        // Only retain heavy text-items payload if the caller asked for it.
        items: params.includeItems
          ? result.pages.map((p) => ({
              pageNum: p.pageNum,
              textItems: p.textItems,
            }))
          : undefined,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Tool: liteparse_screenshot
// ---------------------------------------------------------------------------

const screenshotTool = defineTool({
  name: "liteparse_screenshot",
  label: "LiteParse Screenshot",
  description:
    "Render one or more pages of a local document as PNG images and return " +
    "them as image content blocks the model can look at directly. Useful when " +
    "text extraction is insufficient (figures, tables, signatures, layout).",
  promptSnippet:
    "Render local document pages as PNGs the LLM can see (figures, layout, signatures)",
  promptGuidelines: [
    "Use liteparse_screenshot when liteparse_parse's text is not enough to answer — for example to inspect figures, charts, tables, or visual layout in a PDF.",
    "Limit `pages` to a small set (1–4) when calling liteparse_screenshot to keep the model's image budget reasonable.",
  ],
  parameters: Type.Object({
    path: Type.String({ description: "Path to the document." }),
    pages: Type.Optional(
      Type.Array(Type.Number(), {
        description:
          "Specific 1-indexed page numbers to render. Defaults to all pages.",
      }),
    ),
    dpi: Type.Optional(
      Type.Number({
        description: "Rendering DPI (default 150). Higher = larger images.",
      }),
    ),
  }),

  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }], details: {} };
    }

    const absPath = normalizePath(params.path, ctx.cwd);
    const parser = new LiteParse(
      buildConfig({ dpi: params.dpi, path: params.path }),
    );

    const shots = parser.screenshot(absPath, params.pages);

    const content: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    > = [
      {
        type: "text",
        text: `Rendered ${shots.length} page screenshot(s) from ${params.path}.`,
      },
    ];

    for (const shot of shots) {
      content.push({
        type: "image",
        mimeType: "image/png",
        data: shot.imageBuffer.toString("base64"),
      });
    }

    return {
      content,
      details: {
        path: absPath,
        pages: shots.map((s) => ({
          pageNum: s.pageNum,
          width: s.width,
          height: s.height,
          bytes: s.imageBuffer.byteLength,
        })),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Tool: liteparse_search
// ---------------------------------------------------------------------------

const searchTool = defineTool({
  name: "liteparse_search",
  label: "LiteParse Search",
  description:
    "Search a local document for a phrase and return every hit with its page " +
    "number and bounding box. Great for building visual citations or jumping " +
    "to the source of a quoted snippet.",
  promptSnippet:
    "Find a phrase in a local document and get page + bounding-box hits",
  parameters: Type.Object({
    path: Type.String({ description: "Path to the document." }),
    phrase: Type.String({ description: "Phrase to search for." }),
    caseSensitive: Type.Optional(
      Type.Boolean({ description: "Case-sensitive search. Default false." }),
    ),
    targetPages: Type.Optional(
      Type.String({ description: "Optional page range, e.g. '1-10'." }),
    ),
    maxResults: Type.Optional(
      Type.Number({ description: "Maximum hits to return. Default 50." }),
    ),
    ocrEnabled: Type.Optional(Type.Boolean()),
    scope: Type.Optional(
      StringEnum(["all", "page"] as const, {
        description:
          "'all' searches across the whole document (default). 'page' returns hits grouped per page.",
      }),
    ),
  }),

  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }], details: {} };
    }

    const absPath = normalizePath(params.path, ctx.cwd);
    const parser = new LiteParse(
      buildConfig({
        ocrEnabled: params.ocrEnabled,
        targetPages: params.targetPages,
        path: absPath,
      }),
    );

    const result = await parser.parse(absPath);
    const maxResults = params.maxResults ?? 50;
    const caseSensitive = params.caseSensitive ?? false;

    type Hit = TextItem & { pageNum: number };
    const hits: Hit[] = [];

    for (const page of result.pages) {
      const found = searchItems(page.textItems, {
        phrase: params.phrase,
        caseSensitive,
      });
      for (const item of found) {
        hits.push({ ...item, pageNum: page.pageNum });
        if (hits.length >= maxResults) break;
      }
      if (hits.length >= maxResults) break;
    }

    const lines: string[] = [
      `Found ${hits.length} hit(s) for "${params.phrase}" in ${params.path}` +
        (hits.length >= maxResults ? ` (capped at ${maxResults})` : "") +
        ".",
    ];
    for (const h of hits) {
      lines.push(
        `  p${h.pageNum} [${h.x.toFixed(1)}, ${h.y.toFixed(1)} ` +
          `${h.width.toFixed(1)}×${h.height.toFixed(1)}]  ${h.text}`,
      );
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: {
        path: absPath,
        phrase: params.phrase,
        caseSensitive,
        hits: params.scope === "page" ? groupByPage(hits) : hits,
      },
    };
  },
});

function groupByPage<T extends { pageNum: number }>(
  hits: T[],
): Record<number, T[]> {
  const out: Record<number, T[]> = {};
  for (const h of hits) {
    (out[h.pageNum] ??= []).push(h);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerTool(parseTool);
  pi.registerTool(screenshotTool);
  pi.registerTool(searchTool);
}
