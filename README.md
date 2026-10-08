# CoT Deep Code Review

A VS Code extension for **autonomous asynchronous code review & refactoring** using
Chain-of-Thought (CoT) prompt engineering against the Groq Cloud API
(`llama-3.3-70b-versatile`).

## What it does

1. Select code in the active editor and right-click → **CoT: Run Deep Code Review**.
2. The extension builds a structured CoT JSON payload (execution trace, vulnerability
   analysis, impact assessment, refactored code) and sends it asynchronously to the
   Groq chat-completions endpoint.
3. The parsed result renders in an interactive webview panel with collapsible
   accordions and a **Replace in Editor** button that swaps the original selection
   for the refactored code.

## Setup

1. Install the extension (or run `npm install && npm run build`, then press `F5`).
2. Get a Groq API key from <https://console.groq.com/keys>.
3. Either set it in settings under `cotReviewer.groqApiKey`, or run a review and
   paste the key when prompted.

## Commands

| Command | Title |
| --- | --- |
| `cot.runDeepReview` | CoT: Run Deep Code Review |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `cotReviewer.groqApiKey` | `""` | Groq Cloud developer API key. |

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # groqService unit tests (mocked fetch)
npm run build       # esbuild bundle -> dist/extension.js
npm run watch       # incremental rebuilds
npm run package     # produce .vsix
```

## License

MIT
