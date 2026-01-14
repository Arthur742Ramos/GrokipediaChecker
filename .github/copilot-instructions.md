# Grokipedia Fact-Checker & Content Improver

This project provides tools for automated fact-checking, content improvement, and editing of Grokipedia articles.

## Overview

Grokipedia is a wiki-style knowledge base. This project helps identify factual errors, inconsistencies, awkward phrasing, and areas for improvement in articles, then submits corrections through the browser UI.

## When to Use Each Skill

| Skill | When to Call |
|-------|-------------|
| `grokipedia-fetch-content` | First step - always call this to get article text before any analysis |
| `grokipedia-fact-check` | Reference these guidelines while analyzing fetched content |
| `grokipedia-submit-edit` | After finding and verifying an issue, call this to submit the correction |

## Complete Workflow

### Step 1: Fetch Article Content
```bash
python3 .github/skills/grokipedia-fetch-content/fetch_content.py "Article Name"
```
This returns JSON with:
- `article`: Article name
- `url`: Full URL
- `signed_in`: Whether user is authenticated
- `content`: Full article text
- `sections`: Parsed section structure

### Step 2: AI Analysis (You Do This)

Read the content carefully and identify issues in two categories:

#### A. Factual Issues
- **Internal inconsistencies**: Same fact stated with different values (e.g., "3.5 km" vs "2.7 km")
- **Factual errors**: Wrong dates, names, numbers, death years, measurements
- **Logical contradictions**: Statements that conflict with each other
- **Outdated info**: Facts that have changed since article was written

#### B. Writing Quality Issues
- **Awkward phrasing**: Sentences that read poorly or are hard to understand
- **Clarity problems**: Text that could be explained more simply
- **Redundancy**: Unnecessary repetition of information
- **Grammar errors**: Incorrect grammar, punctuation, or spelling
- **Jargon without context**: Technical terms not explained for general readers
- **Run-on sentences**: Long sentences that should be split

### Step 3: PROACTIVE Fact-Checking with Web Search (CRITICAL)

**Do NOT just skim for obvious errors.** Actively verify key claims in every article:

#### What to Verify
- **Birth/death dates** of people mentioned
- **Event dates** (battles, discoveries, inventions)
- **Numerical claims** (distances, populations, measurements)
- **Names and titles** (people, places, organizations)
- **Scientific facts** (formulas, discoveries, attributions)
- **Historical claims** (who did what, when, where)

#### How to Verify
Use `web_search` for quick verification:
```
web_search("Albert Einstein birth date March 14 1879")
web_search("Great Wall of China length kilometers")
web_search("Battle of Actium date 31 BC")
```

Or fetch Wikipedia directly for comprehensive cross-checking:
```
web_fetch url="https://en.wikipedia.org/wiki/Article_Name"
```

#### Verification Strategy
1. **Pick 3-5 key facts** from each article to verify
2. **Focus on specifics**: dates, numbers, names are most error-prone
3. **Cross-reference** with Wikipedia or authoritative sources
4. **Look for discrepancies** between article and verified sources

**IMPORTANT**: Don't assume well-written articles are factually correct. Always verify before moving to the next article.

### Step 4: Submit Corrections

For each confirmed issue:
```bash
python3 .github/skills/grokipedia-submit-edit/submit_edit.py \
  --article "Article Name" \
  --text "exact text to correct" \
  --summary "Clear explanation of why this needs correction" \
  --correction "The fixed text" \
  --sources "https://source-url.com"
```

Parameters:
- `--article`: Article title (required)
- `--text`: The exact text from the article to select (required)
- `--summary`: Explanation for the edit (required)
- `--correction`: The corrected version of the text (optional, for content changes)
- `--sources`: URL(s) supporting the correction (optional but recommended)

## Example Session

```bash
# 1. Fetch the article
python3 .github/skills/grokipedia-fetch-content/fetch_content.py "Phineas Gage"

# 2. AI reads content, notices "Phineas Gage (1823–1861)"

# 3. Verify with web search - finds he died in 1860, not 1861

# 4. Submit correction
python3 .github/skills/grokipedia-submit-edit/submit_edit.py \
  --article "Phineas Gage" \
  --text "Phineas Gage (1823–1861)" \
  --summary "Incorrect death year: Gage died May 21, 1860, not 1861" \
  --correction "Phineas Gage (1823–1860)" \
  --sources "https://en.wikipedia.org/wiki/Phineas_Gage"
```

## Batch Processing Multiple Articles

Process articles **sequentially** for reliability:

### Sequential Workflow

```bash
# Process one article at a time
python3 .github/skills/grokipedia-fetch-content/fetch_content.py "Article 1"
# Analyze, verify, submit corrections...

python3 .github/skills/grokipedia-fetch-content/fetch_content.py "Article 2"
# Analyze, verify, submit corrections...
```

### Recommended Sequential Workflow

1. **Fetch article** - get content for one article
2. **AI analysis** - analyze for factual errors AND writing quality issues
3. **Verify claims** - use web_search to verify suspicious facts
4. **Submit corrections** - submit all corrections for that article
5. **Move to next article** - repeat for next article
6. **Report summary** periodically (every 10-20 articles)

### What to Check in Each Article

#### Proactive Fact-Checking (REQUIRED)
For EVERY article, verify at least 3-5 key facts using web_search:
- Birth/death dates of main subjects
- Key event dates and locations
- Numerical claims (distances, populations, measurements)
- Attribution of discoveries, inventions, quotes

#### Factual Issues to Look For
- Incorrect dates, names, numbers
- Internal inconsistencies
- Outdated information

#### Writing Quality Issues (IMPORTANT)
- **Awkward phrasing** - sentences that read poorly
- **Clarity problems** - text that could be simpler
- **Redundancy** - unnecessary repetition
- **Grammar errors** - incorrect grammar, punctuation, spelling
- **Run-on sentences** - long sentences that should be split
- **Jargon without context** - technical terms not explained

## What NOT to Correct

- Minor stylistic preferences (unless genuinely awkward)
- Regional spelling differences (color vs colour)
- Disputed facts where multiple valid interpretations exist
- Claims you cannot verify with reliable sources
- Correct information that just seems unusual

## Technical Details

### Browser Automation
- Uses Comet browser with Chrome DevTools Protocol (CDP)
- Port 9222 for CDP connection
- Runs in headless mode (no window focus stealing)
- Preserves authentication via existing Comet profile

### Requirements
- macOS with Comet browser at `/Applications/Comet.app`
- User logged into Grokipedia in Comet
- Python 3 with Playwright (`pip install playwright`)

### Troubleshooting
- If "not signed in", open Comet manually and log into Grokipedia first
- If CDP port busy, kill existing process: `lsof -ti:9222 | xargs kill -9`
- If browser opens visible window, check headless flag in scripts
