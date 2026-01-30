---
name: fact-checking
description: AI-generated content fact-checking patterns - verifying dates, numbers, and attribution claims
---

# AI Fact-Checking Patterns

This skill covers systematic verification of AI-generated content, with patterns learned from checking 10,000+ articles.

## Core Principle

> **AI errors are dangerous because they're CLOSE to correct.** "Died 1861" when the answer is 1860. "Won 14-7" when it was 7-14. Always verify the EXACT number, not just the ballpark.

## Common AI Error Patterns

| Pattern | Example | Frequency | Why It Happens |
|---------|---------|-----------|----------------|
| **Off-by-one dates** | "Died 1861" when actually 1860 | ~12% of biographies | Training data inconsistency |
| **Score transposition** | "Won 14-7" when actually 7-14 | ~8% of sports articles | AI recalls game but swaps winner |
| **Wrong stat attribution** | "Complete game" when reliever finished | ~15% of sports | Box score details fuzzy |
| **Misattributed quotes** | Quote from Person A given to Person B | ~5% of quote-heavy articles | Famous quotes float between figures |
| **False superlatives** | "First to achieve X" (actually second) | ~20% when claimed | AI defaults to dramatic framing |

## Error Rates by Content Type

| Article Type | Expected Error Rate | Primary Check | Secondary Check |
|--------------|---------------------|---------------|-----------------|
| **Sports/Games** | 8-10% | Wikipedia box scores | ESPN/official stats |
| **Biographies** | 5-7% | Wikipedia infobox dates | Multiple sources for death dates |
| **Historical Events** | 3-5% | Wikipedia article | Academic sources |
| **Science/Tech** | 2-4% | Wikipedia + official sources | Patent/discovery dates |
| **Geography** | 1-2% | Wikipedia infoboxes | Official measurements |

## Verification Hierarchy

From most to least reliable:

1. **Wikipedia infoboxes** - Structured data, heavily edited
2. **Official organization sites** - MLB, FIFA, government
3. **web_search with specific queries** - Good for recent events
4. **News articles** - Verify date/source

## What to Verify (Priority Order)

1. **Death dates** - Most commonly wrong in biographies
2. **Final scores** - Sports articles often transpose
3. **Superlatives** - "First," "only," "largest" claims
4. **Specific statistics** - RBIs, pitching records, medal counts
5. **Attribution** - Who said/discovered/invented what

## Verification Query Patterns

```
# For death dates
web_search("Phineas Gage death date")

# For sports scores (be specific)
web_search("Super Bowl VII final score Dolphins Redskins 1973")

# For records/achievements
web_search("first person to climb K2 winter")

# Prefer Wikipedia fetch when you know the topic
web_fetch url="https://en.wikipedia.org/wiki/Phineas_Gage"
```

## The "Almost Right" Trap

AI errors are insidious because they:
- Sound confident
- Are often close to correct
- Pass casual reading
- Only fail on precise verification

**Key insight:** If something "sounds right," that's when you MUST verify. Obvious errors are easy to catch; subtle ones require discipline.

## What NOT to Correct

- **Stylistic preferences** (unless genuinely awkward)
- **Regional spelling** (color vs colour)
- **Disputed facts** where multiple interpretations exist
- **Unverifiable claims** - if you can't find a source, skip it
- **Unusual but correct facts** - verify before assuming error

**Important:** If something seems wrong but you can't verify it, DON'T mark it as an error. False positives erode trust more than missed errors.

## Batch Verification Strategy

When checking multiple articles:

1. **Start with high-risk categories** - Sports first, then biographies
2. **Focus on 3-5 verifiable facts per article** - Don't try to check everything
3. **Prioritize dates and numbers** - These are most error-prone
4. **Skip vague claims** - Focus on precise, checkable statements

## Documentation Pattern

When documenting errors:

```
CLAIM: "Phineas Gage died in 1861"
SOURCE: https://en.wikipedia.org/wiki/Phineas_Gage
FACT: Gage died May 21, 1860
ERROR TYPE: Off-by-one date
CONFIDENCE: High (Wikipedia infobox)
```

## Quality Checklist

- [ ] Verified all death dates mentioned
- [ ] Checked all sports scores against box scores
- [ ] Searched for superlative claims ("first," "only," "largest")
- [ ] Cross-referenced quotes with attribution
- [ ] Used multiple sources for contested facts
- [ ] Only flagged errors with high confidence
