#!/usr/bin/env .venv/bin/python
"""
Grokipedia Edit Submitter
Submits corrections to Grokipedia articles using Comet browser.
"""

import sys
import json
import time
import os
import socket
import subprocess
import argparse

COMET_EXECUTABLE = "/Applications/Comet.app/Contents/MacOS/Comet"
COMET_PROFILE_PATH = os.path.expanduser("~/Library/Application Support/Comet")
HEADLESS_PROFILE_PATH = os.path.expanduser("~/Library/Application Support/Comet-Headless")
CDP_PORT = 9224


def submit_edit(article_name, text_to_select, summary, correction=None, sources=None):
    """Submit an edit to a Grokipedia article."""
    from playwright.sync_api import sync_playwright
    import urllib.request
    
    def wait_for_cdp(port, timeout=15):
        for _ in range(timeout * 2):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1)
                return True
            except:
                time.sleep(0.5)
        return False
    
    def port_in_use(port):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            return s.connect_ex(('127.0.0.1', port)) == 0
    
    result = {
        "success": False,
        "article": article_name,
        "text_selected": text_to_select,
        "summary": summary,
        "message": ""
    }
    
    playwright = None
    
    try:
        playwright = sync_playwright().start()
        
        if not os.path.exists(COMET_EXECUTABLE):
            result["message"] = "Comet browser not found"
            return result
        
        if not port_in_use(CDP_PORT):
            # Use separate profile to avoid conflicts with running Comet
            # First, copy cookies from main profile if headless profile doesn't exist
            if not os.path.exists(HEADLESS_PROFILE_PATH):
                os.makedirs(HEADLESS_PROFILE_PATH, exist_ok=True)
                # Copy cookies/login state from main profile
                main_cookies = os.path.join(COMET_PROFILE_PATH, "Default", "Cookies")
                headless_default = os.path.join(HEADLESS_PROFILE_PATH, "Default")
                if os.path.exists(main_cookies):
                    os.makedirs(headless_default, exist_ok=True)
                    import shutil
                    shutil.copy2(main_cookies, os.path.join(headless_default, "Cookies"))
            
            subprocess.Popen([
                COMET_EXECUTABLE,
                f"--remote-debugging-port={CDP_PORT}",
                f"--user-data-dir={HEADLESS_PROFILE_PATH}",
                "--no-first-run",
                "--no-session-restore",
                "--headless=new",
                "about:blank",
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            
            if not wait_for_cdp(CDP_PORT):
                result["message"] = "Failed to start Comet browser. Try closing Comet manually first."
                return result
        
        browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{CDP_PORT}")
        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page = context.new_page()
        
        # Navigate to article
        url = f"https://grokipedia.com/page/{article_name.replace(' ', '_')}"
        page.goto(url, timeout=60000)
        try:
            page.wait_for_load_state('networkidle', timeout=15000)
        except:
            pass
        time.sleep(3)
        
        # Wait for article content to be visible
        try:
            page.wait_for_selector('article, [role="article"], main', timeout=10000)
        except:
            pass
        time.sleep(1)
        
        # Check if signed in
        login_btn = page.locator('button:has-text("Login")')
        if login_btn.count() > 0 and login_btn.first.is_visible():
            result["message"] = "Not signed in to Grokipedia"
            return result
        
        # Select the text using cross-node matching with fuzzy fallbacks
        selected = page.evaluate('''(textToFind) => {
            // Normalize text for matching: collapse whitespace, normalize quotes/dashes
            const normalizeText = (text) => {
                return text
                    .replace(/[\u2018\u2019\u201C\u201D]/g, (c) => 
                        c === '\u2018' || c === '\u2019' ? "'" : '"'
                    )
                    .replace(/[\u2013\u2014]/g, '-')
                    .replace(/\s+/g, ' ')
                    .trim();
            };

            // Build a map from normalized index to original position (node + offset)
            const buildTextMap = () => {
                const positions = [];
                let normalized = '';
                
                const walker = document.createTreeWalker(
                    document.body,
                    NodeFilter.SHOW_TEXT,
                    null
                );

                let node;
                let lastWasSpace = true;
                
                while ((node = walker.nextNode())) {
                    const parent = node.parentElement;
                    if (parent && parent.closest("script,style,noscript")) {
                        continue;
                    }
                    
                    const text = node.textContent || "";
                    
                    for (let i = 0; i < text.length; i++) {
                        let char = text[i];
                        
                        if (char === '\u2018' || char === '\u2019') char = "'";
                        else if (char === '\u201C' || char === '\u201D') char = '"';
                        else if (char === '\u2013' || char === '\u2014') char = '-';
                        
                        if (/\s/.test(char)) {
                            if (!lastWasSpace) {
                                normalized += ' ';
                                positions.push({ node, offset: i });
                                lastWasSpace = true;
                            }
                        } else {
                            normalized += char;
                            positions.push({ node, offset: i });
                            lastWasSpace = false;
                        }
                    }
                }
                
                if (normalized.endsWith(' ')) {
                    normalized = normalized.slice(0, -1);
                    positions.pop();
                }
                
                return { normalized, positions };
            };

            const selectFromMap = (map, startIdx, endIdx) => {
                if (startIdx < 0 || endIdx > map.positions.length || startIdx >= endIdx) {
                    return false;
                }
                
                const startPos = map.positions[startIdx];
                const endPos = map.positions[endIdx - 1];
                
                if (!startPos || !endPos) return false;
                
                const range = document.createRange();
                range.setStart(startPos.node, startPos.offset);
                range.setEnd(endPos.node, endPos.offset + 1);
                
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
                return true;
            };

            const normalizedSearch = normalizeText(textToFind);
            
            // Strategy 1: Exact match in single node (fast path)
            const tryExactMatch = () => {
                const walker = document.createTreeWalker(
                    document.body,
                    NodeFilter.SHOW_TEXT,
                    null
                );

                let node;
                while ((node = walker.nextNode())) {
                    const parent = node.parentElement;
                    if (parent && parent.closest("script,style,noscript")) continue;
                    const text = node.textContent || "";
                    const idx = text.indexOf(textToFind);
                    if (idx !== -1) {
                        const range = document.createRange();
                        range.setStart(node, idx);
                        range.setEnd(node, idx + textToFind.length);
                        window.getSelection().removeAllRanges();
                        window.getSelection().addRange(range);
                        return true;
                    }
                }
                return false;
            };

            // Strategy 2: Cross-node normalized match
            const tryCrossNodeMatch = () => {
                const map = buildTextMap();
                const idx = map.normalized.indexOf(normalizedSearch);
                if (idx !== -1) {
                    return selectFromMap(map, idx, idx + normalizedSearch.length);
                }
                return false;
            };

            // Strategy 3: Partial match (first 50 chars)
            const tryPartialMatch = () => {
                const shortSearch = normalizedSearch.substring(0, 50);
                if (shortSearch.length < 15) return false;
                const map = buildTextMap();
                const idx = map.normalized.indexOf(shortSearch);
                if (idx !== -1) {
                    const endIdx = Math.min(idx + normalizedSearch.length, map.positions.length);
                    return selectFromMap(map, idx, endIdx);
                }
                return false;
            };

            // Strategy 4: Case-insensitive match
            const tryCaseInsensitive = () => {
                const lowerSearch = normalizedSearch.toLowerCase();
                const map = buildTextMap();
                const idx = map.normalized.toLowerCase().indexOf(lowerSearch);
                if (idx !== -1) {
                    return selectFromMap(map, idx, idx + normalizedSearch.length);
                }
                return false;
            };

            // Strategy 5: window.find fallback
            const tryWindowFind = () => {
                return window.find(textToFind, false, false, true, false, false, false);
            };

            if (tryExactMatch()) return {found: true};
            if (tryCrossNodeMatch()) return {found: true};
            if (tryPartialMatch()) return {found: true};
            if (tryCaseInsensitive()) return {found: true};
            if (tryWindowFind()) return {found: true};
            
            return {found: false};
        }''', text_to_select)
        
        if not selected.get('found'):
            result["message"] = f"Could not find text: {text_to_select[:50]}..."
            return result
        
        # Wait for selection popup to appear
        time.sleep(1)
        
        # Trigger selection event
        page.evaluate('''() => {
            document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
        }''')
        time.sleep(0.5)
        
        # Click Suggest Edit button
        clicked = page.evaluate('''() => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                const text = (btn.textContent || '').trim().toLowerCase();
                // Be specific: look for "suggest edit" first, not "suggest article"
                if (text === 'suggest edit') {
                    btn.click();
                    return "suggest edit";
                }
            }
            // Fallback to other patterns
            for (const btn of buttons) {
                const text = (btn.textContent || '').trim().toLowerCase();
                if (text.includes('suggest') && text.includes('edit')) {
                    btn.click();
                    return text;
                }
            }
            return null;
        }''')
        
        if not clicked:
            result["message"] = "Could not find Suggest Edit button - make sure text is selected in the article body"
            return result
        
        time.sleep(1)
        
        # Wait for form to appear
        time.sleep(1)
        
        # Fill in summary - find the right textarea
        textareas = page.locator('textarea')
        if textareas.count() > 0:
            textareas.first.fill(summary)
        time.sleep(0.5)
        
        # Fill in correction if provided
        if correction:
            try:
                expand_btn = page.locator('button:has-text("Edit content")')
                if expand_btn.count() > 0:
                    expand_btn.first.click()
                    time.sleep(0.5)
                content_textarea = page.locator('textarea').nth(1)
                if content_textarea.count() > 0:
                    content_textarea.fill(correction)
            except:
                pass
        
        # Add sources if provided
        if sources:
            try:
                for i, source in enumerate(sources):
                    if i > 0:
                        add_btn = page.locator('button:has-text("Add another")')
                        if add_btn.count() > 0:
                            add_btn.click()
                            time.sleep(0.3)
                    source_input = page.locator('input[placeholder*="http"], input[placeholder*="source"]').last
                    if source_input.count() > 0:
                        source_input.fill(source)
                        time.sleep(0.2)
            except:
                pass
        
        # Submit
        submit_btn = page.locator('button:has-text("Submit Suggestion"), button:has-text("Submit Edit"), button:has-text("Submit")')
        if submit_btn.count() > 0:
            try:
                submit_btn.first.wait_for(state="visible", timeout=5000)
                is_disabled = submit_btn.first.is_disabled()
                if not is_disabled:
                    submit_btn.first.click()
                    time.sleep(2)
                    result["success"] = True
                    result["message"] = "Edit submitted successfully"
                else:
                    result["message"] = "Submit button is disabled - form may be incomplete"
            except Exception as e:
                result["message"] = f"Submit button error: {str(e)}"
        else:
            result["message"] = "Submit button not found"
        
        page.close()
        browser.close()
        
    except Exception as e:
        result["message"] = str(e)
    finally:
        if playwright:
            playwright.stop()
    
    return result


def main():
    parser = argparse.ArgumentParser(description="Submit edits to Grokipedia articles")
    parser.add_argument("--article", required=True, help="Article name")
    parser.add_argument("--text", required=True, help="Text to select for correction")
    parser.add_argument("--summary", required=True, help="Summary of the correction")
    parser.add_argument("--correction", help="The corrected text")
    parser.add_argument("--sources", help="Comma-separated source URLs")
    
    args = parser.parse_args()
    
    sources = [s.strip() for s in args.sources.split(',')] if args.sources else None
    
    result = submit_edit(
        args.article,
        args.text,
        args.summary,
        args.correction,
        sources
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
