---
name: grokipedia-submit-edit
description: Submits edit corrections to Grokipedia articles through the browser UI. Use this when asked to submit, apply, or make corrections to Grokipedia articles.
---

# Grokipedia Edit Submitter

This skill submits corrections to Grokipedia articles using the browser-based edit flow.

## How to submit an edit

Run the `submit_edit.py` script:

```bash
python3 .github/skills/grokipedia-submit-edit/submit_edit.py \
  --article "Article Name" \
  --text "text to select and correct" \
  --summary "Description of the correction" \
  --correction "The corrected text" \
  --sources "https://source1.com,https://source2.com"
```

## Parameters

- `--article` (required): The article name to edit
- `--text` (required): The exact text to select for correction
- `--summary` (required): A brief description of why this correction is needed
- `--correction` (optional): The replacement text
- `--sources` (optional): Comma-separated list of source URLs

## How it works

1. Launches Comet browser with existing profile (user must be logged in)
2. Navigates to the article page
3. Selects the specified text on the page
4. Clicks "Suggest Edit" button
5. Fills in the edit form with summary, correction, and sources
6. Submits the edit

## Requirements

- Comet browser installed at `/Applications/Comet.app`
- Playwright Python package (`pip install playwright`)
- User must be logged into Grokipedia in Comet browser

## Example

```bash
# Fix an inconsistent measurement
python3 .github/skills/grokipedia-submit-edit/submit_edit.py \
  --article "Marree Man" \
  --text "approximately 2.7 kilometers (1.7 miles) in height" \
  --summary "Fix inconsistent measurement - article states 3.5km elsewhere" \
  --correction "approximately 3.5 kilometers (2.2 miles) in height"
```

## Output

The script outputs JSON with the result:

```json
{
  "success": true,
  "article": "Marree Man",
  "text_selected": "approximately 2.7 kilometers...",
  "summary": "Fix inconsistent measurement...",
  "message": "Edit submitted successfully"
}
```

## Sequential Submission

Submit corrections to the same article sequentially:

```bash
# Submit first correction
python3 .github/skills/grokipedia-submit-edit/submit_edit.py --article "Article Name" --text "first text" ...

# Wait for completion, then submit next correction
python3 .github/skills/grokipedia-submit-edit/submit_edit.py --article "Article Name" --text "second text" ...
```

Process articles one at a time for reliability. Complete all corrections for one article before moving to the next.
