---
name: grokipedia-workflow
description: Grokipedia article workflow - fetch, verify, submit corrections using browser automation
---

# Grokipedia Workflow

This skill covers the end-to-end workflow for checking and correcting Grokipedia articles.

## The 3-Step Verification Loop

```
1. FETCH article → 2. VERIFY claims with web_search/Wikipedia → 3. SUBMIT corrections
```

**⚠️ NEVER trust Grok's facts without external verification.** The entire point is cross-referencing.

## Architecture

```
┌─────────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  TypeScript CLI     │────▶│  Playwright/CDP  │────▶│   Grokipedia    │
│  (Copilot SDK)      │     │  Browser Manager │     │   (Target Site) │
└─────────────────────┘     └──────────────────┘     └─────────────────┘
         │
         ▼
┌─────────────────────┐
│  web_search Tool    │  ← PRIMARY VERIFICATION METHOD
└─────────────────────┘
```

## CLI Usage

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

## Session Management Rules

```
Rule of 50: Refresh Copilot session every 50 articles
Rule of 20: New browser tab every 20 articles  
Rule of 100: Full browser restart every 100 articles
```

**Why:** Long-running AI sessions accumulate context, degrading response quality. Browser tabs leak memory.

### Session Refresh Constants

```typescript
const SESSION_REFRESH_INTERVAL = 50;  // Recreate Copilot session
const PAGE_RESET_INTERVAL = 50;       // Recreate browser session
const PAGE_REFRESH_INTERVAL = 20;     // Recreate browser tab
```

## Browser Support

| Browser | Path | Login Persistence |
|---------|------|-------------------|
| Comet | `/Applications/Comet.app` | ✅ Reuses existing session |
| Chrome | `/Applications/Google Chrome.app` | ✅ Reuses existing session |
| Chromium | Playwright-bundled | ❌ Fresh session each run |

**Design decision:** CDP-connected browsers (Comet/Chrome) reuse the user's existing login.

## Common Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Not signed in" | CDP can't find browser | Open Comet/Chrome, log into Grokipedia, leave running |
| Text selection fails | Special characters (em-dash, curly quotes) | Copy text EXACTLY from fetched content |
| Port 9222 busy | Stale browser process | `lsof -ti:9222 \| xargs kill -9` |
| AI gives vague responses | Session context bloat | Restart Copilot session |
| Edits not saving | Grokipedia UI changed | Check if edit button selector still works |

## Workflow Step Details

### Step 1: Fetch Content

```bash
# Using CLI
node dist/index.js -a "Article Name" --dry-run

# Or Python script
python3 .github/skills/grokipedia-fetch-content/fetch_content.py "Article Name"
```

Returns JSON with `content`, `sections`, `signed_in` status, and `url`.

### Step 2: Identify & Verify Claims

**Do NOT just skim.** Proactively verify:
- Birth/death dates of people mentioned
- Event dates (battles, discoveries, inventions)
- Numerical claims (distances, populations, scores)
- Attribution claims (who discovered/invented/said what)

**Verification queries:**
```
web_search("Phineas Gage death date")
web_search("Super Bowl VII final score Dolphins Redskins 1973")
web_fetch url="https://en.wikipedia.org/wiki/Phineas_Gage"
```

### Step 3: Submit Corrections

```bash
python3 .github/skills/grokipedia-submit-edit/submit_edit.py \
  --article "Phineas Gage" \
  --text "Phineas Gage (1823–1861)" \
  --summary "Death year incorrect: Gage died May 21, 1860" \
  --correction "Phineas Gage (1823–1860)" \
  --sources "https://en.wikipedia.org/wiki/Phineas_Gage"
```

## Rate Limiting

- **Grokipedia:** >50 edits/hour triggers soft blocks
- **web_search:** Space searches 2-3 seconds apart in batch runs
- **Wikipedia fetches:** No limits, prefer `web_fetch` for known articles

## Parallel Processing

Each worker gets its own browser page and Copilot session:

```bash
# 3 parallel workers = 3x throughput
node dist/index.js -n 15 -p 3 --dry-run
```

## Golden Rules

1. **Always verify externally** - Never trust Grok's claims without web_search or Wikipedia
2. **Dates and numbers first** - These are Grok's weakest points
3. **Copy text exactly** - Special characters matter for edit submissions
4. **When in doubt, skip it** - Only submit corrections you're 100% confident about
5. **Check the obvious** - Death years, final scores, "first/only/largest" claims

## Quality Checklist

- [ ] Browser running with Grokipedia logged in
- [ ] Port 9222 available (no stale processes)
- [ ] Used --dry-run for testing
- [ ] Verified all corrections externally before submission
- [ ] Respecting rate limits (<50 edits/hour)
