#!/usr/bin/env python3
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
CDP_PORT = 9222


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
            subprocess.Popen([
                COMET_EXECUTABLE,
                f"--remote-debugging-port={CDP_PORT}",
                f"--user-data-dir={COMET_PROFILE_PATH}",
                "--no-first-run",
                "--no-session-restore",
                "--headless=new",
                "about:blank",
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            
            if not wait_for_cdp(CDP_PORT):
                result["message"] = "Failed to start Comet browser"
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
        time.sleep(2)
        
        # Check if signed in
        login_btn = page.locator('button:has-text("Login")')
        if login_btn.count() > 0 and login_btn.first.is_visible():
            result["message"] = "Not signed in to Grokipedia"
            return result
        
        # Select the text
        selected = page.evaluate(f'''(textToFind) => {{
            const walker = document.createTreeWalker(
                document.body,
                NodeFilter.SHOW_TEXT,
                null,
                false
            );
            
            let node;
            while (node = walker.nextNode()) {{
                const parent = node.parentElement;
                if (parent && parent.closest('script,style,noscript')) {{
                    continue;
                }}
                const index = node.textContent.indexOf(textToFind);
                if (index !== -1) {{
                    const range = document.createRange();
                    range.setStart(node, index);
                    range.setEnd(node, index + textToFind.length);
                    
                    const selection = window.getSelection();
                    selection.removeAllRanges();
                    selection.addRange(range);
                    return true;
                }}
            }}
            return false;
        }}''', text_to_select)
        
        if not selected:
            result["message"] = f"Could not find text: {text_to_select[:50]}..."
            return result
        
        # Trigger selection event
        page.evaluate('''() => {
            document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
        }''')
        time.sleep(0.5)
        
        # Click Suggest Edit button
        clicked = page.evaluate('''() => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                const text = (btn.textContent || '').toLowerCase();
                if (text.includes('suggest edit') || (text.includes('suggest') && text.includes('edit'))) {
                    btn.click();
                    return true;
                }
            }
            return false;
        }''')
        
        if not clicked:
            result["message"] = "Could not find Suggest Edit button"
            return result
        
        time.sleep(1)
        
        # Fill in summary
        summary_input = page.locator('textarea').first
        summary_input.fill(summary)
        time.sleep(0.3)
        
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
        submit_btn = page.locator('button:has-text("Submit Edit"), button:has-text("Submit")')
        if submit_btn.count() > 0:
            submit_btn.first.click()
            time.sleep(2)
            result["success"] = True
            result["message"] = "Edit submitted successfully"
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
