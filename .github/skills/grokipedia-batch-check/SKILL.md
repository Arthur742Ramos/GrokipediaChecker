---
name: grokipedia-batch-check
description: Batch fact-checks and improves multiple Grokipedia articles sequentially. Use this when asked to check many articles at once.
---

# Grokipedia Batch Checker

This skill provides utilities for sequential fact-checking and content improvement of multiple Grokipedia articles.

## Sequential Workflow

Process articles one at a time for reliability:

### Stage 1: Fetch Article
```bash
cd /Users/arthur/Desktop/Grokipedia
python3 ../.github/skills/grokipedia-fetch-content/fetch_content.py "Article Name"
```

### Stage 2: AI Analysis
Analyze the article for:

**Factual Issues:**
- Factual errors (dates, numbers, names)
- Internal inconsistencies
- Outdated information

**Writing Quality Issues:**
- Awkward or confusing phrasing
- Run-on sentences
- Grammar and spelling errors
- Redundancy and wordiness
- Jargon without explanation
- Unclear pronoun references

### Stage 3: Verification
Verify suspicious claims:
- Use `web_search` for quick fact verification
- Use `web_fetch` for detailed Wikipedia checks

### Stage 4: Submit Corrections
Submit all corrections for the current article before moving to the next:
```bash
python3 ../.github/skills/grokipedia-submit-edit/submit_edit.py --article "Article Name" ...
```

### Stage 5: Move to Next Article
Repeat stages 1-4 for the next article.

## Sample Article Lists

### Historical Mysteries
```
Roanoke Colony, Voynich manuscript, Dyatlov Pass incident, 
Dancing plague of 1518, Cottingley Fairies, Piltdown Man
```

### Ancient Monuments
```
Stonehenge, Rosetta Stone, Terracotta Army, Library of Alexandria,
Easter Island, Antikythera mechanism
```

### Unusual Animals
```
Platypus, Okapi, Axolotl, Tardigrade, Mantis shrimp, Blobfish
```

### Scientific Anomalies
```
Tunguska event, Wow signal, Bloop, Lake Nyos disaster,
Spontaneous human combustion, Baghdad Battery
```

## Output Format

Track results in a summary:

```markdown
## Batch Fact-Check Results

| Article | Status | Issues Found | Corrections Submitted |
|---------|--------|--------------|----------------------|
| Article 1 | ✅ Verified | 0 | 0 |
| Article 2 | ⚠️ Issues | 2 | 2 |
| Article 3 | ❌ Not found | - | - |
```

## Tips

1. **Check if article exists first** - look for "This page doesn't exist" in response
2. **Verify before submitting** - only submit corrections you can verify
3. **Keep text selections short** - 5-15 words for reliable matching
4. **Add sources** - Wikipedia URLs are good supporting evidence
5. **Check writing quality** - not just facts, also clarity and readability
6. **Report progress** - summarize every 10-20 articles processed
