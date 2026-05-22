# @llamaindex/liteparse-pi-extension

A [pi-coding-agent](https://pi.dev)
extension that exposes [**LiteParse**](https://github.com/run-llama/liteparse)
to the agent as a set of first-class tools.

LiteParse is a fast, local, open-source document parsing library written in Rust: PDFs, scanned
images, and Office files in → text + spatial layout (bounding boxes) out. No
LLMs, no cloud calls. This extension lets a pi agent reach for those
capabilities the same way it would reach for `read` or `grep`.

## Tools

| Tool                       | What it does                                                                                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`liteparse_parse`**      | Parse a local PDF / image / Office file and return its extracted text. Supports `targetPages` (e.g. `"1-3,7"`), optional OCR, custom DPI, passwords, and an `includeItems` flag for per-text-item bounding boxes. Text output is truncated to ~50 KB / 2000 lines. |
| **`liteparse_screenshot`** | Render one or more pages of a local document as PNG images and return them as image content blocks the model can look at directly. Useful when text extraction isn't enough — figures, tables, signatures, layout.                                                 |
| **`liteparse_search`**     | Search a parsed document for a phrase and return every hit with its page number and bounding box. Great for building visual citations or jumping to the source of a quoted snippet.                                                                                |

All three tools come with `promptGuidelines` so the model knows, for example,
to prefer `liteparse_parse` over `read` when the user points it at a PDF.

## Install / run

This repo uses [Bun](https://bun.com).

```bash
bun install
```

Run pi with this extension loaded:

```bash
bunx pi -e ./src/index.ts
```

The repo's `package.json` also declares the extension under the `pi` key, so if
you install it as a dependency in another pi project it will be picked up
automatically:

```jsonc
{
  "pi": {
    "extensions": ["./src/index.ts"],
  },
}
```

## Example session

```
> summarize page 1 of data/whitepaper.pdf

[agent calls liteparse_parse with { path: "data/whitepaper.pdf", targetPages: "1" }]

The first page introduces …
```

```
> look at the chart on page 4 of data/report.pdf and tell me the y-axis label

[agent calls liteparse_screenshot with { path: "data/report.pdf", pages: [4] }]

The y-axis is labeled "Revenue (USD millions)".
```

```
> find every mention of "Section 4.2" in data/spec.pdf

[agent calls liteparse_search with { path: "data/spec.pdf", phrase: "Section 4.2" }]

Found 6 hits:
  p12  [102.3, 540.1  78.4×11.0]   Section 4.2
  p13  [102.3, 312.7  78.4×11.0]   Section 4.2
  …
```

## Development

```bash
# Type-check
bun run typecheck

# Format
bun run format

# Lint
bun run lint
```

## How it works

`src/index.ts` defines three tools with `defineTool(...)` from
`@earendil-works/pi-coding-agent`, then registers them in the default export:

```ts
export default function (pi: ExtensionAPI) {
  pi.registerTool(parseTool);
  pi.registerTool(screenshotTool);
  pi.registerTool(searchTool);
}
```

Each tool wraps the `LiteParse` class from `@llamaindex/liteparse`:

```ts
const parser = new LiteParse({ quiet: true, ocrEnabled, targetPages, ... });
const result = await parser.parse(absPath);
```

Paths are resolved against `ctx.cwd`, with a leading `@` stripped to play nice
with pi's `@`-prefixed file references. Screenshots come back as `Buffer`s and
are returned as base64 `image` content blocks (`{ type: "image", data,
mimeType: "image/png" }`) so the model can see them directly.
