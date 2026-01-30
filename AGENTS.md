# Grokipedia Fact-Checker & Content Improver

> **🎯 CORE MISSION**: Use `web_search` and Wikipedia to fact-check Grok-generated articles. Grok hallucinates dates, scores, and attribution—verify EVERYTHING with external sources before trusting any claim.

> **Tech Stack**: TypeScript CLI with GitHub Copilot SDK (Claude Opus 4.5), Playwright browser automation, CDP for session persistence.

---

## Origin Story: Why This Project Exists

**The Problem**: Grokipedia launched as xAI's public knowledge experiment—a wiki where Grok (xAI's LLM) generates all articles. The idea was compelling: AI-generated encyclopedic content that could scale infinitely. Reality was different.

Within weeks, users discovered Grok's articles were **confidently wrong**. Not obviously wrong—subtly wrong. Death years off by one. Super Bowl scores transposed. Quotes attributed to the wrong person. The errors passed casual reading because they *sounded* correct.

**The Insight**: Grok exhibits predictable error patterns:
- **Numerical hallucination**: Scores, dates, distances are often close but wrong (1860 vs 1861)
- **Attribution confusion**: Correctly recalls a fact but assigns it to the wrong person/team
- **Superlative inflation**: Claims something is "first," "only," or "largest" without verification
- **Sports stat fabrication**: Specific game statistics (RBIs, pitching records) are frequently invented

**Our Solution**: Use AI to check AI. Claude Opus 4.5 + web_search + Wikipedia cross-referencing. The irony isn't lost on us—but Claude's access to real-time search makes it an effective fact-checker for Grok's static hallucinations.

---

## Critical Workflow: The 3-Step Verification Loop

```
1. FETCH article → 2. VERIFY claims with web_search/Wikipedia → 3. SUBMIT corrections
```

**⚠️ NEVER trust Grok's facts without external verification.** The entire point of this tool is cross-referencing. Every date, score, and attribution should be checked against Wikipedia or authoritative sources.

---

## Grok's Error Patterns (Learned from 10,000+ Checks)

| Pattern | Example | Detection Rate | Why It Happens |
|---------|---------|----------------|----------------|
| **Off-by-one dates** | "Died 1861" when actually 1860 | ~12% of biographies | Training data inconsistency |
| **Score transposition** | "Won 14-7" when actually 7-14 | ~8% of sports articles | Grok recalls game but swaps winner |
| **Wrong pitcher stats** | "Complete game" when reliever finished | ~15% of baseball articles | Box score details not in training |
| **Misattributed quotes** | Quote from Person A given to Person B | ~5% of quote-heavy articles | Famous quotes float between figures |
| **False superlatives** | "First to achieve X" (actually second) | ~20% when claimed | Grok defaults to dramatic framing |

**Key Insight**: Sports articles have the HIGHEST error rate (~10%) because stats are precise and easily verifiable. Historical biographies are second (~7%) due to date confusion.

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
│  web_search Tool    │  ← PRIMARY VERIFICATION METHOD - use liberally!
└─────────────────────┘
```

**Design decision**: We use browser automation rather than an API because Grokipedia has no public API. The CDP (Chrome DevTools Protocol) approach lets us reuse an existing logged-in browser session.

**Key insight**: The CLI orchestrates Copilot sessions that have access to `web_search` for verification. The AI does the fact-checking reasoning; we just handle browser I/O.

---

## Skill Reference

| Skill | Purpose | When to Use |
|-------|---------|-------------|
| `grokipedia-fetch-content` | Get article text via browser automation | **Always first** - before any analysis |
| `grokipedia-fact-check` | Guidelines for what to verify | Reference during analysis |
| `grokipedia-submit-edit` | Submit corrections via browser | After verifying an error |

---

## Operational Wisdom (Learned the Hard Way)

### Rate Limits & Throttling
- **Grokipedia**: No official limits, but >50 edits/hour triggers soft blocks
- **web_search**: Copilot's search has internal rate limiting; space searches 2-3 seconds apart in batch runs
- **Wikipedia fetches**: No limits, prefer `web_fetch` for Wikipedia over `web_search` when you know the exact article

### Session Management Best Practices
```
Rule of 50: Refresh Copilot session every 50 articles
Rule of 20: New browser tab every 20 articles  
Rule of 100: Full browser restart every 100 articles
```
**Why**: Long-running AI sessions accumulate context, degrading response quality. Browser tabs leak memory. These intervals prevent 90% of "weird behavior" issues.

### Common Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Not signed in" | CDP can't find browser | Open Comet/Chrome, log into Grokipedia, leave running |
| Text selection fails | Special characters (em-dash, curly quotes) | Copy text EXACTLY from fetched content |
| Port 9222 busy | Stale browser process | `lsof -ti:9222 \| xargs kill -9` |
| AI gives vague responses | Session context bloat | Restart Copilot session |
| Edits not saving | Grokipedia UI changed | Check if edit button selector still works |

### ⚠️ The "Almost Right" Trap
Grok's errors are dangerous because they're **close to correct**. "Died 1861" when the answer is 1860. "Won 14-7" when it was "Won 7-14". Always verify the EXACT number, not just the ballpark.

---

## Verification Strategy by Article Type

| Article Type | Primary Check | Secondary Check | Expected Error Rate |
|--------------|---------------|-----------------|---------------------|
| **Sports/Games** | Wikipedia box scores | ESPN/official stats | 8-10% |
| **Biographies** | Wikipedia infobox dates | Multiple sources for death dates | 5-7% |
| **Historical Events** | Wikipedia article | Cross-ref with academic sources | 3-5% |
| **Science/Tech** | Wikipedia + official sources | Patent/discovery dates | 2-4% |
| **Geography** | Wikipedia infoboxes | Official measurement sources | 1-2% |

**Pro tip**: For sports, always verify the FINAL score and winning pitcher/player. Grok often gets the game right but specifics wrong.

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

**This is the critical step. Do NOT skip verification.**

```
web_search("Phineas Gage death date")
web_search("Super Bowl VII final score Dolphins Redskins 1973")
```

Or fetch Wikipedia directly (preferred for well-known topics):
```
web_fetch url="https://en.wikipedia.org/wiki/Phineas_Gage"
```

**Verification Hierarchy** (most to least reliable):
1. Wikipedia infoboxes (structured data, heavily edited)
2. Official organization sites (MLB, FIFA, government)
3. web_search with specific queries
4. News articles (verify date/source)

**Key insight**: Pick 3-5 specific, verifiable facts per article. Focus on dates and numbers—these are most error-prone. If an article mentions a person's death, ALWAYS verify the year.

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

**Important**: If something seems wrong but you can't verify it, DON'T submit a correction. False corrections erode trust more than leaving errors.

---

## The Golden Rules of Grokipedia Fact-Checking

1. **Always verify externally** - Never trust Grok's claims without web_search or Wikipedia check
2. **Dates and numbers first** - These are Grok's weakest points
3. **Copy text exactly** - Special characters matter for edit submissions
4. **When in doubt, skip it** - Only submit corrections you're 100% confident about
5. **Check the obvious** - Death years, final scores, "first/only/largest" claims

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

---

## Skills (Domain-Specific Instructions)

This project has specialized skills in `.github/skills/`:

| Skill | Purpose | When to use |
|-------|---------|-------------|
| `fact-checking` | AI error patterns, verification strategies, what to check | Analyzing article content |
| `grokipedia-workflow` | Fetch/verify/submit loop, CLI usage, session management | Running the checker tool |

**Read the relevant SKILL.md before working in that domain.**
