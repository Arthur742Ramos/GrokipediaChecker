/**
 * Playwright CLI-like Wrapper
 * Provides a playwright-cli compatible interface using Playwright API directly
 * Supports both bundled Chromium and CDP connection to Comet/Chrome/Edge
 */

import { chromium, Browser, BrowserContext, Page } from "playwright";
import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";

const SESSIONS_DIR = path.join(os.homedir(), ".playwright-sessions");

// Browser executable paths for macOS
const BROWSER_PATHS: Record<string, string> = {
  comet: "/Applications/Comet.app/Contents/MacOS/Comet",
  chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  edge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
};

export type BrowserType = "chromium" | "comet" | "chrome" | "edge";

export interface PlaywrightCLIOptions {
  session?: string;
  headed?: boolean;
  timeout?: number;
  browserType?: BrowserType;
  cdpPort?: number;
}

// Track CDP browser processes
let cdpProcess: ChildProcess | null = null;
let cdpPort: number = 9224;

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, "127.0.0.1");
  });
}

function waitForCdp(port: number, timeout: number = 20000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/json/version",
          method: "GET",
          timeout: 2000,
        },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve(true));
        }
      );
      req.on("error", () => {
        if (Date.now() - start < timeout) {
          setTimeout(check, 500);
        } else {
          resolve(false);
        }
      });
      req.on("timeout", () => {
        req.destroy();
        if (Date.now() - start < timeout) {
          setTimeout(check, 500);
        } else {
          resolve(false);
        }
      });
      req.end();
    };
    check();
  });
}

/**
 * Playwright CLI Session
 * Manages a persistent browser session with Playwright API
 * Supports both Chromium and CDP-based browsers (Comet, Chrome, Edge)
 */
export class PlaywrightCLISession {
  private sessionName: string;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private headed: boolean = false;
  private sessionDir: string;
  private browserType: BrowserType;
  private cdpPort: number;
  private useCdp: boolean;

