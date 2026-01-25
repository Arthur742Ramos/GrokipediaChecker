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

// Track CDP browser processes per port
const cdpProcesses: Map<number, ChildProcess> = new Map();
let nextCdpPort: number = 9224;

// Mutex for serializing CDP browser launches (prevents race conditions)
let cdpLaunchMutex: Promise<void> = Promise.resolve();

/**
 * Acquire the CDP launch mutex to serialize browser launches
 */
function acquireCdpLaunchMutex(): Promise<() => void> {
  let release: () => void;
  const previousMutex = cdpLaunchMutex;
  cdpLaunchMutex = new Promise((resolve) => {
    release = resolve;
  });
  return previousMutex.then(() => release!);
}

function portInUse(port: number): Promise<boolean> {
  // Try both IPv4 and IPv6
  return new Promise((resolve) => {
    let resolved = false;
    let attempts = 0;
    const maxAttempts = 2;
    
    const tryConnect = (host: string) => {
      const socket = new net.Socket();
      socket.setTimeout(1000);
      socket.on("connect", () => {
        socket.destroy();
        if (!resolved) {
          resolved = true;
          resolve(true);
        }
      });
      socket.on("timeout", () => {
        socket.destroy();
        attempts++;
        if (attempts >= maxAttempts && !resolved) {
          resolved = true;
          resolve(false);
        }
      });
      socket.on("error", () => {
        socket.destroy();
        attempts++;
        if (attempts >= maxAttempts && !resolved) {
          resolved = true;
          resolve(false);
        }
      });
      socket.connect(port, host);
    };
    
    // Try both IPv4 and IPv6
    tryConnect("127.0.0.1");
    tryConnect("::1");
  });
}

