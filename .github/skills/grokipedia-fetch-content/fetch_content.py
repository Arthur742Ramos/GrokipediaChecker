#!/usr/bin/env python3
"""
Grokipedia Content Fetcher
Fetches article content from Grokipedia using Comet browser.
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


def fetch_content(article_name):
    """Fetch content from a Grokipedia article."""
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
        "article": article_name,
        "url": f"https://grokipedia.com/page/{article_name.replace(' ', '_')}",
        "signed_in": False,
        "content": "",
        "sections": []
    }
    
    comet_process = None
    playwright = None
    
    try:
        playwright = sync_playwright().start()
        
        if not os.path.exists(COMET_EXECUTABLE):
            result["error"] = "Comet browser not found"
            return result
        
        if not port_in_use(CDP_PORT):
            comet_process = subprocess.Popen([
                COMET_EXECUTABLE,
                f"--remote-debugging-port={CDP_PORT}",
                f"--user-data-dir={COMET_PROFILE_PATH}",
                "--no-first-run",
                "--no-session-restore",
                "--headless=new",
                "about:blank",
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            
            if not wait_for_cdp(CDP_PORT):
                result["error"] = "Failed to start Comet browser"
                return result
        
        browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{CDP_PORT}")
        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page = context.new_page()
        
        # Navigate to article
        page.goto(result["url"], timeout=60000)
        try:
            page.wait_for_load_state('networkidle', timeout=15000)
        except:
            pass
        time.sleep(2)
        
        # Check if signed in
        login_btn = page.locator('button:has-text("Login")')
        result["signed_in"] = login_btn.count() == 0 or not login_btn.first.is_visible()
        
        # Extract content
        result["content"] = page.evaluate('''() => {
            const article = document.querySelector('article') || 
                           document.querySelector('[role="article"]') ||
                           document.querySelector('main');
            return article ? article.innerText : document.body.innerText;
        }''')
        
        # Extract sections
        result["sections"] = page.evaluate('''() => {
            const result = [];
            const headings = document.querySelectorAll('h1, h2, h3');
            
            headings.forEach((heading) => {
                let content = '';
                let sibling = heading.nextElementSibling;
                
                while (sibling && !['H1', 'H2', 'H3'].includes(sibling.tagName)) {
                    content += sibling.innerText + '\\n';
                    sibling = sibling.nextElementSibling;
                }
                
                result.push({
                    level: heading.tagName,
                    title: heading.innerText,
                    content: content.trim()
                });
            });
            
            return result;
        }''')
        
        page.close()
        browser.close()
        
    except Exception as e:
        result["error"] = str(e)
    finally:
        if playwright:
            playwright.stop()
    
    return result


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: fetch_content.py <article_name>"}))
        sys.exit(1)
    
    article_name = " ".join(sys.argv[1:])
    result = fetch_content(article_name)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