  constructor(sessionName: string, options: Omit<PlaywrightCLIOptions, "session"> = {}) {
    this.sessionName = sessionName;
    this.headed = options.headed || false;
    this.sessionDir = path.join(SESSIONS_DIR, sessionName);
    this.browserType = options.browserType || "chromium";
    this.cdpPort = options.cdpPort || 9224;
    this.useCdp = ["comet", "chrome", "edge"].includes(this.browserType);
    
    // Ensure session directory exists
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  /**
   * Launch CDP browser (Comet, Chrome, Edge)
   */
  private async launchCdpBrowser(): Promise<Browser> {
    const executablePath = BROWSER_PATHS[this.browserType];
    
    if (!executablePath || !fs.existsSync(executablePath)) {
      throw new Error(`Browser ${this.browserType} not found at ${executablePath}`);
    }

    // Use browser's native user data directory for existing login sessions
    const userDataDir = this.browserType === "comet" 
      ? path.join(os.homedir(), "Library/Application Support/Comet")
      : this.browserType === "chrome"
      ? path.join(os.homedir(), "Library/Application Support/Google/Chrome")
      : path.join(os.homedir(), "Library/Application Support/Microsoft Edge");

    // Check if CDP port is already in use
    const portUsed = await portInUse(this.cdpPort);

    if (!portUsed) {
      const args = [
        `--remote-debugging-port=${this.cdpPort}`,
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
      ];

      if (!this.headed) {
        args.push("--headless=new");
      }

      args.push("about:blank");

      console.log(`Launching ${this.browserType} browser...`);
      cdpProcess = spawn(executablePath, args, {
        stdio: "ignore",
        detached: true,
      });

      // Wait for browser to start
      await new Promise((r) => setTimeout(r, 2000));

      const ready = await waitForCdp(this.cdpPort, 25000);
      if (!ready) {
        if (cdpProcess) {
          try {
            cdpProcess.kill();
          } catch {}
        }
        throw new Error(`${this.browserType} browser CDP not responding`);
      }
    } else {
      console.log(`Connecting to existing ${this.browserType} on port ${this.cdpPort}...`);
    }

    return await chromium.connectOverCDP(`http://127.0.0.1:${this.cdpPort}`, { timeout: 15000 });
  }

  /**
   * Ensure browser is launched and page is ready
   */
  private async ensureBrowser(): Promise<Page> {
    // Check if browser connection is still valid
    let needsReconnect = !this.browser || !this.browser.isConnected();
    
    // Also check if the page is still usable
    if (!needsReconnect && this.page) {
      try {
        // Quick check if page is still responsive
        await this.page.evaluate(() => true);
      } catch {
        needsReconnect = true;
        this.page = null;
      }
    }
    
    if (needsReconnect) {
      // Clean up old connections
      if (this.browser) {
        try {
          await this.browser.close();
        } catch {}
        this.browser = null;
        this.context = null;
        this.page = null;
      }
      
      if (this.useCdp) {
        // Use CDP for Comet/Chrome/Edge - preserves existing login
        this.browser = await this.launchCdpBrowser();
        this.context = this.browser.contexts()[0] || await this.browser.newContext();
        this.page = await this.context.newPage();
      } else {
        // Use Playwright's bundled Chromium
        const storageStatePath = path.join(this.sessionDir, "storage-state.json");
        
        this.browser = await chromium.launch({
          headless: !this.headed,
        });

        if (fs.existsSync(storageStatePath)) {
          try {
            this.context = await this.browser.newContext({
              viewport: { width: 1280, height: 800 },
              storageState: storageStatePath,
            });
          } catch {
            this.context = await this.browser.newContext({
              viewport: { width: 1280, height: 800 },
            });
          }
        } else {
          this.context = await this.browser.newContext({
            viewport: { width: 1280, height: 800 },
          });
        }

        this.page = await this.context.newPage();
      }
    }

    if (!this.page) {
      this.page = await this.context!.newPage();
    }

    return this.page;
  }

  /**
   * Save session state (only for Chromium, CDP browsers use native profiles)
   */
  private async saveState(): Promise<void> {
    if (this.context && !this.useCdp) {
      try {
        const storageStatePath = path.join(this.sessionDir, "storage-state.json");
        await this.context.storageState({ path: storageStatePath });
      } catch {
        // Ignore errors saving state
      }
    }
  }

  /**
   * Open a URL in the browser
   */
  async open(url: string, headed?: boolean): Promise<string> {
    if (headed !== undefined && !this.useCdp) {
      this.headed = headed;
    }
    const page = await this.ensureBrowser();
    await page.goto(url, { timeout: 60000 });
    
    // Wait for page to be ready
    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 });
    } catch {
      // Continue even if networkidle times out
    }
    
    return `Navigated to ${url}`;
  }

  /**
   * Close the current page
   */
  async close(): Promise<void> {
    await this.saveState();
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
  }

  /**
   * Get a snapshot of the current page (accessibility tree style)
   */
  async snapshot(): Promise<string> {
    const page = await this.ensureBrowser();
    
    // Build a simple accessibility-style snapshot
    const snapshot = await page.evaluate(() => {
      const elements: string[] = [];
      let refCounter = 1;
      
      const processElement = (el: Element, depth: number = 0) => {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role") || "";
        const text = (el as HTMLElement).innerText?.substring(0, 50) || "";
        const type = (el as HTMLInputElement).type || "";
        
        // Only include interactive elements
        const interactiveRoles = ["button", "link", "textbox", "checkbox", "radio", "combobox", "menuitem"];
        const interactiveTags = ["button", "a", "input", "textarea", "select"];
        
        if (interactiveTags.includes(tag) || interactiveRoles.includes(role)) {
          const ref = `e${refCounter++}`;
          let desc = `- ${role || tag}`;
          if (text) desc += ` "${text.replace(/\n/g, " ").trim()}"`;
          if (type) desc += ` [${type}]`;
          desc += ` [ref=${ref}]`;
          elements.push(desc);
        }
        
        // Process children
        for (const child of el.children) {
          processElement(child, depth + 1);
        }
      };
      
      processElement(document.body);
      return elements.join("\n");
    });
    
    return snapshot;
  }

  /**
   * Type text into the focused element
   */
  async type(text: string): Promise<string> {
    const page = await this.ensureBrowser();
    await page.keyboard.type(text);
    return `Typed: ${text}`;
  }

  /**
   * Click on an element by ref
   */
  async click(ref: string): Promise<string> {
    const page = await this.ensureBrowser();
    const index = parseInt(ref.replace("e", "")) - 1;
    
    // Find the element by index in interactive elements
    const clicked = await page.evaluate((idx) => {
      const elements: Element[] = [];
      
      const processElement = (el: Element) => {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role") || "";
        const interactiveRoles = ["button", "link", "textbox", "checkbox", "radio", "combobox", "menuitem"];
        const interactiveTags = ["button", "a", "input", "textarea", "select"];
        
        if (interactiveTags.includes(tag) || interactiveRoles.includes(role)) {
          elements.push(el);
        }
        
        for (const child of el.children) {
          processElement(child);
        }
      };
      
      processElement(document.body);
      
      if (idx >= 0 && idx < elements.length) {
        (elements[idx] as HTMLElement).click();
        return true;
      }
      return false;
    }, index);
    
    if (!clicked) {
      throw new Error(`Element ${ref} not found`);
    }
    
    return `Clicked ${ref}`;
  }

  /**
   * Double-click on an element by ref
   */
  async dblclick(ref: string): Promise<string> {
    const page = await this.ensureBrowser();
    const index = parseInt(ref.replace("e", "")) - 1;
    
    const element = await this.getElementByIndex(page, index);
    if (element) {
      await element.dblclick();
      return `Double-clicked ${ref}`;
    }
    throw new Error(`Element ${ref} not found`);
  }

  /**
   * Helper to get element by index - uses same traversal order as snapshot()
   */
  private async getElementByIndex(page: Page, index: number) {
    // Use the same document-order traversal as snapshot() to ensure consistency
    const handle = await page.evaluateHandle((idx) => {
      const interactiveRoles = ["button", "link", "textbox", "checkbox", "radio", "combobox", "menuitem"];
      const interactiveTags = ["button", "a", "input", "textarea", "select"];
      const elements: Element[] = [];
      
      const processElement = (el: Element) => {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role") || "";
        
        if (interactiveTags.includes(tag) || interactiveRoles.includes(role)) {
          elements.push(el);
        }
        
        for (const child of el.children) {
          processElement(child);
        }
      };
      
      processElement(document.body);
      
      if (idx >= 0 && idx < elements.length) {
        return elements[idx];
      }
      return null;
    }, index);
    
    // Convert JSHandle to ElementHandle
    const element = handle.asElement();
    if (element) {
      return element;
    }
    await handle.dispose();
    return null;
  }

  /**
   * Fill an input element with text
   */
  async fill(ref: string, text: string): Promise<string> {
    const page = await this.ensureBrowser();
    const index = parseInt(ref.replace("e", "")) - 1;
    
    const element = await this.getElementByIndex(page, index);
    if (element) {
      await element.fill(text);
      return `Filled ${ref} with "${text}"`;
    }
    throw new Error(`Element ${ref} not found`);
  }

  /**
   * Hover over an element
   */
  async hover(ref: string): Promise<string> {
    const page = await this.ensureBrowser();
    const index = parseInt(ref.replace("e", "")) - 1;
    
    const element = await this.getElementByIndex(page, index);
    if (element) {
      await element.hover();
      return `Hovered ${ref}`;
    }
    throw new Error(`Element ${ref} not found`);
  }

  /**
   * Select an option from a dropdown
   */
  async select(ref: string, value: string): Promise<string> {
    const page = await this.ensureBrowser();
    const index = parseInt(ref.replace("e", "")) - 1;
    
    const element = await this.getElementByIndex(page, index);
    if (element) {
      await element.selectOption(value);
      return `Selected "${value}" in ${ref}`;
    }
    throw new Error(`Element ${ref} not found`);
  }

  /**
   * Check a checkbox or radio button
   */
  async check(ref: string): Promise<string> {
    const page = await this.ensureBrowser();
    const index = parseInt(ref.replace("e", "")) - 1;
    
    const element = await this.getElementByIndex(page, index);
    if (element) {
      await element.check();
      return `Checked ${ref}`;
    }
    throw new Error(`Element ${ref} not found`);
  }

  /**
   * Uncheck a checkbox
   */
  async uncheck(ref: string): Promise<string> {
    const page = await this.ensureBrowser();
    const index = parseInt(ref.replace("e", "")) - 1;
    
    const element = await this.getElementByIndex(page, index);
    if (element) {
      await element.uncheck();
      return `Unchecked ${ref}`;
    }
    throw new Error(`Element ${ref} not found`);
  }

  /**
   * Press a key
   */
  async press(key: string): Promise<string> {
    const page = await this.ensureBrowser();
    await page.keyboard.press(key);
    return `Pressed ${key}`;
  }

  /**
   * Evaluate JavaScript on the page
   */
  async eval(script: string, ref?: string): Promise<string> {
    const page = await this.ensureBrowser();
    
    if (ref) {
      const index = parseInt(ref.replace("e", "")) - 1;
      const element = await this.getElementByIndex(page, index);
      if (element) {
        const result = await element.evaluate(new Function("el", `return (${script})(el)`) as any);
        return String(result);
      }
      throw new Error(`Element ${ref} not found`);
    }
    
    const result = await page.evaluate(script);
    return String(result);
  }

  /**
   * Run a Playwright code snippet
   */
  async runCode(code: string): Promise<string> {
    const page = await this.ensureBrowser();
    // Execute code in page context
    const result = await page.evaluate(code);
    return String(result);
  }

  /**
   * Take a screenshot
   */
  async screenshot(ref?: string): Promise<string> {
    const page = await this.ensureBrowser();
    const screenshotPath = path.join(this.sessionDir, `screenshot-${Date.now()}.png`);
    
    if (ref) {
      const index = parseInt(ref.replace("e", "")) - 1;
      const element = await this.getElementByIndex(page, index);
      if (element) {
        await element.screenshot({ path: screenshotPath });
        return screenshotPath;
      }
      throw new Error(`Element ${ref} not found`);
    }
    
    await page.screenshot({ path: screenshotPath });
    return screenshotPath;
  }

  /**
   * Navigate back
   */
  async goBack(): Promise<string> {
    const page = await this.ensureBrowser();
    await page.goBack();
    return "Navigated back";
  }

  /**
   * Navigate forward
   */
  async goForward(): Promise<string> {
    const page = await this.ensureBrowser();
    await page.goForward();
    return "Navigated forward";
  }

  /**
   * Reload the page
   */
  async reload(): Promise<string> {
    const page = await this.ensureBrowser();
    await page.reload();
    return "Reloaded page";
  }

  /**
   * Get console logs
   */
  async console(minLevel?: string): Promise<string> {
    return "Console logging not yet implemented";
  }

  /**
   * Get network requests
   */
  async network(): Promise<string> {
    return "Network logging not yet implemented";
  }

  /**
   * Resize the browser window
   */
  async resize(width: number, height: number): Promise<string> {
    const page = await this.ensureBrowser();
    await page.setViewportSize({ width, height });
    return `Resized to ${width}x${height}`;
  }

  /**
   * Move mouse to position
   */
  async mouseMove(x: number, y: number): Promise<string> {
    const page = await this.ensureBrowser();
    await page.mouse.move(x, y);
    return `Moved mouse to ${x}, ${y}`;
  }

  /**
   * Mouse down
   */
  async mouseDown(button?: "left" | "right" | "middle"): Promise<string> {
    const page = await this.ensureBrowser();
    await page.mouse.down({ button: button || "left" });
    return "Mouse down";
  }

  /**
   * Mouse up
   */
  async mouseUp(button?: "left" | "right" | "middle"): Promise<string> {
    const page = await this.ensureBrowser();
    await page.mouse.up({ button: button || "left" });
    return "Mouse up";
  }

  /**
   * Accept a dialog
   */
  async dialogAccept(text?: string): Promise<string> {
    return "Dialog accepted (if present)";
  }

  /**
   * Dismiss a dialog
   */
  async dialogDismiss(): Promise<string> {
    return "Dialog dismissed (if present)";
  }

  /**
   * Wait for a timeout
   */
  async wait(ms: number): Promise<string> {
    const page = await this.ensureBrowser();
    await page.waitForTimeout(ms);
    return `Waited ${ms}ms`;
  }

  /**
   * Get the session name
   */
  getSessionName(): string {
    return this.sessionName;
  }

  /**
   * Get the underlying page (for advanced operations)
   */
  async getPage(): Promise<Page> {
    return this.ensureBrowser();
  }

  /**
   * Stop this session
   */
  async stop(): Promise<void> {
    await this.saveState();
    if (this.page) {
      try {
        await this.page.close();
      } catch {}
      this.page = null;
    }
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {}
      this.browser = null;
    }
    this.context = null;
  }

  /**
   * Delete this session (stops and removes profile data)
   */
  async delete(): Promise<void> {
    await this.stop();
    try {
      fs.rmSync(this.sessionDir, { recursive: true, force: true });
    } catch {
      // Ignore errors when deleting
    }
  }
}

