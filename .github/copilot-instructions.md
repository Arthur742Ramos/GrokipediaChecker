# Grokipedia Fact-Checker & Content Improver

> **Purpose**: Automated fact-checking and editing of Grokipedia wiki articles using AI analysis and browser automation.
>
> **Tech Stack**: TypeScript CLI with GitHub Copilot SDK (Claude Opus 4.5), Playwright browser automation, CDP for session persistence.
>
> **Target**: [Grokipedia](https://grokipedia.com) - a wiki-style knowledge base with AI-generated articles that frequently contain subtle factual errors.

---

## Why This Project Exists

Grokipedia articles are **AI-generated** and often contain plausible-sounding but incorrect facts. The errors are subtle—wrong death years, incorrect game scores, misattributed quotes—making them hard to catch by casual reading. This tool automates the tedious verification work by:

1. Fetching article content via browser automation (preserving login state)
2. Using Claude Opus 4.5 to identify verifiable claims
3. Cross-referencing with web search and Wikipedia
4. Submitting corrections directly through Grokipedia's edit UI

**Design decision**: We use browser automation rather than an API because Grokipedia has no public API. The CDP (Chrome DevTools Protocol) approach lets us reuse an existing logged-in browser session.

---

## Architecture at a Glance

```
┌─────────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  TypeScript CLI     │────▶│  Playwright/CDP  │────▶│   Grokipedia    │
│  (Copilot SDK)      │     │  Browser Manager │     │   (Target Site) │
└─────────────────────┘     └──────────────────┘     └─────────────────┘
         │
         ▼
┌─────────────────────┐
│  web_search Tool    │  ← Copilot's built-in fact verification
└─────────────────────┘
```

**Key insight**: The CLI orchestrates Copilot sessions that have access to `web_search` for verification. The AI does the fact-checking reasoning; we just handle browser I/O.

---

## Skill Reference

| Skill | Purpose | When to Use |
|-------|---------|-------------|
| `grokipedia-fetch-content` | Get article text via browser automation | **Always first** - before any analysis |
| `grokipedia-fact-check` | Guidelines for what to verify | Reference during analysis |
| `grokipedia-submit-edit` | Submit corrections via browser | After verifying an error |

---

## Common Pitfalls & Gotchas

### ⚠️ Text Selection Failures
The submit script uses **exact text matching** to find and select content in the browser. Special characters cause failures:
- **Em dashes (—)** vs hyphens (-)
- **Curly quotes ("")** vs straight quotes ("")
- **Non-breaking spaces** vs regular spaces

**Fix**: Copy text exactly from the fetched content, including special characters.

### ⚠️ "Not Signed In" Errors
CDP connects to an existing browser profile. If you see auth errors:
1. Open Comet browser manually
2. Navigate to Grokipedia and log in
3. Leave browser running, then retry

**Why**: The automation reuses your existing session cookies. It cannot log in for you.

### ⚠️ CDP Port Conflicts
If `port 9222` is busy:
```bash
lsof -ti:9222 | xargs kill -9
```
**Why**: Only one process can connect to CDP on a given port. Old browser instances may hold it.

### ⚠️ Memory Leaks in Long Runs
For batch processing (100+ articles), sessions are automatically refreshed:
- Copilot sessions: every 50 articles
- Browser sessions: every 50 articles
- Browser pages: every 20 articles

**Why**: Playwright pages accumulate memory over time. The CLI handles this automatically.

### ⚠️ Sports Articles Have Highest Error Rate
~8-10% error rate in sports articles. Common issues:
- Wrong pitcher credited for wins/losses
- "Complete game" claims that are actually 8+ innings with a reliever
- Confused team matchups (which teams played which Super Bowl)
- Wrong hit/RBI/medal counts

**Why**: Sports stats are precise and easily verifiable, but AI often hallucinates specific numbers.

---

## Error Types Found in Production

| Category | Examples | Frequency | Verification Strategy |
|----------|----------|-----------|----------------------|
| **Wrong Numbers** | Scores, medal counts, distances | High | Cross-check with Wikipedia/ESPN |
| **Wrong Names** | Misattributed plays, wrong broadcasters | Medium | Search for specific event details |
| **Wrong Dates** | Death years off by 1, wrong centuries | Medium | Wikipedia infoboxes |
| **Complete Game Claims** | Pitcher credited with CG but used reliever | Medium | Check box scores |
| **Chronological Errors** | Historical figures in wrong time periods | Medium | Verify birth/death dates first |
| **Superlative Errors** | "First," "only," "largest" claims | Low | These are often wrong |

---

## Workflow: Analyzing an Article

### Step 1: Fetch Content
```bash
python3 .github/skills/grokipedia-fetch-content/fetch_content.py "Article Name"
```

Returns JSON with `content`, `sections`, `signed_in` status, and `url`.

### Step 2: Identify Verifiable Claims

**Do NOT just skim**. Proactively verify:
- Birth/death dates of people mentioned
- Event dates (battles, discoveries, inventions)
- Numerical claims (distances, populations, scores)
- Attribution claims (who discovered/invented/said what)

### Step 3: Verify with Web Search

```
web_search("Phineas Gage death date 1860")
web_search("Super Bowl VII final score Dolphins Redskins")
```

Or fetch Wikipedia directly:
```
web_fetch url="https://en.wikipedia.org/wiki/Phineas_Gage"
```

**Key insight**: Pick 3-5 specific, verifiable facts per article. Focus on dates and numbers—these are most error-prone.

### Step 4: Submit Corrections

```bash
python3 .github/skills/grokipedia-submit-edit/submit_edit.py \
  --article "Phineas Gage" \
  --text "Phineas Gage (1823–1861)" \
  --summary "Death year incorrect: Gage died May 21, 1860" \
  --correction "Phineas Gage (1823–1860)" \
  --sources "https://en.wikipedia.org/wiki/Phineas_Gage"
```

---

## What NOT to Correct

- **Stylistic preferences** (unless genuinely awkward)
- **Regional spelling** (color vs colour)
- **Disputed facts** where multiple interpretations exist
- **Unverifiable claims** - if you can't find a source, skip it
- **Unusual but correct facts** - verify before assuming error

---

## TypeScript CLI Usage (Recommended)

The TypeScript CLI in `cli/` is the primary interface:

```bash
cd cli
npm install && npm run build

# Single article, dry run (no submissions)
node dist/index.js -a "Bermuda Triangle" --dry-run

# 10 articles with 3 parallel workers
node dist/index.js -n 10 -p 3 --dry-run

# Theme-based with Comet browser
node dist/index.js -n 5 -t "super bowl" -b comet

# Verbose mode (see AI reasoning)
node dist/index.js -n 2 -v --dry-run
```

**Why parallel workers?** Each worker gets its own browser page and Copilot session, enabling 3-5x throughput for batch processing.

---

## Technical Details

### Browser Support
| Browser | Path | Login Persistence |
|---------|------|-------------------|
| Comet | `/Applications/Comet.app` | ✅ Reuses existing session |
| Chrome | `/Applications/Google Chrome.app` | ✅ Reuses existing session |
| Chromium | Playwright-bundled | ❌ Fresh session each run |

**Design decision**: We default to CDP-connected browsers (Comet/Chrome) because Grokipedia requires authentication, and we want to reuse the user's existing login rather than handle credentials.

### Session Refresh Strategy
```typescript
const SESSION_REFRESH_INTERVAL = 50;  // Recreate Copilot session
const PAGE_RESET_INTERVAL = 50;       // Recreate browser session
const PAGE_REFRESH_INTERVAL = 20;     // Recreate browser tab
```

**Why**: Long-running Copilot sessions accumulate context. Periodic refresh prevents OOM errors and keeps response quality high.

### Requirements
- macOS (browser paths are macOS-specific)
- Node.js 18+
- User logged into Grokipedia in Comet/Chrome
- Python 3.8+ with Playwright (for legacy scripts)
