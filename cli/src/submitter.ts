/**
 * Grokipedia Edit Submitter
 * Submits corrections to Grokipedia articles
 */

import { Page } from "playwright";

export interface EditResult {
  success: boolean;
  article: string;
  textSelected: string;
  summary: string;
  message: string;
}

export interface EditRequest {
  articleName: string;
  textToSelect: string;
  summary: string;
  correction?: string;
  sources?: string[];
}

export async function submitEdit(
  page: Page,
  request: EditRequest
): Promise<EditResult> {
  const { articleName, textToSelect, summary, correction, sources } = request;
  const articleSlug = articleName.replace(/ /g, "_");
  const url = `https://grokipedia.com/page/${articleSlug}`;

  const result: EditResult = {
    success: false,
    article: articleName,
    textSelected: textToSelect,
    summary,
    message: "",
  };

  try {
    // Navigate to article if not already there
    const currentUrl = page.url();
    if (!currentUrl.includes(articleSlug)) {
      await page.goto(url, { timeout: 60000 });
      try {
        await page.waitForLoadState("networkidle", { timeout: 15000 });
      } catch {
        // Continue
      }
      await page.waitForTimeout(2000);
    }

    // Check if signed in
    const loginBtn = page.locator('button:has-text("Login")');
    const loginCount = await loginBtn.count();
    if (loginCount > 0) {
      try {
        if (await loginBtn.first().isVisible()) {
          result.message = "Not signed in to Grokipedia";
          return result;
        }
      } catch {}
    }

    // Select the text using JavaScript with fuzzy matching and cross-node support
    const selected = await page.evaluate((textToFind: string) => {
      // Normalize text for matching: collapse whitespace, normalize quotes/dashes
      const normalizeText = (text: string): string => {
        return text
          .replace(/[\u2018\u2019\u201C\u201D]/g, (c) => 
            c === '\u2018' || c === '\u2019' ? "'" : '"'
          ) // Smart quotes to straight
          .replace(/[\u2013\u2014]/g, '-') // Em/en dashes to hyphen
          .replace(/\s+/g, ' ') // Collapse whitespace
          .trim();
      };

      // Build a map from normalized index to original position (node + offset)
      interface TextPosition {
        node: Text;
        offset: number;
      }
      
      interface TextMap {
        normalized: string;
        positions: TextPosition[]; // positions[i] = position of normalized char i in DOM
      }

      // Build a virtual text buffer from all text nodes with position mapping
      const buildTextMap = (): TextMap => {
        const positions: TextPosition[] = [];
        let normalized = '';
        
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          null
        );

        let node;
        let lastWasSpace = true; // Start true to trim leading space
        
        while ((node = walker.nextNode())) {
          const textNode = node as Text;
          const parent = textNode.parentElement;
          if (parent && parent.closest("script,style,noscript")) {
            continue;
          }
          
          const text = textNode.textContent || "";
          
          for (let i = 0; i < text.length; i++) {
            let char = text[i];
            
            // Normalize character
            if (char === '\u2018' || char === '\u2019') {
              char = "'";
            } else if (char === '\u201C' || char === '\u201D') {
              char = '"';
            } else if (char === '\u2013' || char === '\u2014') {
              char = '-';
            }
            
            // Handle whitespace collapsing
            if (/\s/.test(char)) {
              if (!lastWasSpace) {
                normalized += ' ';
                positions.push({ node: textNode, offset: i });
                lastWasSpace = true;
              }
              // Skip additional whitespace chars (collapse)
            } else {
              normalized += char;
              positions.push({ node: textNode, offset: i });
              lastWasSpace = false;
            }
          }
        }
        
        // Trim trailing space
        if (normalized.endsWith(' ')) {
          normalized = normalized.slice(0, -1);
          positions.pop();
        }
        
        return { normalized, positions };
      };

      // Create a selection range from normalized start/end indices
      const selectFromMap = (map: TextMap, startIdx: number, endIdx: number): boolean => {
        if (startIdx < 0 || endIdx > map.positions.length || startIdx >= endIdx) {
          return false;
        }
        
        const startPos = map.positions[startIdx];
        const endPos = map.positions[endIdx - 1];
        
        if (!startPos || !endPos) {
          return false;
        }
        
        const range = document.createRange();
        range.setStart(startPos.node, startPos.offset);
        // End offset is +1 to include the character
        range.setEnd(endPos.node, endPos.offset + 1);
        
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return true;
      };

      const normalizedSearch = normalizeText(textToFind);
      
      // Strategy 1: Try exact match in single text node first (fast path)
      const tryExactMatch = (): boolean => {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          null
        );

        let node;
        while ((node = walker.nextNode())) {
          const parent = node.parentElement;
          if (parent && parent.closest("script,style,noscript")) {
            continue;
          }
          const textContent = node.textContent || "";
          const index = textContent.indexOf(textToFind);
          if (index !== -1) {
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + textToFind.length);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            return true;
          }
        }
        return false;
      };

      // Strategy 2: Cross-node normalized match using text map
      const tryCrossNodeMatch = (): boolean => {
        const map = buildTextMap();
        const index = map.normalized.indexOf(normalizedSearch);
        if (index !== -1) {
          return selectFromMap(map, index, index + normalizedSearch.length);
        }
        return false;
      };

      // Strategy 3: Cross-node partial match (first 50 chars)
      const tryCrossNodePartialMatch = (): boolean => {
        const shortSearch = normalizedSearch.substring(0, 50);
        if (shortSearch.length < 15) return false;
        
        const map = buildTextMap();
        const index = map.normalized.indexOf(shortSearch);
        if (index !== -1) {
          // Try to select the full length if possible, otherwise just what we found
          const endIdx = Math.min(index + normalizedSearch.length, map.positions.length);
          return selectFromMap(map, index, endIdx);
        }
        return false;
      };

      // Strategy 4: Cross-node case-insensitive match
      const tryCrossNodeCaseInsensitive = (): boolean => {
        const lowerSearch = normalizedSearch.toLowerCase();
        const map = buildTextMap();
        const index = map.normalized.toLowerCase().indexOf(lowerSearch);
        if (index !== -1) {
          return selectFromMap(map, index, index + normalizedSearch.length);
        }
        return false;
      };

      // Strategy 5: Fuzzy match - find best substring match
      const tryFuzzyMatch = (): boolean => {
        if (normalizedSearch.length < 20) return false;
        
        const map = buildTextMap();
        const words = normalizedSearch.split(' ').filter(w => w.length > 3);
        if (words.length < 2) return false;
        
        // Try to find a sequence of words
        const firstWord = words[0].toLowerCase();
        const lowerContent = map.normalized.toLowerCase();
        
        let searchStart = 0;
        while (searchStart < lowerContent.length) {
          const wordIdx = lowerContent.indexOf(firstWord, searchStart);
          if (wordIdx === -1) break;
          
          // Check if subsequent words appear nearby
          let matchEnd = wordIdx + firstWord.length;
          let matchedWords = 1;
          
          for (let i = 1; i < words.length && matchedWords === i; i++) {
            const nextWord = words[i].toLowerCase();
            // Look within a reasonable window (100 chars)
            const windowEnd = Math.min(matchEnd + 100, lowerContent.length);
            const window = lowerContent.substring(matchEnd, windowEnd);
            const nextIdx = window.indexOf(nextWord);
            if (nextIdx !== -1) {
              matchEnd = matchEnd + nextIdx + nextWord.length;
              matchedWords++;
            }
          }
          
          // If we matched at least 60% of words, use this
          if (matchedWords >= words.length * 0.6) {
            return selectFromMap(map, wordIdx, matchEnd);
          }
          
          searchStart = wordIdx + 1;
        }
        
        return false;
      };

      // Try strategies in order
      if (tryExactMatch()) return true;
      if (tryCrossNodeMatch()) return true;
      if (tryCrossNodePartialMatch()) return true;
      if (tryCrossNodeCaseInsensitive()) return true;
      if (tryFuzzyMatch()) return true;
      
      return false;
    }, textToSelect);

    if (!selected) {
      result.message = `Could not find text: ${textToSelect.substring(0, 50)}...`;
      return result;
    }

    // Trigger selection event
    await page.evaluate(() => {
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.waitForTimeout(500);

    // Click Suggest Edit button
    const clicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = (btn.textContent || "").toLowerCase();
        if (
          text.includes("suggest edit") ||
          (text.includes("suggest") && text.includes("edit"))
        ) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!clicked) {
      result.message = "Could not find Suggest Edit button";
      return result;
    }

    await page.waitForTimeout(1000);

    // Fill in summary - wait for textarea to appear
    try {
      const summaryInput = page.locator("textarea").first();
      await summaryInput.waitFor({ state: "visible", timeout: 10000 });
      await summaryInput.fill(summary);
      await page.waitForTimeout(300);
    } catch (e) {
      result.message = `Edit form did not appear: ${e}`;
      return result;
    }

    // Fill in correction if provided
    if (correction) {
      try {
        const expandBtn = page.locator('button:has-text("Edit content")');
        if ((await expandBtn.count()) > 0) {
          await expandBtn.first().click();
          await page.waitForTimeout(500);
        }
        const contentTextarea = page.locator("textarea").nth(1);
        if ((await contentTextarea.count()) > 0) {
          await contentTextarea.fill(correction);
        }
      } catch {
        // Continue without correction text
      }
    }

    // Add sources if provided
    if (sources && sources.length > 0) {
      try {
        for (let i = 0; i < sources.length; i++) {
          if (i > 0) {
            const addBtn = page.locator('button:has-text("Add another")');
            if ((await addBtn.count()) > 0) {
              await addBtn.click();
              await page.waitForTimeout(300);
            }
          }
          const sourceInput = page
            .locator('input[placeholder*="http"], input[placeholder*="source"]')
            .last();
          if ((await sourceInput.count()) > 0) {
            await sourceInput.fill(sources[i]);
            await page.waitForTimeout(200);
          }
        }
      } catch {
        // Continue without sources
      }
    }

    // Submit
    const submitBtn = page.locator(
      'button:has-text("Submit Edit"), button:has-text("Submit")'
    );
    if ((await submitBtn.count()) > 0) {
      await submitBtn.first().click();
      await page.waitForTimeout(2000);
      result.success = true;
      result.message = "Edit submitted successfully";
    } else {
      result.message = "Submit button not found";
    }
  } catch (error) {
    result.message = String(error);
  }

  return result;
}