/**
 * Session Manager - manages multiple playwright-cli style sessions
 */
export class PlaywrightCLIManager {
  private sessions: Map<string, PlaywrightCLISession> = new Map();
  private sessionCounter: number = 0;
  private browserType: BrowserType = "chromium";
  private headed: boolean = false;

  /**
   * Set default browser type for new sessions
   */
  setBrowserType(type: BrowserType): void {
    this.browserType = type;
  }

  /**
   * Set default headed mode for new sessions
   */
  setHeaded(headed: boolean): void {
    this.headed = headed;
  }

  /**
   * Create a new session with a unique name
   */
  createSession(prefix: string = "grokipedia", headed?: boolean): PlaywrightCLISession {
    const sessionName = `${prefix}-${Date.now()}-${this.sessionCounter++}`;
    const session = new PlaywrightCLISession(sessionName, { 
      headed: headed ?? this.headed,
      browserType: this.browserType,
    });
    this.sessions.set(sessionName, session);
    return session;
  }

  /**
   * Get an existing session by name
   */
  getSession(name: string): PlaywrightCLISession | undefined {
    return this.sessions.get(name);
  }

  /**
   * List all managed sessions
   */
  listSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Stop a specific session
   */
  async stopSession(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (session) {
      await session.stop();
      this.sessions.delete(name);
    }
  }

