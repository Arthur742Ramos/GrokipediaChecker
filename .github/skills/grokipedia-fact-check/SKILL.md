---
name: grokipedia-fact-check
description: Analyzes Grokipedia article content for factual errors, inconsistencies, text improvements, or awkward phrasing. Use this when asked to fact-check, verify, improve, or find errors in Grokipedia content.
---

# Grokipedia Fact Checker & Content Improver

This skill guides the AI to analyze article content and identify factual errors, internal inconsistencies, awkward phrasing, or areas for improvement.

## Workflow

1. **Fetch content**: Run the fetch script to get article content
   ```bash
   python3 .github/skills/grokipedia-fetch-content/fetch_content.py "Article Name"
   ```

2. **AI Analysis**: Carefully read the content and check for:
   - **Internal inconsistencies**: Same fact stated differently (e.g., "3.5km" vs "2.7km" for the same measurement)
   - **Factual errors**: Incorrect dates, names, numbers, or claims that contradict known facts
   - **Logical contradictions**: Statements that contradict each other
   - **Outdated information**: Facts that may have changed
   - **Awkward phrasing**: Sentences that are hard to read or grammatically incorrect
   - **Clarity issues**: Text that could be explained more clearly
   - **Redundancy**: Unnecessary repetition of information
   - **Missing context**: Important details that would help readers understand

3. **PROACTIVE Fact-Checking (REQUIRED)**: 
   
   **Do NOT just skim for obvious errors.** For EVERY article, actively verify 3-5 key facts using web_search:
   
   ```bash
   # Verify birth/death dates
   web_search("Albert Einstein birth date March 14 1879")
   
   # Verify event dates
   web_search("Battle of Actium date 31 BC")
   
   # Verify numerical claims
   web_search("Great Wall of China total length kilometers")
   
   # Verify attributions
   web_search("who discovered penicillin Alexander Fleming 1928")
   ```
   
   **What to verify in each article:**
   - Birth/death dates of people mentioned
   - Key event dates and locations
   - Numerical claims (distances, populations, measurements)
   - Names and titles of people, places, organizations
   - Scientific facts and discoveries
   - Historical claims and attributions
   
   **IMPORTANT**: A well-written article can still have factual errors. Always verify before moving on.

4. **Submit corrections**: For confirmed errors or improvements, use the submit skill

## What to Look For

### Numbers and Measurements
- Same distance/size stated with different values
- Incorrect unit conversions (km to miles, etc.)
- Population figures, dates, or statistics that seem wrong

### Dates and Timeline
- Birth/death dates that don't match known records
- Events placed in wrong years or centuries
- Chronological inconsistencies (event B before event A when A caused B)

### Names and Attribution
- Misspelled names of people, places, or things
- Wrong attribution of discoveries, inventions, or quotes
- Confused identities (mixing up similar people)

### Scientific/Technical Claims
- Outdated scientific consensus
- Incorrect technical specifications
- Misrepresented research findings

### Writing Quality
- Awkward or confusing sentence structure
- Run-on sentences that should be split
- Passive voice where active would be clearer
- Jargon or technical terms without explanation
- Unclear pronoun references
- Redundant phrases (e.g., "past history", "completely unanimous")

## Output Format

After analysis, report findings as:

```json
{
  "article": "Article Name",
  "issues": [
    {
      "type": "inconsistency|error|outdated|clarity|grammar",
      "text": "The exact problematic text from the article",
      "problem": "Clear description of what's wrong",
      "correction": "The corrected text",
      "confidence": "high|medium|low",
      "sources": ["URL if verified externally"]
    }
  ]
}
```

## Example Analysis

### Factual Error Example
For an article stating "Phineas Gage (1823–1861)":
```json
{
  "type": "error",
  "text": "Phineas Gage (1823–1861)",
  "problem": "Incorrect death year - Gage died in 1860, not 1861",
  "correction": "Phineas Gage (1823–1860)",
  "confidence": "high",
  "sources": ["https://en.wikipedia.org/wiki/Phineas_Gage"]
}
```

### Writing Improvement Example
For awkward phrasing like "The event which occurred was very significant in nature":
```json
{
  "type": "clarity",
  "text": "The event which occurred was very significant in nature",
  "problem": "Wordy and awkward phrasing",
  "correction": "The event was highly significant",
  "confidence": "high",
  "sources": []
}
```

## Important Guidelines

- Only flag issues you are confident about
- For uncertain claims, use web_search to verify before flagging
- Prefer not submitting over submitting incorrect corrections
- Multiple different measurements in an article are normal if they refer to different things
