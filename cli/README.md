# Grokipedia Article Reviewer CLI

Automated fact-checking tool for Grokipedia articles using the GitHub Copilot SDK with Claude Opus 4.5.

## Features

- **Automated fact-checking**: Analyzes articles for factual errors using AI
- **Source verification**: Uses web search to verify claims against authoritative sources (Wikipedia, etc.)
- **Structured corrections**: Returns specific text selections with corrections and sources
- **Multiple modes**: Review specific articles, search by theme, or pick random articles
- **Browser agnostic**: Works with Chromium, Firefox, WebKit, Chrome, Edge, or Comet
- **Dry run mode**: Analyze without submitting corrections

## Prerequisites

- Node.js 18+
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli) installed and authenticated
- A GitHub Copilot subscription

## Installation

```bash
cd cli
npm install
npx playwright install chromium  # Install browser
```

## Usage

```bash
# Review a specific article (dry run - don't submit corrections)
npm start -- --article "Tetris" --dry-run

# Review 3 random articles
npm start -- -n 3

# Review articles about specific themes
npm start -- --theme physics history -n 5

# Use a different browser
npm start -- --article "Lambda calculus" --browser firefox

# Show browser window for debugging
npm start -- --article "Tetris" --no-headless --dry-run

# List available browsers
npm start -- --list-browsers
```

## CLI Options

| Option | Description |
|--------|-------------|
| `-n, --iterations <number>` | Number of articles to review (default: 1) |
| `-a, --article <name>` | Specific article to review |
| `-t, --theme <themes...>` | Theme(s) to search for articles |
| `-b, --browser <type>` | Browser: chromium, firefox, webkit, chrome, edge, comet |
| `--no-headless` | Show browser window |
| `--dry-run` | Analyze without submitting corrections |
| `-v, --verbose` | Show Copilot's reasoning and tool calls |
| `--list-browsers` | List available browsers |

## How It Works

1. **Fetch**: The CLI uses Playwright to navigate to Grokipedia and extract article content
2. **Analyze**: Content is sent to Copilot with Claude Opus 4.5 for analysis
3. **Verify**: Copilot uses web search to verify suspicious claims against authoritative sources
4. **Report**: Returns structured JSON with exact text selections, error descriptions, and corrections
5. **Submit**: (Unless --dry-run) Corrections are submitted via browser automation

## Example Output

```
=== Grokipedia Article Reviewer ===

Iterations: 1
Mode: Specific article
Browser: chromium

✔ Browser started (chromium)
✔ Connected to Copilot
✔ Session created

============================================================
Iteration 1 of 1
============================================================

✔ Fetched 61550 characters

Analyzing article with Claude Opus 4.5...
.......................

Analysis complete. Found 3 potential error(s).

--- Error Found ---
Text: "Created by Soviet software engineer Alexey Pajitnov in 1984..."
Problem: The creation year is wrong; sources indicate Tetris was created in 1985
Correction: Tetris was created in 1985
Sources: https://en.wikipedia.org/wiki/Tetris
[DRY RUN] Would submit correction

=== Review Complete ===

Total: 3 errors found, 0 corrections submitted
```

## Project Structure

```
cli/
├── src/
│   ├── index.ts      # Main CLI entry point
│   ├── browser.ts    # Browser management (Playwright)
│   ├── fetcher.ts    # Article content extraction
│   └── submitter.ts  # Edit submission
├── package.json
└── tsconfig.json
```

## License

MIT