  /**
   * Stop all managed sessions
   */
  async stopAll(): Promise<void> {
    for (const [name, session] of this.sessions) {
      await session.stop();
    }
    this.sessions.clear();
  }
}

// Default manager instance
export const playwrightCLI = new PlaywrightCLIManager();

/**
 * Parse a snapshot output to extract element refs
 */
export function parseSnapshot(snapshotOutput: string): Map<string, string> {
  const elements = new Map<string, string>();
  
  const lines = snapshotOutput.split("\n");
  
  for (const line of lines) {
    const refMatch = line.match(/\[ref=(e\d+)\]/);
    if (refMatch) {
      const ref = refMatch[1];
      const description = line.replace(/\[ref=e\d+\]/, "").trim();
      elements.set(ref, description);
    }
  }
  
  return elements;
}

/**
 * Find an element ref by text content in a snapshot
 */
export function findRefByText(
  snapshotOutput: string,
  searchText: string,
  options: { caseSensitive?: boolean; partial?: boolean } = {}
): string | null {
  const { caseSensitive = false, partial = true } = options;
  
  const lines = snapshotOutput.split("\n");
  const searchLower = caseSensitive ? searchText : searchText.toLowerCase();
  
  for (const line of lines) {
    const lineLower = caseSensitive ? line : line.toLowerCase();
    
    if (partial ? lineLower.includes(searchLower) : lineLower === searchLower) {
      const refMatch = line.match(/\[ref=(e\d+)\]/);
      if (refMatch) {
        return refMatch[1];
      }
    }
  }
  
  return null;
}

/**
 * Find all element refs matching a pattern
 */
export function findRefsByPattern(
  snapshotOutput: string,
  pattern: RegExp
): Array<{ ref: string; line: string }> {
  const matches: Array<{ ref: string; line: string }> = [];
  
  const lines = snapshotOutput.split("\n");
  
  for (const line of lines) {
    if (pattern.test(line)) {
      const refMatch = line.match(/\[ref=(e\d+)\]/);
      if (refMatch) {
        matches.push({ ref: refMatch[1], line: line.trim() });
      }
    }
  }
  
  return matches;
}