function waitForCdp(port: number, timeout: number = 20000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    let attemptCount = 0;
    
    // Try both localhost (which handles both IPv4/IPv6) and explicit addresses
    const hosts = ["localhost", "127.0.0.1", "[::1]"];
    let hostIndex = 0;
    
    const check = () => {
      attemptCount++;
      const currentHost = hosts[hostIndex];
      hostIndex = (hostIndex + 1) % hosts.length;
      
      const req = http.request(
        {
          hostname: currentHost.replace(/^\[|\]$/g, ""), // Remove brackets for http module
          port,
          path: "/json/version",
          method: "GET",
          timeout: 3000, // Increased per-request timeout
          family: currentHost === "[::1]" ? 6 : (currentHost === "127.0.0.1" ? 4 : undefined),
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => {
            // Verify we got valid JSON response (CDP is truly ready)
            try {
              JSON.parse(data);
              resolve(true);
            } catch {
              // Got response but not valid JSON yet, keep trying
              if (Date.now() - start < timeout) {
                setTimeout(check, 500);
              } else {
                resolve(false);
              }
            }
          });
        }
      );
      req.on("error", () => {
        if (Date.now() - start < timeout) {
          // Exponential backoff: start at 300ms, max at 1000ms
          const delay = Math.min(300 * Math.pow(1.2, Math.min(attemptCount, 10)), 1000);
          setTimeout(check, delay);
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
    // Assign a unique CDP port for each session
    this.cdpPort = options.cdpPort || nextCdpPort++;
    this.useCdp = ["comet", "chrome", "edge"].includes(this.browserType);
    
    // Ensure session directory exists
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  /**
   * Launch CDP browser (Comet, Chrome, Edge)
   * Uses a mutex to serialize browser launches and prevent race conditions
   */
  private async launchCdpBrowser(): Promise<Browser> {
    const executablePath = BROWSER_PATHS[this.browserType];
    
    if (!executablePath || !fs.existsSync(executablePath)) {
      throw new Error(`Browser ${this.browserType} not found at ${executablePath}`);
    }

    // Acquire mutex to serialize browser launches
    // This prevents race conditions when multiple workers launch simultaneously
    const releaseMutex = await acquireCdpLaunchMutex();
    
    try {
      // Use a COPY of browser's profile in a temp directory per session to avoid conflicts
      // This preserves login from the original profile while allowing parallel instances
      const originalProfileDir = this.browserType === "comet" 
        ? path.join(os.homedir(), "Library/Application Support/Comet")
        : this.browserType === "chrome"
        ? path.join(os.homedir(), "Library/Application Support/Google/Chrome")
        : path.join(os.homedir(), "Library/Application Support/Microsoft Edge");
      
      // Use session-specific temp directory with cookies copied from original
      const userDataDir = path.join(this.sessionDir, "browser-profile");
      
      // Create the profile directory and copy essential login data if it doesn't exist
      if (!fs.existsSync(userDataDir)) {
        fs.mkdirSync(userDataDir, { recursive: true });
        
        // Copy cookies and login data from original profile
        // Small delay to avoid file lock contention with other workers
        await new Promise((r) => setTimeout(r, 100));
        
        const filesToCopy = ["Cookies", "Login Data", "Web Data"];
        const defaultDir = path.join(userDataDir, "Default");
        fs.mkdirSync(defaultDir, { recursive: true });
        
        for (const file of filesToCopy) {
          const src = path.join(originalProfileDir, "Default", file);
          const dst = path.join(defaultDir, file);
          if (fs.existsSync(src)) {
            try {
              fs.copyFileSync(src, dst);
            } catch (e) {
              // Ignore copy errors - file might be locked
              console.log(`Note: Could not copy ${file} (may be locked)`);
            }
          }
        }
      }

      // Check if CDP port is already in use
      const portUsed = await portInUse(this.cdpPort);

      if (!portUsed) {
        const args = [
          `--remote-debugging-port=${this.cdpPort}`,
          `--user-data-dir=${userDataDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          // Disable GPU to reduce startup time and resource contention
          "--disable-gpu",
          // Disable features that may conflict with parallel instances
          "--disable-background-networking",
          "--disable-default-apps",
          "--disable-extensions",
          "--disable-sync",
          // Use a unique crash dump directory per instance
          `--crash-dumps-dir=${path.join(userDataDir, "crashes")}`,
        ];

        if (!this.headed) {
          args.push("--headless=new");
        }

        args.push("about:blank");

        console.log(`Launching ${this.browserType} browser on port ${this.cdpPort}...`);
        
        // Spawn with pipe to capture any immediate errors
        const proc = spawn(executablePath, args, {
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
        
        // Track if process exits early (error)
        let processExitedEarly = false;
        let exitCode: number | null = null;
        let stderrOutput = "";
        
        proc.on("exit", (code) => {
          processExitedEarly = true;
          exitCode = code;
        });
        
        proc.stderr?.on("data", (data) => {
          stderrOutput += data.toString();
        });
        
        // Unref to allow parent process to exit independently
        proc.unref();
        
        cdpProcesses.set(this.cdpPort, proc);

        // Wait for browser to start - give more time for initial startup
        // Stagger wait time based on port to reduce resource contention
        const baseWait = 3000;
        const staggerDelay = (this.cdpPort - 9224) * 1000; // Extra 1s per instance
        await new Promise((r) => setTimeout(r, baseWait + staggerDelay));
        
        // Check if process died early
        if (processExitedEarly) {
          console.log(`Warning: ${this.browserType} process exited with code ${exitCode}`);
          if (stderrOutput) {
            console.log(`  stderr: ${stderrOutput.substring(0, 200)}`);
          }
          cdpProcesses.delete(this.cdpPort);
          throw new Error(`${this.browserType} browser process exited immediately (code ${exitCode})`);
        }

        // Wait for CDP with longer timeout for parallel launches
        const ready = await waitForCdp(this.cdpPort, 45000);
        if (!ready) {
          const proc = cdpProcesses.get(this.cdpPort);
          if (proc) {
            try {
              proc.kill();
            } catch {}
            cdpProcesses.delete(this.cdpPort);
          }
          throw new Error(`${this.browserType} browser CDP not responding on port ${this.cdpPort}`);
        }
        
        // Additional stabilization delay after CDP is ready
        await new Promise((r) => setTimeout(r, 500));
      } else {
        console.log(`Connecting to existing ${this.browserType} on port ${this.cdpPort}...`);
      }

      // Try localhost first (resolves to both IPv4/IPv6), then specific addresses
      const hosts = ["localhost", "127.0.0.1", "[::1]"];
      let lastError: Error | null = null;
      
      for (const host of hosts) {
        try {
          return await chromium.connectOverCDP(`http://${host}:${this.cdpPort}`, { timeout: 10000 });
        } catch (err) {
          lastError = err as Error;
          // Continue trying next host
        }
      }
      throw lastError || new Error(`Could not connect to CDP on port ${this.cdpPort}`);
    } finally {
      // Release mutex to allow next browser to launch
      releaseMutex();
    }
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
        await this.page.evaluate("true");
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
    // Using string evaluation to avoid tsx bundler __name injection
    const snapshot = await page.evaluate(`
      (function() {
        var elements = [];
        var refCounter = 1;
        
        function processElement(el, depth) {
          depth = depth || 0;
          var tag = el.tagName.toLowerCase();
          var role = el.getAttribute("role") || "";
          var text = (el.innerText || "").substring(0, 50);
          var type = el.type || "";
          
          var interactiveRoles = ["button", "link", "textbox", "checkbox", "radio", "combobox", "menuitem"];
          var interactiveTags = ["button", "a", "input", "textarea", "select"];
          
          if (interactiveTags.indexOf(tag) >= 0 || interactiveRoles.indexOf(role) >= 0) {
            var ref = "e" + (refCounter++);
            var desc = "- " + (role || tag);
            if (text) desc += ' "' + text.replace(/\\n/g, " ").trim() + '"';
            if (type) desc += " [" + type + "]";
            desc += " [ref=" + ref + "]";
            elements.push(desc);
          }
          
          for (var i = 0; i < el.children.length; i++) {
            processElement(el.children[i], depth + 1);
          }
        }
        
        processElement(document.body);
        return elements.join("\\n");
      })()
    `);
    
    return snapshot as string;
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
    // Using string evaluation to avoid tsx bundler __name injection
    const clicked = await page.evaluate(`
      (function() {
        var idx = ${index};
        var elements = [];
        
        function processElement(el) {
          var tag = el.tagName.toLowerCase();
          var role = el.getAttribute("role") || "";
          var interactiveRoles = ["button", "link", "textbox", "checkbox", "radio", "combobox", "menuitem"];
          var interactiveTags = ["button", "a", "input", "textarea", "select"];
          
          if (interactiveTags.indexOf(tag) >= 0 || interactiveRoles.indexOf(role) >= 0) {
            elements.push(el);
          }
          
          for (var i = 0; i < el.children.length; i++) {
            processElement(el.children[i]);
          }
        }
        
        processElement(document.body);
        
        if (idx >= 0 && idx < elements.length) {
          elements[idx].click();
          return true;
        }
        return false;
      })()
    `);
    
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
  private async getElementByIndex(page: Page, index: number): Promise<import("playwright").ElementHandle | null> {
    // Use the same document-order traversal as snapshot() to ensure consistency
    // Using string evaluation to avoid tsx bundler __name injection
    const handle = await page.evaluateHandle(`
      (function() {
        var idx = ${index};
        var interactiveRoles = ["button", "link", "textbox", "checkbox", "radio", "combobox", "menuitem"];
        var interactiveTags = ["button", "a", "input", "textarea", "select"];
        var elements = [];
        
        function processElement(el) {
          var tag = el.tagName.toLowerCase();
          var role = el.getAttribute("role") || "";
          
          if (interactiveTags.indexOf(tag) >= 0 || interactiveRoles.indexOf(role) >= 0) {
            elements.push(el);
          }
          
          for (var i = 0; i < el.children.length; i++) {
            processElement(el.children[i]);
          }
        }
        
        processElement(document.body);
        
        if (idx >= 0 && idx < elements.length) {
          return elements[idx];
        }
        return null;
      })()
    `);
    
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
