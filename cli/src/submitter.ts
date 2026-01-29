/**
 * Grokipedia Edit Submitter
 * Submits corrections to Grokipedia articles using playwright-cli
 */

import { PlaywrightCLISession, findRefByText, findRefsByPattern } from "./playwright-cli.js";

/**
 * Retry configuration for finding and clicking elements
 */
interface RetryConfig {
  maxRetries: number;
  delayMs: number;
}

const DEFAULT_CLICK_RETRY: RetryConfig = { maxRetries: 2, delayMs: 300 };
const SUGGEST_EDIT_RETRY: RetryConfig = { maxRetries: 3, delayMs: 500 };

/**
 * Helper to find an element with retries and fresh snapshots
 */
async function findElementWithRetry(
  session: PlaywrightCLISession,
  findFn: (snapshot: string) => string | null,
  config: RetryConfig = DEFAULT_CLICK_RETRY
): Promise<{ ref: string; snapshot: string } | null> {
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    const snapshot = await session.snapshot();
    const ref = findFn(snapshot);
    if (ref) {
      return { ref, snapshot };
    }
    if (attempt < config.maxRetries) {
      await session.wait(config.delayMs);
    }
  }
  return null;
}

/**
 * Click an element with retry logic - gets fresh snapshot on failure
 */
async function clickWithRetry(
  session: PlaywrightCLISession,
  findFn: (snapshot: string) => string | null,
  config: RetryConfig = DEFAULT_CLICK_RETRY
): Promise<boolean> {
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    const snapshot = await session.snapshot();
    const ref = findFn(snapshot);
    if (!ref) {
      if (attempt < config.maxRetries) {
        await session.wait(config.delayMs);
        continue;
      }
      return false;
    }
    
    try {
      await session.click(ref);
      return true;
    } catch (error) {
      const errorMsg = String(error);
      // Retry on "Element not found" or stale element errors
      if (errorMsg.includes("not found") || errorMsg.includes("stale")) {
        if (attempt < config.maxRetries) {
          await session.wait(config.delayMs);
          continue;
        }
      }
      throw error;
    }
  }
  return false;
}

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

    // Check if signed in using JavaScript evaluation
    // This is more reliable than snapshot-based text matching
    const loginCheckScript = `
      (function() {
        // Check for login link pointing to the auth endpoint
        // The login link has text "Login" and points to check-login or sign-in
        var loginLinks = document.querySelectorAll('a[href*="check-login"], a[href*="sign-in"]');
        var hasLoginLink = false;
        for (var i = 0; i < loginLinks.length; i++) {
          var text = (loginLinks[i].textContent || '').trim().toLowerCase();
          if (text === 'login' || text === 'log in' || text === 'sign in') {
            hasLoginLink = true;
            break;
          }
        }
        
        // Check for logged-in indicators - be specific to avoid false positives
        // Logout link should have "logout" or "sign-out" in the path (not just anywhere in URL)
        var allLinks = document.querySelectorAll('a');
        var hasLogoutLink = false;
        var hasProfileLink = false;
        
        for (var i = 0; i < allLinks.length; i++) {
          var href = (allLinks[i].getAttribute('href') || '').toLowerCase();
          var text = (allLinks[i].textContent || '').trim().toLowerCase();
          
          // Check for logout - must be explicit logout action
          if (href.includes('/logout') || href.includes('/sign-out') || 
              text === 'logout' || text === 'log out' || text === 'sign out') {
            hasLogoutLink = true;
          }
          
          // Check for profile link - must be a path like /profile or /user/xxx, not accounts.x.ai
          if ((href.includes('/profile') || href.includes('/user/')) && 
              !href.includes('accounts.x.ai') && !href.includes('check-login')) {
            hasProfileLink = true;
          }
        }
        
        // Check for user avatar
        var userAvatar = document.querySelector('[data-testid="avatar"], [data-testid="user-avatar"], img.avatar, img.user-avatar');
        var hasAvatar = !!userAvatar;
        
        var hasLoggedInIndicator = hasLogoutLink || hasProfileLink || hasAvatar;
        
        // User is signed in if:
        // - There's no login link to auth endpoint, OR
        // - There are logged-in indicators present
        var signedIn = !hasLoginLink || hasLoggedInIndicator;
        
        return JSON.stringify({
          signedIn: signedIn,
          hasLoginLink: hasLoginLink,
          hasLoggedInIndicator: hasLoggedInIndicator
        });
      })()
    `;
    
    let isSignedIn = false;
    try {
      const loginCheckResult = await session.eval(loginCheckScript);
      const parsed = JSON.parse(loginCheckResult);
      isSignedIn = parsed.signedIn;
    } catch {
      // Fallback to snapshot-based detection if eval fails
      const snapshot = await session.snapshot();
      const loginRef = findRefByText(snapshot, "Login", { partial: true });
      isSignedIn = loginRef === null;
    }
    
    if (!isSignedIn) {
      result.message = "Not signed in to Grokipedia";
      return result;
    }

    // Get snapshot for subsequent operations
    let snapshot = await session.snapshot();

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
    // Wait longer for popup menu to appear (1000ms instead of 500ms)
    await session.wait(1000);

    // Find Suggest Edit button with retries (popup may take time to appear)
    const findSuggestEdit = (snap: string): string | null => {
      return findRefByText(snap, "Suggest Edit", { partial: true }) ||
             findRefByText(snap, "suggest edit", { partial: true });
    };

    const suggestEditClicked = await clickWithRetry(session, findSuggestEdit, SUGGEST_EDIT_RETRY);
    if (!suggestEditClicked) {
      result.message = "Could not find Suggest Edit button";
      return result;
    }
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
      // Try to expand content editing if needed - use retry logic
      const findEditContent = (snap: string): string | null => {
        return findRefByText(snap, "Edit content", { partial: true });
      };
      await clickWithRetry(session, findEditContent);
      await session.wait(500);
      snapshot = await session.snapshot();

      const allTextareas = findRefsByPattern(snapshot, /textbox|textarea/i);
      if (allTextareas.length > 1) {
        await session.fill(allTextareas[1].ref, correction);
      }
    }

    // Add sources if provided
    if (sources && sources.length > 0) {
      for (let i = 0; i < sources.length; i++) {
        if (i > 0) {
          // Use retry logic for "Add another" button
          const findAddAnother = (snap: string): string | null => {
            return findRefByText(snap, "Add another", { partial: true });
          };
          await clickWithRetry(session, findAddAnother);
          await session.wait(300);
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

    // Find and click Submit button with retry logic
    const findSubmit = (snap: string): string | null => {
      return findRefByText(snap, "Submit Edit", { partial: true }) ||
             findRefByText(snap, "Submit", { partial: true });
    };

    const submitClicked = await clickWithRetry(session, findSubmit);
    if (submitClicked) {
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
