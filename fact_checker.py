#!/usr/bin/env python3
"""
Grokipedia Auto Fact-Checker

This script automates fact-checking of Grokipedia pages:
1. Opens a page and extracts content
2. Fact-checks claims using web search (manual step - you provide corrections)
3. Submits edits through the browser

NOTE: You must sign in to Grokipedia to submit edits.
      The script will open a browser for you to sign in manually.

Usage:
    python3 fact_checker.py <article_name>
"""

import sys
import time
import json
import os
from playwright.sync_api import sync_playwright

# Path to Comet browser executable and profile
COMET_EXECUTABLE = "/Applications/Comet.app/Contents/MacOS/Comet"
COMET_PROFILE_PATH = os.path.expanduser("~/Library/Application Support/Comet")
CDP_PORT = 9222


class GrokipediaFactChecker:
    def __init__(self, headless=False):
        self.headless = headless
        self.playwright = None
        self.browser = None
        self.page = None
        self.is_signed_in = False
        self.using_comet = False
        self.comet_process = None
        
    def start(self):
        """Initialize the browser by launching Comet with remote debugging."""
        import subprocess
        import socket
        
        self.playwright = sync_playwright().start()
        
        if not os.path.exists(COMET_EXECUTABLE):
            print("Comet browser not found, using default Chromium...")
            self.context = self.playwright.chromium.launch_persistent_context(
                os.path.expanduser("~/.grokipedia_session"),
                headless=self.headless,
                viewport={'width': 1280, 'height': 800}
            )
            self.page = self.context.pages[0] if self.context.pages else self.context.new_page()
            return
        
        # Check if Comet is already running with debugging port
        def port_in_use(port):
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                return s.connect_ex(('127.0.0.1', port)) == 0
        
        def wait_for_cdp(port, timeout=15):
            """Wait for CDP to be ready by checking /json/version endpoint."""
            import urllib.request
            for _ in range(timeout * 2):
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1)
                    return True
                except:
                    time.sleep(0.5)
            return False
        
        if not port_in_use(CDP_PORT):
            print(f"Launching Comet browser with remote debugging on port {CDP_PORT}...")
            self.comet_process = subprocess.Popen([
                COMET_EXECUTABLE,
                f"--remote-debugging-port={CDP_PORT}",
                f"--user-data-dir={COMET_PROFILE_PATH}",
                "--no-first-run",
                "--no-session-restore",
                "about:blank",
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            
            if not wait_for_cdp(CDP_PORT):
                raise RuntimeError("Comet browser failed to start CDP server")
        else:
            print(f"Connecting to existing Comet browser on port {CDP_PORT}...")
        
        # Connect to browser via CDP
        self.browser = self.playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{CDP_PORT}")
        self.context = self.browser.contexts[0] if self.browser.contexts else self.browser.new_context()
        # Always create a fresh page for reliability
        self.page = self.context.new_page()
        self.using_comet = True
        
    def stop(self):
        """Close the page but leave browser running for reuse."""
        if hasattr(self, 'page') and self.page:
            try:
                self.page.close()
            except:
                pass
        if hasattr(self, 'browser') and self.browser:
            try:
                self.browser.close()
            except:
                pass
        if hasattr(self, 'playwright') and self.playwright:
            self.playwright.stop()
    
    def check_signed_in(self):
        """Check if user is signed in to Grokipedia."""
        # If there's no Login button visible, user is signed in
        login_btn = self.page.locator('button:has-text("Login")')
        if login_btn.count() == 0:
            self.is_signed_in = True
        else:
            try:
                self.is_signed_in = not login_btn.first.is_visible()
            except:
                self.is_signed_in = True  # Assume signed in if we can't check
        return self.is_signed_in
    
    def sign_in(self):
        """Open sign-in flow and wait for user to complete it."""
        print("\n" + "="*60)
        print("SIGN IN REQUIRED")
        print("="*60)
        print("Please sign in to Grokipedia in the browser window.")
        print("The script will continue once you're signed in.")
        print("="*60 + "\n")
        
        # Click the Login button
        login_btn = self.page.locator('button:has-text("Login")').first
        if login_btn.count() > 0:
            login_btn.click()
            time.sleep(2)
        
        # Wait for user to complete sign-in
        while not self.check_signed_in():
            time.sleep(2)
            # Refresh check
            self.page.reload()
            time.sleep(2)
        
        print("Successfully signed in!")
            
    def open_article(self, article_name):
        """Navigate to an article page."""
        article_slug = article_name.replace(' ', '_')
        url = f"https://grokipedia.com/page/{article_slug}"
        print(f"Opening: {url}")
        self.page.goto(url, timeout=60000)
        try:
            self.page.wait_for_load_state('networkidle', timeout=15000)
        except:
            pass  # Continue even if networkidle times out
        time.sleep(2)
        
    def get_content(self):
        """Extract the article content."""
        content = self.page.evaluate('''() => {
            const article = document.querySelector('article') || 
                           document.querySelector('[role="article"]') ||
                           document.querySelector('main');
            if (article) {
                return article.innerText;
            }
            return document.body.innerText;
        }''')
        return content
    
    def get_sections(self):
        """Get content organized by sections."""
        sections = self.page.evaluate('''() => {
            const result = [];
            const headings = document.querySelectorAll('h1, h2, h3');
            
            headings.forEach((heading, index) => {
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
        return sections
    
    def select_paragraph(self, paragraph_index=0):
        """Select a paragraph in the article by index."""
        text_blocks = self.page.locator('article span.mb-4')
        if text_blocks.count() > paragraph_index:
            block = text_blocks.nth(paragraph_index)
            box = block.bounding_box()
            if box:
                # Triple click to select paragraph
                self.page.mouse.click(box['x'] + 50, box['y'] + 10, click_count=3)
                time.sleep(0.5)
                return True
        return False
    
    def select_text_by_content(self, text_fragment):
        """Select specific text on the page."""
        # First find the element containing this text
        element = self.page.locator(f'text="{text_fragment[:50]}"').first
        if element.count() > 0:
            box = element.bounding_box()
            if box:
                self.page.mouse.click(box['x'] + 10, box['y'] + 5, click_count=3)
                time.sleep(0.5)
                return True
        
        # Fallback: use JavaScript selection
        success = self.page.evaluate(f'''(textToFind) => {{
            const walker = document.createTreeWalker(
                document.body,
                NodeFilter.SHOW_TEXT,
                null,
                false
            );
            
            let node;
            while (node = walker.nextNode()) {{
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
        }}''', text_fragment)
        return success
    
    def click_suggest_edit(self):
        """Click the Suggest Edit button after text selection."""
        try:
            time.sleep(0.5)
            
            # Use JavaScript to find and click the button
            clicked = self.page.evaluate('''() => {
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                    if (btn.textContent.includes('Suggest Edit')) {
                        btn.click();
                        return true;
                    }
                }
                return false;
            }''')
            
            if clicked:
                time.sleep(1)
                
                # Check if sign-in modal appeared
                sign_in_modal = self.page.locator('text=Sign in required')
                if sign_in_modal.count() > 0:
                    print("Sign in required to suggest edits.")
                    sign_in_btn = self.page.locator('button:has-text("Sign In")').first
                    if sign_in_btn.count() > 0:
                        sign_in_btn.click()
                        time.sleep(2)
                        print("Please complete sign-in in the browser...")
                        input("Press Enter once signed in...")
                        return False
                return True
            return False
        except Exception as e:
            print(f"Could not click Suggest Edit: {e}")
            return False
    
    def fill_edit_form(self, summary, new_content=None, sources=None):
        """Fill in the edit submission form."""
        try:
            # Wait for modal to appear
            time.sleep(1)
            
            # Fill summary - find the textarea in the modal
            summary_input = self.page.locator('textarea[placeholder*="Briefly"], textarea[placeholder*="describe"], textarea').first
            summary_input.fill(summary)
            time.sleep(0.3)
            
            # Fill new content if provided - expand the section first
            if new_content:
                try:
                    expand_btn = self.page.locator('button:has-text("Edit content"), [data-state="closed"]:has-text("Edit content")')
                    if expand_btn.count() > 0:
                        expand_btn.first.click()
                        time.sleep(0.5)
                    # Find the second textarea for content
                    content_textarea = self.page.locator('textarea').nth(1)
                    if content_textarea.count() > 0:
                        content_textarea.fill(new_content)
                except Exception as e:
                    print(f"Could not fill content: {e}")
            
            # Add sources if provided
            if sources:
                try:
                    for i, source in enumerate(sources):
                        if i > 0:
                            add_btn = self.page.locator('button:has-text("Add another")')
                            if add_btn.count() > 0:
                                add_btn.click()
                                time.sleep(0.3)
                        source_input = self.page.locator('input[placeholder*="http"], input[placeholder*="source"]').last
                        if source_input.count() > 0:
                            source_input.fill(source)
                            time.sleep(0.2)
                except Exception as e:
                    print(f"Could not add sources: {e}")
            
            return True
        except Exception as e:
            print(f"Error filling form: {e}")
            return False
    
    def submit_edit(self):
        """Click the Submit Edit button."""
        try:
            submit_btn = self.page.locator('button:has-text("Submit Edit"), button:has-text("Submit")')
            if submit_btn.count() > 0:
                submit_btn.first.click()
                time.sleep(2)
                print("Edit submitted!")
                return True
            else:
                print("Submit button not found")
                return False
        except Exception as e:
            print(f"Could not submit: {e}")
            return False
    
    def make_correction(self, incorrect_text, summary, correct_text=None, sources=None):
        """
        Make a correction to the article.
        
        Args:
            incorrect_text: The text to select/correct
            summary: Description of the correction
            correct_text: Optional replacement text
            sources: Optional list of source URLs
        """
        print(f"\nMaking correction: {summary}")
        
        # Select the incorrect text
        if not self.select_text_by_content(incorrect_text):
            print(f"Could not find text: {incorrect_text[:50]}...")
            return False
        
        # Trigger the selection popup (simulate mouse up event)
        self.page.evaluate('''() => {
            document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
        }''')
        time.sleep(0.5)
        
        # Click Suggest Edit
        if not self.click_suggest_edit():
            return False
        
        # Fill in the form
        if not self.fill_edit_form(summary, correct_text, sources):
            return False
        
        # Submit
        return self.submit_edit()


def interactive_fact_check(article_name):
    """Run an interactive fact-checking session."""
    checker = GrokipediaFactChecker(headless=False)
    
    try:
        checker.start()
        checker.open_article(article_name)
        
        # Check if signed in
        if not checker.check_signed_in():
            if checker.using_comet:
                print("\nUsing Comet profile but not signed in to Grokipedia.")
            else:
                print("\nYou are not signed in. Sign in is required to submit edits.")
                print("TIP: Close Comet browser to reuse its login session.")
            response = input("Would you like to sign in now? (y/n): ").strip().lower()
            if response == 'y':
                checker.sign_in()
        else:
            print("\n✓ Signed in to Grokipedia")
        
        # Get and display content
        print("\n" + "="*60)
        print(f"ARTICLE: {article_name}")
        print("="*60)
        
        content = checker.get_content()
        print(content[:3000])
        if len(content) > 3000:
            print("\n... (content truncated)")
        
        print("\n" + "="*60)
        print("FACT-CHECKING MODE")
        print("="*60)
        print("""
Review the content above and identify any factual errors.

Commands:
  content         - Show full article content
  sections        - Show content by sections
  correct <text>  - Start a correction (you'll be prompted for details)
  manual          - Keep browser open for manual editing
  quit            - Exit
        """)
        
        while True:
            try:
                cmd = input("\n> ").strip()
                
                if cmd == 'quit' or cmd == 'q':
                    break
                elif cmd == 'content':
                    print(checker.get_content())
                elif cmd == 'sections':
                    sections = checker.get_sections()
                    for s in sections:
                        print(f"\n[{s['level']}] {s['title']}")
                        print("-" * 40)
                        print(s['content'][:500])
                elif cmd.startswith('correct '):
                    incorrect = cmd[8:]
                    summary = input("Summary of correction: ")
                    correct = input("Correct text (or Enter to skip): ")
                    sources = input("Sources (comma-separated, or Enter to skip): ")
                    
                    source_list = [s.strip() for s in sources.split(',')] if sources else None
                    checker.make_correction(
                        incorrect,
                        summary,
                        correct if correct else None,
                        source_list
                    )
                elif cmd == 'manual':
                    print("Browser left open. Press Enter when done...")
                    input()
                else:
                    print(f"Unknown command: {cmd}")
                    
            except KeyboardInterrupt:
                break
            except Exception as e:
                print(f"Error: {e}")
                
    finally:
        checker.stop()
        print("\nSession ended.")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        article_name = input("\nEnter article name: ").strip()
        if not article_name:
            article_name = "Lambda calculus"
    else:
        article_name = " ".join(sys.argv[1:])
    
    interactive_fact_check(article_name)


if __name__ == "__main__":
    main()
