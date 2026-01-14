# Grokipedia Fact-Checker & Content Improver

An AI-powered tool for automated fact-checking, content improvement, and editing of [Grokipedia](https://grokipedia.com) articles using GitHub Copilot CLI and browser automation.

## 🎯 What It Does

This project systematically analyzes Grokipedia articles to:

- **Fact-check claims** using web search verification
- **Identify factual errors** (wrong dates, numbers, names, scores)
- **Detect internal inconsistencies** (conflicting information within articles)
- **Find writing quality issues** (awkward phrasing, clarity problems, grammar errors)
- **Submit corrections** directly via browser automation

## 📊 Results

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
- **Phineas Gage**: Death year 1861 → actually **1860**

## 🛠️ How It Works

### Architecture

```
┌─────────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  GitHub Copilot CLI │────▶│  Browser Scripts │────▶│   Grokipedia    │
│  (AI Analysis)      │     │  (Playwright/CDP)│     │   (Target Site) │
└─────────────────────┘     └──────────────────┘     └─────────────────┘
         │                           │
         ▼                           ▼
┌─────────────────────┐     ┌──────────────────┐
│  Web Search API     │     │  Comet Browser   │
│  (Fact Verification)│     │  (Authenticated) │
└─────────────────────┘     └──────────────────┘
```

### Workflow

1. **Fetch Article** → `fetch_content.py` retrieves article text via browser automation
2. **AI Analysis** → Copilot identifies 3-5 verifiable claims per article
3. **Fact Verification** → Web search confirms or refutes claims
4. **Submit Corrections** → `submit_edit.py` submits verified corrections

## 🚀 Quick Start

### Prerequisites

- macOS with [Comet Browser](https://comet.com) (or modify for Chrome)
- Python 3.8+
- Node.js 16+
- GitHub Copilot CLI access

### Installation

```bash
# Clone the repository
git clone https://github.com/Arthur742Ramos/GrokipediaChecker.git
cd GrokipediaChecker

# Install Python dependencies
pip install playwright
playwright install chromium

# Log into Grokipedia manually in Comet browser first
```

### Usage

#### Fetch an Article
```bash
python3 .github/skills/grokipedia-fetch-content/fetch_content.py "Super Bowl VII"
```

#### Submit a Correction
```bash
python3 .github/skills/grokipedia-submit-edit/submit_edit.py \
  --article "Super Bowl VII" \
  --text "returned for a near-score" \
  --summary "Mike Bass returned it 49 yards for a touchdown, not a near-score" \
  --correction "returned 49 yards for a touchdown" \
  --sources "https://en.wikipedia.org/wiki/Super_Bowl_VII"
```

## 📁 Project Structure

```
GrokipediaChecker/
├── .github/
│   ├── copilot-instructions.md    # AI agent instructions
│   └── skills/
│       ├── grokipedia-fetch-content/
│       │   └── fetch_content.py   # Article fetcher
│       ├── grokipedia-submit-edit/
│       │   └── submit_edit.py     # Correction submitter
│       ├── grokipedia-fact-check/
│       │   └── SKILL.md           # Fact-checking guidelines
│       └── grokipedia-batch-check/
│           └── SKILL.md           # Batch processing guide
├── fact_checker.py                # Standalone fact-checker
├── batch_fact_checker.py          # Batch processing script
├── grokipedia_editor.py           # Editor utilities
├── fact_check_results.json        # Results log
└── README.md
```

## 🔍 Error Types Found

| Category | Examples | Frequency |
|----------|----------|-----------|
| **Wrong Numbers** | Hit counts, scores, medal counts | High |
| **Wrong Names** | Pitcher who gave up HR, broadcaster | Medium |
| **Wrong Dates** | Death years, game dates | Medium |
| **Sequence Errors** | Events in wrong order | Low |
| **Superlative Errors** | "First," "only" claims that are false | Low |
| **Complete Game Claims** | Pitcher credited with CG but used reliever | Medium |

## 💡 Key Insights

- **Sports articles have the highest error rate** (~8-10%), especially for specific statistics
- **Super Bowl articles** frequently confuse which teams played in which games
- **World Series articles** often have wrong pitcher credits and inning counts
- **"Complete game" claims** are frequently wrong—always verify with box scores
- **Death years** for historical figures are commonly off by 1 year

## ⚠️ Limitations

- Requires manual Grokipedia authentication in browser
- Text selection can fail with special characters (em dashes, curly quotes)
- Rate-limited by browser automation speed
- Only corrects errors that can be verified with reliable sources

## 🤝 Contributing

1. Fork the repository
2. Run fact-checking on new article categories
3. Submit PRs with your correction logs
4. Improve the detection heuristics

## 📜 License

MIT License - See [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- Built with [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli)
- Browser automation via [Playwright](https://playwright.dev)
- Fact verification via Bing AI Search

---

*This project demonstrates AI-assisted quality control for knowledge bases. Always verify AI-suggested corrections before submitting.*
