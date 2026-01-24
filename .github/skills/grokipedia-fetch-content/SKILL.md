---
name: grokipedia-fetch-content
description: Fetches and extracts article content from Grokipedia pages. Use this when asked to get, read, or fetch content from a Grokipedia article.
---

# Grokipedia Content Fetcher

This skill fetches article content from Grokipedia using the Comet browser with existing authentication.

## How to fetch content

Run the `fetch_content.py` script with an article name:

```bash
.venv/bin/python .github/skills/grokipedia-fetch-content/fetch_content.py "Article Name"
```

The script will:
1. Launch Comet browser with your existing profile (preserving login)
2. Navigate to the article page
3. Extract and output the article content as JSON

## Output format

The script outputs JSON with:
- `article`: The article name
- `url`: The full URL
- `signed_in`: Whether the user is authenticated
- `content`: The full article text
- `sections`: Array of sections with `level`, `title`, and `content`

## Requirements

- Comet browser installed at `/Applications/Comet.app`
- Playwright Python package (`pip install playwright`)
- User must be logged into Grokipedia in Comet browser

## Example usage

```bash
# Fetch Lambda calculus article
.venv/bin/python .github/skills/grokipedia-fetch-content/fetch_content.py "Lambda calculus"

# Fetch with spaces in name
.venv/bin/python .github/skills/grokipedia-fetch-content/fetch_content.py "Marree Man"
```

## Sequential Processing

Process articles one at a time for reliability:

```bash
# Process articles sequentially
.venv/bin/python .github/skills/grokipedia-fetch-content/fetch_content.py "Article 1"
# Analyze, verify, submit corrections...

.venv/bin/python .github/skills/grokipedia-fetch-content/fetch_content.py "Article 2"
# Analyze, verify, submit corrections...
```
