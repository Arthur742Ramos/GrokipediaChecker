#!/usr/bin/env python3
"""
Grokipedia Fact-Checker and Editor

This script:
1. Opens a Grokipedia page in a browser
2. Extracts the page content
3. Allows you to review and submit edits via the browser UI

Usage:
    python3 grokipedia_editor.py <article_name>
    
Example:
    python3 grokipedia_editor.py "Lambda calculus"
"""

import sys
import time
from playwright.sync_api import sync_playwright


def extract_page_content(page):
    """Extract the main article content from a Grokipedia page."""
    # Wait for content to load
    page.wait_for_load_state('networkidle')
    time.sleep(2)  # Additional wait for dynamic content
    
    # Try to get the article content
    content = page.evaluate('''() => {
        // Look for article content - adjust selectors based on actual DOM
        const article = document.querySelector('article') || 
                       document.querySelector('[role="article"]') ||
                       document.querySelector('main');
        if (article) {
            return article.innerText;
        }
        // Fallback to body text
        return document.body.innerText;
    }''')
    return content


def select_text_and_suggest_edit(page, text_to_select=None):
    """
    Select text on the page and trigger the 'Suggest Edit' option.
    If text_to_select is None, will select a paragraph.
    """
    # Select text by triple-clicking on a paragraph (selects whole paragraph)
    page.evaluate('''() => {
        // Find first paragraph in article
        const paragraphs = document.querySelectorAll('p');
        for (const p of paragraphs) {
            if (p.innerText.length > 50) {
                // Create a selection
                const range = document.createRange();
                range.selectNodeContents(p);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
                return true;
            }
        }
        return false;
    }''')


def submit_edit(page, summary, edit_content=None, sources=None):
    """
    Submit an edit through the Grokipedia edit modal.
    
    Args:
        page: Playwright page object
        summary: Brief description of the changes
        edit_content: Optional new content to replace selection
        sources: Optional list of source URLs
    """
    # Click on "Suggest Edit" button in the popup menu
    try:
        suggest_edit_btn = page.get_by_text("Suggest Edit")
        suggest_edit_btn.click()
        time.sleep(1)
    except Exception as e:
        print(f"Could not find Suggest Edit button: {e}")
        return False
    
    # Fill in the summary field
    try:
        summary_field = page.locator('textarea, input').filter(has_text="").first
        # Or try to find by placeholder
        summary_field = page.get_by_placeholder("Briefly describe your changes")
        summary_field.fill(summary)
    except Exception as e:
        print(f"Could not fill summary: {e}")
    
    # Optionally expand and fill edit content
    if edit_content:
        try:
            edit_content_toggle = page.get_by_text("Edit content (optional)")
            edit_content_toggle.click()
            time.sleep(0.5)
            # Find the content textarea and fill it
            content_textarea = page.locator('textarea').last
            content_textarea.fill(edit_content)
        except Exception as e:
            print(f"Could not fill edit content: {e}")
    
    # Add sources if provided
    if sources:
        try:
            source_field = page.get_by_placeholder("https://example.com/source")
            for i, source in enumerate(sources):
                if i > 0:
                    add_source_btn = page.get_by_text("Add another source")
                    add_source_btn.click()
                    time.sleep(0.3)
                    source_field = page.locator('input[placeholder*="source"]').last
                source_field.fill(source)
        except Exception as e:
            print(f"Could not add sources: {e}")
    
    # Click Submit Edit button
    try:
        submit_btn = page.get_by_text("Submit Edit")
        submit_btn.click()
        print("Edit submitted successfully!")
        return True
    except Exception as e:
        print(f"Could not submit edit: {e}")
        return False


def interactive_session(article_name):
    """
    Start an interactive browser session for fact-checking and editing.
    The browser will stay open for manual interaction.
    """
    with sync_playwright() as p:
        # Launch browser in headed mode so user can see and interact
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()
        
        # Navigate to the article (URL format: /page/Article_Name)
        article_slug = article_name.replace(' ', '_')
        url = f"https://grokipedia.com/page/{article_slug}"
        print(f"\nOpening: {url}")
        page.goto(url)
        
        # Wait for page to load
        page.wait_for_load_state('networkidle')
        time.sleep(3)
        
        # Extract and display content
        print("\n" + "="*60)
        print("PAGE CONTENT EXTRACTED:")
        print("="*60)
        content = extract_page_content(page)
        print(content[:2000] if len(content) > 2000 else content)
        print("\n..." if len(content) > 2000 else "")
        print("="*60)
        
        # Keep browser open for manual interaction
        print("\n" + "="*60)
        print("INTERACTIVE MODE")
        print("="*60)
        print("""
The browser is now open. You can:
1. Select text on the page and click 'Suggest Edit' to make corrections
2. Use the commands below to automate actions

Commands:
  select  - Select first paragraph for editing
  edit    - Open the edit dialog (after selecting text)
  quit    - Close the browser and exit
        """)
        
        while True:
            try:
                cmd = input("\nEnter command (or 'quit' to exit): ").strip().lower()
                
                if cmd == 'quit' or cmd == 'q':
                    break
                elif cmd == 'select':
                    select_text_and_suggest_edit(page)
                    print("Text selected. Right-click or look for 'Suggest Edit' popup.")
                elif cmd == 'edit':
                    summary = input("Enter edit summary: ")
                    content = input("Enter new content (or press Enter to skip): ")
                    sources = input("Enter source URLs (comma-separated, or press Enter to skip): ")
                    
                    source_list = [s.strip() for s in sources.split(',')] if sources else None
                    submit_edit(page, summary, content if content else None, source_list)
                elif cmd == 'content':
                    content = extract_page_content(page)
                    print(content)
                else:
                    print(f"Unknown command: {cmd}")
                    
            except KeyboardInterrupt:
                break
            except Exception as e:
                print(f"Error: {e}")
        
        browser.close()
        print("\nBrowser closed.")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        print("\nNo article name provided. Starting with 'Lambda calculus' as example...")
        article_name = "Lambda calculus"
    else:
        article_name = " ".join(sys.argv[1:])
    
    interactive_session(article_name)


if __name__ == "__main__":
    main()
