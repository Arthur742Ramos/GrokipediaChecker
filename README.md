# Grokipedia Fact-Checker & Content Improver

An AI-powered tool for automated fact-checking, content improvement, and editing of [Grokipedia](https://grokipedia.com) articles using GitHub Copilot SDK with Claude Opus 4.5 and browser automation.

## What It Does

This project systematically analyzes Grokipedia articles to:

- **Fact-check claims** using web search verification
- **Identify factual errors** (wrong dates, numbers, names, scores)
- **Detect internal inconsistencies** (conflicting information within articles)
- **Find writing quality issues** (awkward phrasing, clarity problems, grammar errors)
- **Submit corrections** directly via browser automation
- **Process articles in parallel** with configurable worker count

## Results

| Metric | Value |
|--------|-------|
| Articles Analyzed | 195+ |
| Corrections Submitted | 15 |
| Error Rate | ~7.7% |
| Focus Areas | Super Bowls, World Series, Olympics |

### Sample Corrections Made

- **Super Bowl VII**: Garo Yepremian fumble described as "near-score" → actually returned for a **touchdown** by Mike Bass
- **1996 World Series**: Andy Pettitte "complete game" → actually pitched **8 1/3 innings** (Wetteland got save)
- **Super Bowl VIII**: Vikings "defeats in Super Bowls IV, V, VI" → Vikings only played in **Super Bowl IV** before VIII
- **1995 World Series**: David Justice HR off "Dennis Martínez" → actually off **Jim Poole**
- **Bermuda Triangle**: Columbus described as "late 19th/early 20th century explorer" → Columbus sailed in **1492 (15th century)**
- **Phineas Gage**: Death year 1861 → actually **1860**

## How It Works

### Architecture

```
┌─────────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  TypeScript CLI     │────▶│  Browser Manager │────▶│   Grokipedia    │
│  (Copilot SDK +     │     │  (Playwright/CDP)│     │   (Target Site) │
│   Claude Opus 4.5)  │     └──────────────────┘     └─────────────────┘
└─────────────────────┘              │
         │                           ▼
         ▼                  ┌──────────────────┐
┌─────────────────────┐     │  Parallel Workers│
│  Web Search API     │     │  (Browser Pages) │
│  (Fact Verification)│     └──────────────────┘
└─────────────────────┘
```

### Workflow

1. **Fetch Article** → Browser automation retrieves article text
2. **AI Analysis** → Claude Opus 4.5 identifies verifiable claims
3. **Fact Verification** → Web search confirms or refutes claims
4. **Submit Corrections** → Browser automation submits verified corrections

### Parallel Processing

The CLI supports parallel workers for high-throughput fact-checking:
- Each worker gets its own browser page and Copilot session
- Workers pull articles from a shared queue
- Real-time progress tracking across all workers
- Configurable worker count (1-5 workers)

## Quick Start

### Prerequisites

- macOS with [Comet Browser](https://comet.com) (or Chrome/Edge/Chromium)
- Node.js 18+
- GitHub Copilot CLI access (for Copilot SDK)
- Python 3.8+ (for legacy scripts)

### Installation

```bash
# Clone the repository
git clone https://github.com/Arthur742Ramos/GrokipediaChecker.git
cd GrokipediaChecker

# Install CLI dependencies
cd cli
npm install
npm run build
cd ..

# Install Python dependencies (for legacy scripts)
pip install playwright
playwright install chromium

# Log into Grokipedia manually in your browser first
```

### Usage

#### TypeScript CLI (Recommended)

```bash
cd cli

# Review a specific article
node dist/index.js -a "Bermuda Triangle" --dry-run

# Review 5 random articles
node dist/index.js -n 5 --dry-run

# Parallel processing: 10 articles with 3 workers
node dist/index.js -n 10 -p 3 --dry-run

# Theme-based review with parallelization
node dist/index.js -n 8 -p 4 -t history science

# Use Comet browser (for existing login session)
node dist/index.js -n 5 -p 2 -b comet

# Show browser window (non-headless)
node dist/index.js -n 3 --no-headless

# Verbose mode (show AI reasoning)
node dist/index.js -n 2 -v --dry-run
```

#### CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `-n, --iterations <number>` | Number of articles to review | 1 |
| `-p, --parallel <number>` | Number of parallel workers (max 5) | 1 |
| `-a, --article <name>` | Specific article to review | - |
| `-t, --theme <themes...>` | Theme(s) to search for articles | - |
| `-b, --browser <type>` | Browser: chromium, firefox, webkit, chrome, edge, comet | chromium |
| `--no-headless` | Show browser window | headless |
| `--dry-run` | Analyze without submitting corrections | false |
| `-v, --verbose` | Show Copilot's reasoning and tool calls | false |
| `--list-browsers` | List available browsers | - |

#### Python Scripts (Legacy)

```bash
# Fetch an article
python3 .github/skills/grokipedia-fetch-content/fetch_content.py "Super Bowl VII"

# Submit a correction
python3 .github/skills/grokipedia-submit-edit/submit_edit.py \
  --article "Super Bowl VII" \
  --text "returned for a near-score" \
  --summary "Mike Bass returned it 49 yards for a touchdown, not a near-score" \
  --correction "returned 49 yards for a touchdown" \
  --sources "https://en.wikipedia.org/wiki/Super_Bowl_VII"
```

#### Comet Browser Workaround

If article fetches fail with "Failed to start Comet browser", close running instances:

```bash
pkill -f "/Applications/Comet.app/Contents/MacOS/Comet"
```

Then reopen Comet, confirm you're signed in, and retry.

## Project Structure

```
Grokipedia/
├── cli/                            # TypeScript CLI (recommended)
│   ├── src/
│   │   ├── index.ts                # Main CLI with parallel processing
│   │   ├── browser.ts              # Browser manager (multi-page support)
│   │   ├── fetcher.ts              # Article content fetcher
│   │   └── submitter.ts            # Edit submission handler
│   ├── dist/                       # Compiled JavaScript
│   └── package.json
├── .github/
│   └── skills/
│       ├── grokipedia-fetch-content/
│       │   └── fetch_content.py    # Python article fetcher
│       ├── grokipedia-submit-edit/
│       │   └── submit_edit.py      # Python correction submitter
│       ├── grokipedia-fact-check/
│       │   └── SKILL.md            # Fact-checking guidelines
│       └── grokipedia-batch-check/
│           └── SKILL.md            # Batch processing guide
├── fact_checker.py                 # Standalone Python fact-checker
├── batch_fact_checker.py           # Python batch processing script
├── fact_check_results.json         # Results log
└── README.md
```

## Error Types Found

| Category | Examples | Frequency |
|----------|----------|-----------|
| **Wrong Numbers** | Hit counts, scores, medal counts | High |
| **Wrong Names** | Pitcher who gave up HR, broadcaster | Medium |
| **Wrong Dates** | Death years, game dates | Medium |
| **Chronological Errors** | Historical figures in wrong centuries | Medium |
| **Sequence Errors** | Events in wrong order | Low |
| **Superlative Errors** | "First," "only" claims that are false | Low |
| **Complete Game Claims** | Pitcher credited with CG but used reliever | Medium |

## Key Insights

- **Sports articles have the highest error rate** (~8-10%), especially for specific statistics
- **Super Bowl articles** frequently confuse which teams played in which games
- **World Series articles** often have wrong pitcher credits and inning counts
- **Historical articles** sometimes place figures in wrong time periods
- **"Complete game" claims** are frequently wrong—always verify with box scores
- **Death years** for historical figures are commonly off by 1 year

## Limitations

- Requires manual Grokipedia authentication in browser
- Text selection can fail with special characters (em dashes, curly quotes)
- Parallel workers share browser context (all use same login session)
- Only corrects errors that can be verified with reliable sources
- Copilot SDK rate limits may affect high-throughput processing

## Contributing

1. Fork the repository
2. Run fact-checking on new article categories
3. Submit PRs with your correction logs
4. Improve the detection heuristics

## License

MIT License - See [LICENSE](LICENSE) for details.

## Acknowledgments

- Built with [GitHub Copilot SDK](https://github.com/github/copilot-sdk) and Claude Opus 4.5
- Browser automation via [Playwright](https://playwright.dev)
- Fact verification via web search

---

*This project demonstrates AI-assisted quality control for knowledge bases. Always verify AI-suggested corrections before submitting.*
