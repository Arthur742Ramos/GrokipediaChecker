/**
 * Grokipedia Edit Submitter
 * Submits corrections to Grokipedia articles using playwright-cli
 */

import { PlaywrightCLISession, findRefByText, findRefsByPattern } from "./playwright-cli.js";

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
  session: PlaywrightCLISession,
  request: EditRequest,
  headed: boolean = false
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
    // Navigate to article
    await session.open(url, headed);
    await session.wait(2000);

    // Get snapshot to check if signed in
    let snapshot = await session.snapshot();
    
    // Check if signed in
    const loginRef = findRefByText(snapshot, "Login", { partial: true });
    if (loginRef) {
      result.message = "Not signed in to Grokipedia";
      return result;
    }

    // Select the text using JavaScript with fuzzy matching
    // This uses eval to run the selection logic in the browser
    const selectScript = `
      (function(textToFind) {
        // Normalize text for matching
        function normalizeText(text) {
          return text
            .replace(/[\\u2018\\u2019\\u201C\\u201D]/g, function(c) {
              return c === '\\u2018' || c === '\\u2019' ? "'" : '"';
            })
            .replace(/[\\u2013\\u2014]/g, '-')
            .replace(/\\s+/g, ' ')
            .trim();
        }

        function buildTextMap() {
          var positions = [];
          var normalized = '';
          
          var walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            null
          );

          var node;
          var lastWasSpace = true;
          
          while ((node = walker.nextNode())) {
            var textNode = node;
            var parent = textNode.parentElement;
            if (parent && parent.closest("script,style,noscript")) {
              continue;
            }
            
            var text = textNode.textContent || "";
            
            for (var i = 0; i < text.length; i++) {
              var char = text[i];
              
              if (char === '\\u2018' || char === '\\u2019') {
                char = "'";
              } else if (char === '\\u201C' || char === '\\u201D') {
                char = '"';
              } else if (char === '\\u2013' || char === '\\u2014') {
                char = '-';
              }
              
              if (/\\s/.test(char)) {
                if (!lastWasSpace) {
                  normalized += ' ';
                  positions.push({ node: textNode, offset: i });
                  lastWasSpace = true;
                }
              } else {
                normalized += char;
                positions.push({ node: textNode, offset: i });
                lastWasSpace = false;
              }
            }
          }
          
          if (normalized.endsWith(' ')) {
            normalized = normalized.slice(0, -1);
            positions.pop();
          }
          
          return { normalized: normalized, positions: positions };
        }

        function selectFromMap(map, startIdx, endIdx) {
          if (startIdx < 0 || endIdx > map.positions.length || startIdx >= endIdx) {
            return false;
          }
          
          var startPos = map.positions[startIdx];
          var endPos = map.positions[endIdx - 1];
          
          if (!startPos || !endPos) {
            return false;
          }
          
          var range = document.createRange();
          range.setStart(startPos.node, startPos.offset);
          range.setEnd(endPos.node, endPos.offset + 1);
          
          var selection = window.getSelection();
          if (selection) {
            selection.removeAllRanges();
            selection.addRange(range);
          }
          return true;
        }

        var normalizedSearch = normalizeText(textToFind);
        
        // Try exact match first
        function tryExactMatch() {
          var walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            null
          );

          var node;
          while ((node = walker.nextNode())) {
            var parent = node.parentElement;
            if (parent && parent.closest("script,style,noscript")) {
              continue;
            }
            var textContent = node.textContent || "";
            var index = textContent.indexOf(textToFind);
            if (index !== -1) {
              var range = document.createRange();
              range.setStart(node, index);
              range.setEnd(node, index + textToFind.length);
              var selection = window.getSelection();
              if (selection) {
                selection.removeAllRanges();
                selection.addRange(range);
              }
              return true;
            }
          }
          return false;
        }

        function tryCrossNodeMatch() {
          var map = buildTextMap();
          var index = map.normalized.indexOf(normalizedSearch);
          if (index !== -1) {
            return selectFromMap(map, index, index + normalizedSearch.length);
          }
          return false;
        }

        function tryCrossNodeCaseInsensitive() {
          var lowerSearch = normalizedSearch.toLowerCase();
          var map = buildTextMap();
          var index = map.normalized.toLowerCase().indexOf(lowerSearch);
          if (index !== -1) {
            return selectFromMap(map, index, index + normalizedSearch.length);
          }
          return false;
        }

        if (tryExactMatch()) return true;
        if (tryCrossNodeMatch()) return true;
        if (tryCrossNodeCaseInsensitive()) return true;
        
        return false;
      })(${JSON.stringify(textToSelect)})
    `;
    const selected = await session.eval(selectScript);

    if (selected !== "true") {
      result.message = `Could not find text: ${textToSelect.substring(0, 50)}...`;
      return result;
    }

    // Trigger selection event
    await session.eval(`document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))`);
    await session.wait(500);

    // Get new snapshot and find Suggest Edit button
    snapshot = await session.snapshot();
    
    // Look for Suggest Edit button
    const suggestEditRef = findRefByText(snapshot, "Suggest Edit", { partial: true }) ||
                           findRefByText(snapshot, "suggest edit", { partial: true });

    if (!suggestEditRef) {
      result.message = "Could not find Suggest Edit button";
      return result;
    }

    await session.click(suggestEditRef);
    await session.wait(1000);

    // Get new snapshot to find form elements
    snapshot = await session.snapshot();

    // Find textarea for summary
    const textareaRefs = findRefsByPattern(snapshot, /textbox|textarea/i);
    if (textareaRefs.length === 0) {
      result.message = "Edit form did not appear";
      return result;
    }

    // Fill in the summary
    await session.fill(textareaRefs[0].ref, summary);
    await session.wait(300);

    // Fill in correction if provided
    if (correction && textareaRefs.length > 1) {
      // Try to expand content editing if needed
      snapshot = await session.snapshot();
      const editContentRef = findRefByText(snapshot, "Edit content", { partial: true });
      if (editContentRef) {
        await session.click(editContentRef);
        await session.wait(500);
        snapshot = await session.snapshot();
      }

      const allTextareas = findRefsByPattern(snapshot, /textbox|textarea/i);
      if (allTextareas.length > 1) {
        await session.fill(allTextareas[1].ref, correction);
      }
    }

    // Add sources if provided
    if (sources && sources.length > 0) {
      for (let i = 0; i < sources.length; i++) {
        if (i > 0) {
          snapshot = await session.snapshot();
          const addAnotherRef = findRefByText(snapshot, "Add another", { partial: true });
          if (addAnotherRef) {
            await session.click(addAnotherRef);
            await session.wait(300);
          }
        }
        
        snapshot = await session.snapshot();
        // Find input fields - look for input[text] elements specifically
        const inputRefs = findRefsByPattern(snapshot, /input.*\[text\]/i);
        if (inputRefs.length > 0) {
          // Use the last input field (newest one added)
          await session.fill(inputRefs[inputRefs.length - 1].ref, sources[i]);
          await session.wait(200);
        }
      }
    }

    // Find and click Submit button
    snapshot = await session.snapshot();
    const submitRef = findRefByText(snapshot, "Submit Edit", { partial: true }) ||
                      findRefByText(snapshot, "Submit", { partial: true });

    if (submitRef) {
      await session.click(submitRef);
      await session.wait(2000);
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
