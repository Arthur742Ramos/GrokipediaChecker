#!/usr/bin/env python3
"""
Batch Grokipedia Fact-Checker
Processes multiple articles, finds issues, and submits corrections.
"""

import sys
import json
import time
import os
import socket
import subprocess

COMET_EXECUTABLE = "/Applications/Comet.app/Contents/MacOS/Comet"
COMET_PROFILE_PATH = os.path.expanduser("~/Library/Application Support/Comet")
CDP_PORT = 9222

# 50 articles to fact-check - mix of obscure and varied topics
ARTICLES = [
    "Thagomizer",
    "Marree Man",
    "Phlogiston theory",
    "Trofim Lysenko",
    "Phineas Gage",
    "Great Molasses Flood",
    "Dancing plague of 1518",
    "Tarrare",
    "Mary Toft",
    "The Great Emu War",
    "Voynich manuscript",
    "Antikythera mechanism",
    "Baghdad Battery",
    "Wow signal",
    "Dyatlov Pass incident",
    "Tunguska event",
    "Cottingley Fairies",
    "Cardiff Giant",
    "Piltdown Man",
    "Clever Hans",
    "Okapi",
    "Platypus",
    "Axolotl",
    "Tardigrade",
    "Blobfish",
    "Mantis shrimp",
    "Pistol shrimp",
    "Bombardier beetle",
    "Hagfish",
    "Naked mole-rat",
    "Roanoke Colony",
    "Vinland",
    "Library of Alexandria",
    "Hanging Gardens of Babylon",
    "Colossus of Rhodes",
    "Lighthouse of Alexandria",
    "Mausoleum at Halicarnassus",
    "Temple of Artemis",
    "Statue of Zeus at Olympia",
    "Rosetta Stone",
    "Dead Sea Scrolls",
    "Terracotta Army",
    "Nazca Lines",
    "Easter Island",
    "Stonehenge",
    "Gobekli Tepe",
    "Derinkuyu",
    "Cappadocia",
    "Petra",
    "Angkor Wat",
]


def wait_for_cdp(port, timeout=15):
    import urllib.request
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


def ensure_browser():
    """Ensure Comet browser is running with CDP."""
    if not port_in_use(CDP_PORT):
        print("Launching Comet browser...")
        subprocess.Popen([
            COMET_EXECUTABLE,
            f"--remote-debugging-port={CDP_PORT}",
            f"--user-data-dir={COMET_PROFILE_PATH}",
            "--no-first-run",
            "--no-session-restore",
            "about:blank",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        if not wait_for_cdp(CDP_PORT):
            print("ERROR: Failed to start browser")
            return False
    return True


def fetch_article(playwright, article_name):
    """Fetch article content."""
    browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{CDP_PORT}")
    context = browser.contexts[0] if browser.contexts else browser.new_context()
    page = context.new_page()
    
    url = f"https://grokipedia.com/page/{article_name.replace(' ', '_')}"
    
    try:
        page.goto(url, timeout=60000)
        page.wait_for_load_state('networkidle', timeout=15000)
    except:
        pass
    time.sleep(2)
    
    # Check signed in
    login_btn = page.locator('button:has-text("Login")')
    signed_in = login_btn.count() == 0 or not login_btn.first.is_visible()
    
    if not signed_in:
        page.close()
        browser.close()
        return None, "Not signed in"
    
    # Get content
    content = page.evaluate('''() => {
        const article = document.querySelector('article') || 
                       document.querySelector('[role="article"]') ||
                       document.querySelector('main');
        return article ? article.innerText : document.body.innerText;
    }''')
    
    return {"page": page, "browser": browser, "content": content, "url": url}, None


def find_inconsistencies(content):
    """Find internal inconsistencies in the content."""
    import re
    
    issues = []
    
    # Find all measurements with numbers
    measurements = re.findall(r'(\d+(?:\.\d+)?)\s*(kilometers?|km|meters?|m|miles?|feet|ft|inches?|in|centimeters?|cm|millimeters?|mm)', content, re.IGNORECASE)
    
    # Find all years
    years = re.findall(r'\b(1[0-9]{3}|20[0-2][0-9])\b', content)
    
    # Look for the same measurement type with different values close together
    km_values = [(m[0], m[1]) for m in measurements if 'kilometer' in m[1].lower() or m[1].lower() == 'km']
    if len(set(v[0] for v in km_values)) > 1 and len(km_values) >= 2:
        values = list(set(v[0] for v in km_values))
        issues.append({
            "type": "inconsistency",
            "problem": f"Multiple kilometer measurements found: {', '.join(values)} km",
            "values": values
        })
    
    return issues


def submit_correction(page, text, summary, correction):
    """Submit a correction to the page."""
    # Select the text
    selected = page.evaluate('''(textToFind) => {
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            null,
            false
        );
        
        let node;
        while (node = walker.nextNode()) {
            const index = node.textContent.indexOf(textToFind);
            if (index !== -1) {
                const range = document.createRange();
                range.setStart(node, index);
                range.setEnd(node, index + textToFind.length);
                
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
                return true;
            }
        }
        return false;
    }''', text[:100])
    
    if not selected:
        return False, "Could not find text"
    
    # Trigger selection
    page.evaluate('() => document.dispatchEvent(new MouseEvent("mouseup", {bubbles: true}))')
    time.sleep(0.5)
    
    # Click Suggest Edit
    clicked = page.evaluate('''() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
            if (btn.textContent.includes('Suggest Edit')) {
                btn.click();
                return true;
            }
        }
        return false;
    }''')
    
    if not clicked:
        return False, "No Suggest Edit button"
    
    time.sleep(1)
    
    # Fill summary
    summary_input = page.locator('textarea').first
    summary_input.fill(summary)
    time.sleep(0.3)
    
    # Fill correction if provided
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
    
    # Submit
    submit_btn = page.locator('button:has-text("Submit Edit"), button:has-text("Submit")')
    if submit_btn.count() > 0:
        submit_btn.first.click()
        time.sleep(2)
        return True, "Submitted"
    
    return False, "No submit button"


def process_article(playwright, article_name, results):
    """Process a single article."""
    print(f"\n{'='*60}")
    print(f"Processing: {article_name}")
    print('='*60)
    
    result = {
        "article": article_name,
        "status": "unknown",
        "issues_found": 0,
        "corrections_submitted": 0,
        "errors": []
    }
    
    try:
        data, error = fetch_article(playwright, article_name)
        if error:
            result["status"] = "error"
            result["errors"].append(error)
            print(f"  ERROR: {error}")
            results.append(result)
            return
        
        page = data["page"]
        browser = data["browser"]
        content = data["content"]
        
        print(f"  Content length: {len(content)} chars")
        
        # Find issues
        issues = find_inconsistencies(content)
        result["issues_found"] = len(issues)
        
        if issues:
            print(f"  Found {len(issues)} potential issues")
            for issue in issues:
                print(f"    - {issue['problem']}")
        else:
            print("  No obvious inconsistencies found")
        
        # For now, we'll note issues but only submit if we find clear inconsistencies
        # This avoids submitting incorrect corrections
        
        result["status"] = "checked"
        
        page.close()
        browser.close()
        
    except Exception as e:
        result["status"] = "error"
        result["errors"].append(str(e))
        print(f"  ERROR: {e}")
    
    results.append(result)


def main():
    from playwright.sync_api import sync_playwright
    
    if not ensure_browser():
        print("Failed to start browser")
        sys.exit(1)
    
    results = []
    
    with sync_playwright() as playwright:
        for i, article in enumerate(ARTICLES):
            print(f"\n[{i+1}/{len(ARTICLES)}]", end="")
            process_article(playwright, article, results)
            time.sleep(1)  # Small delay between articles
    
    # Summary
    print("\n" + "="*60)
    print("SUMMARY")
    print("="*60)
    
    checked = sum(1 for r in results if r["status"] == "checked")
    errors = sum(1 for r in results if r["status"] == "error")
    issues = sum(r["issues_found"] for r in results)
    
    print(f"Articles processed: {len(results)}")
    print(f"Successfully checked: {checked}")
    print(f"Errors: {errors}")
    print(f"Total issues found: {issues}")
    
    # Save results
    with open("fact_check_results.json", "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nResults saved to fact_check_results.json")


if __name__ == "__main__":
    main()
