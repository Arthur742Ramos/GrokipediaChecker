/**
 * Playwright CLI-like Wrapper
 * Provides a playwright-cli compatible interface using Playwright API directly
 * Supports both bundled Chromium and CDP connection to Comet/Chrome/Edge
 */

import { chromium, Browser, BrowserContext, Page } from "playwright";
import { spawn, ChildProcess, execSync } from "child_process";
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
 * Check if a browser profile is locked (another instance is using it)
 */
function isProfileLocked(profileDir: string): boolean {
  const lockFile = path.join(profileDir, "SingletonLock");
  try {
    // On macOS, SingletonLock is a symlink to the process that holds the lock
    const stat = fs.lstatSync(lockFile);
    if (stat.isSymbolicLink()) {
      // Check if the process is still running
      try {
        const target = fs.readlinkSync(lockFile);
        // Target format is like "hostname-pid" or just a process identifier
        const pidMatch = target.match(/-(\d+)$/);
        if (pidMatch) {
          const pid = parseInt(pidMatch[1]);
          try {
            process.kill(pid, 0); // Check if process exists
            return true; // Process is running, profile is locked
          } catch {
            // Process not running, stale lock
            return false;
          }
        }
      } catch {
        // Can't read symlink, assume locked
        return true;
      }
    }
    return true; // Lock file exists
  } catch {
    return false; // No lock file
  }
}

/**
 * Check if a browser process is running by name (excludes zombie processes)
 */
function isBrowserRunning(browserType: BrowserType): boolean {
  try {
    const processName = browserType === "comet" ? "Comet" : 
                        browserType === "chrome" ? "Google Chrome" : 
                        "Microsoft Edge";
    // Use ps to get process state and filter out zombies (state Z or UE)
    // ps output: PID STATE COMMAND
    const result = execSync(
      `ps -eo pid,state,comm | grep -E "^\\s*[0-9]+\\s+[^Z].*${processName}$" | grep -v grep`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    // Filter out zombie states (Z, UE, etc.)
    const lines = result.trim().split('\n').filter(line => {
      const state = line.trim().split(/\s+/)[1] || '';
      // Exclude zombie (Z) and uninterruptible exit (UE) states
      return !state.includes('Z') && !state.includes('UE');
    });
    return lines.length > 0;
  } catch {
    return false;
  }
}

/**
 * Try to find an existing CDP endpoint for a running browser
 */
async function findExistingCdpEndpoint(startPort: number = 9222, endPort: number = 9230): Promise<number | null> {
  for (let port = startPort; port <= endPort; port++) {
    try {
      const response = await new Promise<string | null>((resolve) => {
        const req = http.request({
          hostname: "127.0.0.1",
          port,
          path: "/json/version",
          method: "GET",
          timeout: 1000,
        }, (res) => {
          let data = "";
          res.on("data", chunk => data += chunk);
          res.on("end", () => resolve(data));
        });
        req.on("error", () => resolve(null));
        req.on("timeout", () => { req.destroy(); resolve(null); });
        req.end();
      });
      
      if (response) {
        try {
          JSON.parse(response);
          return port;
        } catch {}
      }
    } catch {}
  }
  return null;
}

// Shared browser connection pool for tab multiplexing
// Key: browserType (comet, chrome, edge), Value: shared Browser connection
interface SharedBrowserConnection {
  browser: Browser;
  context: BrowserContext;
  port: number;
  refCount: number;
}
const sharedBrowserConnections: Map<string, SharedBrowserConnection> = new Map();
let sharedBrowserMutex: Promise<void> = Promise.resolve();

/**
 * Acquire the shared browser mutex to serialize browser connection setup
 */
function acquireSharedBrowserMutex(): Promise<() => void> {
  let release: () => void;
  const previousMutex = sharedBrowserMutex;
  sharedBrowserMutex = new Promise((resolve) => {
    release = resolve;
  });
  return previousMutex.then(() => release!);
}

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

/**
 * Copy cookies from existing browser contexts to a new context.
 * This is necessary when connecting via CDP to an existing browser - 
 * new contexts don't automatically inherit cookies from existing tabs.
 * 
 * Uses CDP's Network.getAllCookies to get all cookies at the browser level,
 * then uses Network.setCookie to set them in the browser's cookie jar
 * (not just Playwright's context).
 */
async function copyCookiesFromBrowser(browser: Browser, targetContext: BrowserContext): Promise<void> {
  let cdpSessionForSetting: any = null;
  try {
    // Get cookies from all existing contexts
    const allCookies: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      expires: number;
      httpOnly: boolean;
      secure: boolean;
      sameSite: "Strict" | "Lax" | "None";
    }> = [];
    
    // First, try to get cookies from the default context's pages via CDP
    // This gets cookies at the browser level, including session cookies
    const contexts = browser.contexts();
    cdpSessionForSetting = null;
    
    for (const ctx of contexts) {
      if (ctx === targetContext) continue; // Skip target context
      
      const pages = ctx.pages();
      if (pages.length > 0) {
        // Use CDP session to get ALL cookies (including httpOnly)
        try {
          const cdpSession = await pages[0].context().newCDPSession(pages[0]);
          const { cookies } = await cdpSession.send("Network.getAllCookies") as { 
            cookies: Array<{
              name: string;
              value: string;
              domain: string;
              path: string;
              expires: number;
              httpOnly: boolean;
              secure: boolean;
              sameSite: string;
            }>;
          };
          
          for (const cookie of cookies) {
            // Filter for Grokipedia and auth cookies (x.ai is the auth provider)
            if (cookie.domain.includes("grokipedia") || cookie.domain.includes("wikipedia") ||
                cookie.domain.includes("x.ai") || cookie.domain.includes("xai")) {
              allCookies.push({
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path || "/",
                expires: cookie.expires || -1,
                httpOnly: cookie.httpOnly || false,
                secure: cookie.secure || false,
                sameSite: (cookie.sameSite as "Strict" | "Lax" | "None") || "Lax",
              });
            }
          }
          
          cdpSessionForSetting = cdpSession;
          break; // Got cookies from one page, that's enough
        } catch (cdpErr) {
          // CDP session failed, try context.cookies() as fallback
          try {
            const ctxCookies = await ctx.cookies();
            for (const cookie of ctxCookies) {
              if (cookie.domain.includes("grokipedia") || cookie.domain.includes("wikipedia") ||
                  cookie.domain.includes("x.ai") || cookie.domain.includes("xai")) {
                allCookies.push({
                  name: cookie.name,
                  value: cookie.value,
                  domain: cookie.domain,
                  path: cookie.path,
                  expires: cookie.expires,
                  httpOnly: cookie.httpOnly,
                  secure: cookie.secure,
                  sameSite: cookie.sameSite,
                });
              }
            }
          } catch {}
        }
      }
    }
    
    if (allCookies.length > 0) {
      console.log(`Copying ${allCookies.length} session cookies to new context...`);
      
      // Log cookie domains for debugging
      const domains = [...new Set(allCookies.map(c => c.domain))];
      console.log(`Cookie domains: ${domains.join(", ")}`);
      
      // First, try to set cookies via CDP Network.setCookie (writes to browser's cookie jar)
      if (cdpSessionForSetting) {
        for (const cookie of allCookies) {
          try {
            await cdpSessionForSetting.send("Network.setCookie", {
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path || "/",
              expires: cookie.expires > 0 ? cookie.expires : undefined,
              httpOnly: cookie.httpOnly || false,
              secure: cookie.secure || false,
              sameSite: cookie.sameSite || "Lax",
            });
          } catch {
            // Individual cookie set might fail, continue
          }
        }
      }
      
      // Also add to Playwright context
      await targetContext.addCookies(allCookies);
    } else {
      console.log("No existing Grokipedia session cookies found in browser");
    }
  } catch (err) {
    console.log(`Warning: Could not copy cookies: ${err}`);
  } finally {
    if (cdpSessionForSetting) {
      try {
        await cdpSessionForSetting.detach();
      } catch {}
    }
  }
}

/**
 * Copy cookies from browser to context using CDP directly on the browser.
 * This method creates a new page temporarily to access CDP.
 */
async function copyCookiesViaCDP(browser: Browser, targetContext: BrowserContext): Promise<void> {
  let tempPage: Page | null = null;
  
  try {
    // Create a temporary page in the default context to access CDP
    const defaultContext = browser.contexts()[0];
    if (!defaultContext || defaultContext === targetContext) {
      // No other context to get cookies from, try creating temp page in target
      tempPage = await targetContext.newPage();
      const cdpSession = await tempPage.context().newCDPSession(tempPage);
      
      // Get all cookies via CDP
      const { cookies } = await cdpSession.send("Storage.getCookies") as { 
        cookies: Array<{
          name: string;
          value: string;
          domain: string;
          path: string;
          expires: number;
          httpOnly: boolean;
          secure: boolean;
          sameSite: string;
        }>;
      };
      
      await cdpSession.detach();
      await tempPage.close();
      tempPage = null;
      
      // Filter and add Grokipedia and auth cookies (x.ai is the auth provider)
      const grokCookies = cookies.filter(c => 
        c.domain.includes("grokipedia") || c.domain.includes("wikipedia") ||
        c.domain.includes("x.ai") || c.domain.includes("xai")
      ).map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        expires: c.expires || -1,
        httpOnly: c.httpOnly || false,
        secure: c.secure || false,
        sameSite: (c.sameSite as "Strict" | "Lax" | "None") || "Lax",
      }));
      
      if (grokCookies.length > 0) {
        console.log(`Copying ${grokCookies.length} session cookies via CDP...`);
        await targetContext.addCookies(grokCookies);
      }
      return;
    }
    
    // Use existing page from default context
    const existingPages = defaultContext.pages();
    if (existingPages.length > 0) {
      const cdpSession = await existingPages[0].context().newCDPSession(existingPages[0]);
      
      const { cookies } = await cdpSession.send("Network.getAllCookies") as { 
        cookies: Array<{
          name: string;
          value: string;
          domain: string;
          path: string;
          expires: number;
          httpOnly: boolean;
          secure: boolean;
          sameSite: string;
        }>;
      };
      
      await cdpSession.detach();
      
      // Filter for Grokipedia and auth cookies (x.ai is the auth provider)
      const grokCookies = cookies.filter(c => 
        c.domain.includes("grokipedia") || c.domain.includes("wikipedia") ||
        c.domain.includes("x.ai") || c.domain.includes("xai")
      ).map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        expires: c.expires || -1,
        httpOnly: c.httpOnly || false,
        secure: c.secure || false,
        sameSite: (c.sameSite as "Strict" | "Lax" | "None") || "Lax",
      }));
      
      if (grokCookies.length > 0) {
        console.log(`Copying ${grokCookies.length} session cookies via CDP...`);
        await targetContext.addCookies(grokCookies);
      }
    }
  } catch (err) {
    console.log(`Warning: Could not copy cookies via CDP: ${err}`);
  } finally {
    if (tempPage) {
      try { await tempPage.close(); } catch {}
    }
  }
}

/**
 * Get or create a shared browser connection for tab multiplexing
 * This allows multiple workers to share ONE browser instance with multiple tabs
 * 
 * SMART PROFILE HANDLING:
 * 1. If CDP already available on port 9224, connect to it
 * 2. If browser is running with profile lock, try other CDP ports or use temp profile
 * 3. If profile is free, launch browser with original profile
 */
async function getSharedBrowserConnection(
  browserType: BrowserType,
  headed: boolean
): Promise<SharedBrowserConnection> {
  const releaseMutex = await acquireSharedBrowserMutex();
  
  try {
    // Check if we already have a connection for this browser type
    const existing = sharedBrowserConnections.get(browserType);
    if (existing && existing.browser.isConnected()) {
      existing.refCount++;
      console.log(`Reusing shared ${browserType} browser connection (${existing.refCount} tabs)`);
      return existing;
    }
    
    // Need to launch a new shared browser
    const executablePath = BROWSER_PATHS[browserType];
    if (!executablePath || !fs.existsSync(executablePath)) {
      throw new Error(`Browser ${browserType} not found at ${executablePath}`);
    }
    
    // Use fixed port 9224 for the shared browser
    const port = 9224;
    
    // Get original profile directory for auth
    const originalProfileDir = browserType === "comet" 
      ? path.join(os.homedir(), "Library/Application Support/Comet")
      : browserType === "chrome"
      ? path.join(os.homedir(), "Library/Application Support/Google/Chrome")
      : path.join(os.homedir(), "Library/Application Support/Microsoft Edge");
    
    // Check if CDP port is already in use (browser might already be running)
    const portUsed = await portInUse(port);
    
    if (!portUsed) {
      // Check if profile is locked by another browser instance
      const profileLocked = isProfileLocked(originalProfileDir);
      const browserRunning = isBrowserRunning(browserType);
      
      if (profileLocked || browserRunning) {
        console.log(`${browserType} profile is locked (browser running: ${browserRunning})`);
        
        // Strategy 1: Try to find an existing CDP endpoint on other ports
        console.log("Searching for existing CDP endpoints...");
        const existingPort = await findExistingCdpEndpoint(9222, 9230);
        if (existingPort) {
          console.log(`Found existing CDP on port ${existingPort}, connecting...`);
          const browser = await chromium.connectOverCDP(`http://127.0.0.1:${existingPort}`, { timeout: 10000 });
          
          // Get the default context (where user's logged-in tabs live) or create new one
          const existingContext = browser.contexts()[0];
          let context: BrowserContext;
          
          if (existingContext) {
            // Use the existing context - this shares cookies with user's tabs
            context = existingContext;
            console.log(`Using existing browser context with ${existingContext.pages().length} tabs`);
            // Still need to sync cookies - Playwright context may not have all browser cookies
            await copyCookiesFromBrowser(browser, context);
          } else {
            // Need to create a new context - copy cookies from browser
            context = await browser.newContext();
            console.log("Created new context, will copy session cookies...");
            await copyCookiesFromBrowser(browser, context);
          }
          
          const connection: SharedBrowserConnection = {
            browser,
            context,
            port: existingPort,
            refCount: 1,
          };
          
          sharedBrowserConnections.set(browserType, connection);
          console.log(`Connected to existing ${browserType} browser on port ${existingPort}`);
          return connection;
        }
        
        // Browser is running without CDP - automatically restart it with CDP enabled
        // This is the only way to access the encrypted cookies on macOS
        const browserName = browserType.charAt(0).toUpperCase() + browserType.slice(1);
        console.log(`${browserName} is running without remote debugging. Restarting with CDP enabled...`);
        
        // Kill the existing browser process - try graceful first, then force
        const processName = browserType === "comet" ? "Comet" : 
                            browserType === "chrome" ? "Google Chrome" : 
                            "Microsoft Edge";
        
        // First try graceful termination (SIGTERM)
        try {
          execSync(`pkill -x "${processName}"`, { stdio: "ignore" });
          console.log(`Sent termination signal to ${browserName}...`);
        } catch {
          // pkill returns non-zero if no process found, which is fine
        }
        
        // Wait for the browser to fully terminate and release the profile lock
        let lockReleased = false;
        const maxWait = 5000; // 5 seconds for graceful shutdown
        const startTime = Date.now();
        
        while (!lockReleased && Date.now() - startTime < maxWait) {
          await new Promise(r => setTimeout(r, 500));
          // Check if profile is still locked
          if (!isProfileLocked(originalProfileDir) && !isBrowserRunning(browserType)) {
            lockReleased = true;
          }
        }
        
        // If still running, use SIGKILL (force kill)
        if (!lockReleased) {
          console.log(`${browserName} didn't terminate gracefully, using force kill...`);
          try {
            execSync(`pkill -9 -x "${processName}"`, { stdio: "ignore" });
          } catch {
            // Ignore errors
          }
          
          // Wait another 3 seconds for forced termination
          const forceStart = Date.now();
          while (!lockReleased && Date.now() - forceStart < 3000) {
            await new Promise(r => setTimeout(r, 500));
            if (!isProfileLocked(originalProfileDir) && !isBrowserRunning(browserType)) {
              lockReleased = true;
            }
          }
        }
        
        if (!lockReleased) {
          // Still can't kill it - throw an error
          throw new Error(
            `Could not terminate ${browserName}. Please close it manually and try again.\n` +
            `If that doesn't work, try: kill -9 $(pgrep -x "${processName}")`
          );
        }
        
        console.log(`${browserName} terminated. Restarting with CDP...`);
        
        // Small delay to ensure filesystem is ready
        await new Promise(r => setTimeout(r, 500));
      }
      
      // Profile is now free (either was already free, or we just freed it), launch with CDP
      const args = [
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${originalProfileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-gpu",
          "--disable-background-networking",
          "--disable-default-apps",
          "--disable-extensions",
          "--disable-sync",
          `--crash-dumps-dir=${path.join(originalProfileDir, "crashes")}`,
        ];
        
        if (!headed) {
          args.push("--headless=new");
        }
        
        args.push("about:blank");
        
        console.log(`Launching shared ${browserType} browser on port ${port}...`);
        
        const proc = spawn(executablePath, args, {
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
        
        let processExitedEarly = false;
        let exitCode: number | null = null;
        let stderrOutput = "";
        
        proc.on("exit", (code) => {
          processExitedEarly = true;
          exitCode = code;
          // Clean up shared connection on exit
          sharedBrowserConnections.delete(browserType);
        });
        
        proc.stderr?.on("data", (data) => {
          stderrOutput += data.toString();
        });
        
        proc.unref();
        cdpProcesses.set(port, proc);
        
        // Wait for browser to start
        await new Promise((r) => setTimeout(r, 3000));
        
        if (processExitedEarly) {
          console.log(`Warning: ${browserType} process exited with code ${exitCode}`);
          if (stderrOutput) {
            console.log(`  stderr: ${stderrOutput.substring(0, 200)}`);
          }
          cdpProcesses.delete(port);
          throw new Error(`${browserType} browser process exited immediately (code ${exitCode})`);
        }
        
        // Wait for CDP with longer timeout
        const ready = await waitForCdp(port, 45000);
        if (!ready) {
          const proc = cdpProcesses.get(port);
          if (proc) {
            try { proc.kill(); } catch {}
            cdpProcesses.delete(port);
          }
          throw new Error(`${browserType} browser CDP not responding on port ${port}`);
        }
        
        await new Promise((r) => setTimeout(r, 500));
    } else {
      console.log(`Connecting to existing ${browserType} browser on port ${port}...`);
    }
    
    // Connect to the browser via CDP
    const hosts = ["localhost", "127.0.0.1", "[::1]"];
    let browser: Browser | null = null;
    let lastError: Error | null = null;
    
    for (const host of hosts) {
      try {
        browser = await chromium.connectOverCDP(`http://${host}:${port}`, { timeout: 10000 });
        break;
      } catch (err) {
        lastError = err as Error;
      }
    }
    
    if (!browser) {
      throw lastError || new Error(`Could not connect to CDP on port ${port}`);
    }
    
    // Get the default context (where user's logged-in tabs live)
    // IMPORTANT: For CDP connections, we MUST use the existing context to share cookies.
    // Creating a new context with browser.newContext() creates an ISOLATED context
    // that doesn't have access to the browser's cookie jar.
    const existingContext = browser.contexts()[0];
    let context: BrowserContext;
    
    if (existingContext) {
      // Use the existing context - this shares cookies with user's tabs
      context = existingContext;
      const playwrightPageCount = existingContext.pages().length;
      console.log(`Using existing browser context (Playwright sees ${playwrightPageCount} tabs)`);
      
      // Log existing page URLs for debugging
      const pageUrls = existingContext.pages().map(p => {
        try { return p.url(); } catch { return "<closed>"; }
      });
      if (pageUrls.length > 0) {
        console.log(`Playwright-visible tabs: ${pageUrls.join(", ")}`);
      }
      
      // Use CDP Target API to see the real tab count (Playwright misses existing tabs)
      try {
        const cdpSession = await browser.newBrowserCDPSession();
        const { targetInfos } = await cdpSession.send("Target.getTargets") as { 
          targetInfos: Array<{ type: string; url: string }> 
        };
        const pageTargets = targetInfos.filter(t => t.type === "page");
        console.log(`CDP Target API sees ${pageTargets.length} actual browser tabs`);
      } catch {
        // CDP session might not be available in all cases
      }
      
      // Still sync cookies via CDP to ensure browser's cookie jar is accessible
      await copyCookiesFromBrowser(browser, context);
    } else {
      // No existing context - this means the browser was just launched
      // For CDP connections, we CANNOT use browser.newContext() as it creates
      // an isolated context. Instead, we need to create a page first to establish
      // a default context, then use that.
      console.log("No existing context found, creating default page to establish context...");
      
      // Create a page directly on the browser - this establishes a default context
      // Note: For CDP connections, browser.newContext() creates isolated contexts,
      // but pages created via context will share the browser's cookie jar
      context = await browser.newContext();
      console.log("Created new context, syncing session cookies...");
      await copyCookiesFromBrowser(browser, context);
    }
    
    const connection: SharedBrowserConnection = {
      browser,
      context,
      port,
      refCount: 1,
    };
    
    sharedBrowserConnections.set(browserType, connection);
    console.log(`Created shared ${browserType} browser connection`);
    
    return connection;
  } finally {
    releaseMutex();
  }
}

/**
 * Release a reference to a shared browser connection
 */
async function releaseSharedBrowserConnection(browserType: BrowserType): Promise<void> {
  const releaseMutex = await acquireSharedBrowserMutex();
  
  try {
    const connection = sharedBrowserConnections.get(browserType);
    if (connection) {
      connection.refCount--;
      console.log(`Released shared ${browserType} browser connection (${connection.refCount} remaining)`);
      
      // Don't close the browser even when refCount hits 0
      // Let it stay open for the duration of the session
      // It will be cleaned up when the process exits
    }
  } finally {
    releaseMutex();
  }
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
 * 
 * For CDP browsers (Comet, Chrome, Edge), uses tab multiplexing:
 * - All sessions share ONE browser instance
 * - Each session gets its own tab (page) in the shared browser
 * - This avoids SingletonLock conflicts and shares auth
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
  private useSharedConnection: boolean = false; // Track if using shared connection

  constructor(sessionName: string, options: Omit<PlaywrightCLIOptions, "session"> = {}) {
    this.sessionName = sessionName;
    this.headed = options.headed || false;
    this.sessionDir = path.join(SESSIONS_DIR, sessionName);
    this.browserType = options.browserType || "chromium";
    // For shared connections, we use port 9224
    // Only assign unique port if not using shared connection (legacy fallback)
    this.cdpPort = options.cdpPort || 9224;
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
      
      // Use original profile directly to preserve encrypted cookies/auth
      // macOS encrypts cookies with Keychain - copying files doesn't preserve auth
      const userDataDir = originalProfileDir;

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
   * Find an existing page in the browser that's on a grokipedia domain.
   * This is useful for CDP connections where we want to reuse a logged-in tab.
   * 
   * Uses CDP Target API directly because browser.contexts()[0].pages() doesn't
   * see existing tabs when connecting to a browser via CDP - it only returns
   * pages that Playwright created itself.
   */
  private async findExistingGrokipediaPage(): Promise<Page | null> {
    if (!this.browser) return null;
    
    // First try the standard Playwright API (works for Playwright-created pages)
    const contexts = this.browser.contexts();
    for (const ctx of contexts) {
      const pages = ctx.pages();
      for (const page of pages) {
        try {
          const url = page.url();
          if (url.includes("grokipedia.com") || url.includes("grokipedia")) {
            console.log(`Found existing grokipedia page via Playwright API: ${url}`);
            return page;
          }
        } catch {
          // Page might be closed or inaccessible
        }
      }
    }
    
    // For CDP connections, use Target API to find existing tabs that Playwright doesn't see
    if (this.useCdp) {
      try {
        const page = await this.findGrokipediaPageViaCDP();
        if (page) {
          return page;
        }
      } catch (err) {
        console.log(`CDP target search failed: ${err}`);
      }
    }
    
    return null;
  }

  /**
   * Use CDP Target API to find and attach to existing grokipedia tabs.
   * This is necessary because browser.contexts()[0].pages() only returns
   * pages that Playwright created, not pre-existing browser tabs.
   */
  private async findGrokipediaPageViaCDP(): Promise<Page | null> {
    if (!this.browser) return null;
    
    let cdpSession: any = null;
    try {
      // Create a browser-level CDP session to access Target domain
      cdpSession = await this.browser.newBrowserCDPSession();
      
      // Get all targets (pages, workers, etc.) from the browser
      const { targetInfos } = await cdpSession.send("Target.getTargets") as { 
        targetInfos: Array<{
          targetId: string;
          type: string;
          title: string;
          url: string;
          attached: boolean;
          browserContextId?: string;
        }> 
      };
      
      console.log(`CDP found ${targetInfos.length} total targets`);
      
      // Find page targets with grokipedia URLs
      const grokipediaTargets = targetInfos.filter(target => 
        target.type === "page" && 
        (target.url.includes("grokipedia.com") || target.url.includes("grokipedia"))
      );
      
      if (grokipediaTargets.length === 0) {
        console.log("No grokipedia targets found via CDP");
        // Log what we did find for debugging
        const pageTargets = targetInfos.filter(t => t.type === "page");
        if (pageTargets.length > 0) {
          console.log(`Found ${pageTargets.length} page targets: ${pageTargets.map(t => t.url).slice(0, 5).join(", ")}${pageTargets.length > 5 ? "..." : ""}`);
        }
        return null;
      }
      
      console.log(`Found ${grokipediaTargets.length} grokipedia target(s) via CDP`);
      const target = grokipediaTargets[0];
      console.log(`Attaching to target: ${target.url} (${target.targetId})`);
      
      // Attach to the target to get a session
      const { sessionId } = await cdpSession.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true  // Required for modern CDP - creates a flat session hierarchy
      }) as { sessionId: string };
      
      console.log(`Attached to target with sessionId: ${sessionId}`);
      
      // Now we need to get a Playwright Page from this target.
      // The trick is that once we attach, the page should appear in contexts.
      // We can also create a new page in the same context to trigger discovery.
      
      // Try to find the page in existing contexts again after attaching
      const contexts = this.browser.contexts();
      for (const ctx of contexts) {
        const pages = ctx.pages();
        for (const page of pages) {
          try {
            const url = page.url();
            if (url.includes("grokipedia.com") || url.includes("grokipedia")) {
              console.log(`Found grokipedia page after CDP attach: ${url}`);
              return page;
            }
          } catch {
            // Page might be closed or inaccessible
          }
        }
      }
      
      // If the page still isn't visible via Playwright, we need a different approach.
      // We'll use the CDP session to navigate our own page there, copying the session.
      console.log("Target attached but page not visible to Playwright - will use new tab with synced cookies");
      
      // Detach from the target to clean up
      try {
        await cdpSession.send("Target.detachFromTarget", { sessionId });
      } catch {
        // Ignore detach errors
      }
      
      return null;
    } catch (err) {
      console.log(`CDP target discovery failed: ${err}`);
      return null;
    } finally {
      if (cdpSession) {
        try {
          await cdpSession.detach();
        } catch {}
      }
    }
  }

  /**
   * Ensure browser is launched and page is ready
   * For CDP browsers, uses tab multiplexing (shared browser, separate tabs)
   * 
   * IMPORTANT: For CDP connections, we try to reuse an existing page that's
   * already on grokipedia.com, as it will already have the session cookies.
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
      // Clean up old page (but NOT the shared browser connection)
      if (this.page) {
        try {
          await this.page.close();
        } catch {}
        this.page = null;
      }
      
      // For shared connections, don't close the browser
      if (!this.useSharedConnection && this.browser) {
        try {
          await this.browser.close();
        } catch {}
        this.browser = null;
        this.context = null;
      }
      
      if (this.useCdp) {
        // Use shared browser connection for CDP browsers (tab multiplexing)
        // This ensures all workers share ONE browser instance with multiple tabs
        const connection = await getSharedBrowserConnection(this.browserType, this.headed);
        this.browser = connection.browser;
        this.context = connection.context;
        this.useSharedConnection = true;
        
        // Always create a new page (tab) in the shared context for isolation
        // This avoids multiple workers sharing the same tab and closing user tabs
        this.page = await this.context.newPage();

        // For CDP connections, ensure cookies from existing browser session are available
        // This handles the case where new pages don't automatically inherit all cookies
        await this.syncCookiesFromBrowser();
      } else {
        // Use Playwright's bundled Chromium with persistent context
        // On Linux, use the VNC-authenticated profile if available
        const linuxPersistentProfile = path.join(os.homedir(), ".config/chromium-persistent/chromium-vnc");
        const usePersistentProfile = process.platform === "linux" && fs.existsSync(linuxPersistentProfile);
        
        if (usePersistentProfile) {
          console.log(`Using persistent Chromium profile at ${linuxPersistentProfile}`);
          // Use launchPersistentContext to share cookies with the VNC session
          this.context = await chromium.launchPersistentContext(linuxPersistentProfile, {
            headless: !this.headed,
            viewport: { width: 1280, height: 800 },
            args: ["--no-sandbox", "--disable-gpu"],
          });
          // For persistent context, browser is accessed via context.browser()
          this.browser = this.context.browser()!;
          this.page = this.context.pages()[0] || await this.context.newPage();
        } else {
          // Fallback to regular launch with storage state
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
   * Sync cookies from the browser to the current page via CDP.
   * When connecting to an existing browser via CDP, new pages may not automatically
   * have access to all cookies from the browser's cookie jar. This method uses CDP
   * to SET cookies directly in the browser's native cookie store (not just Playwright's
   * context), ensuring they're available for navigations.
   * 
   * KEY INSIGHT: context.addCookies() only adds cookies to Playwright's isolated
   * context storage. To make cookies work for new pages, we need to use CDP's
   * Network.setCookie to add them to the browser's actual cookie jar.
   */
  private async syncCookiesFromBrowser(): Promise<void> {
    if (!this.page || !this.browser || !this.useCdp) {
      return;
    }

    let cdpSession: any = null;
    try {
      // Create a CDP session for this page
      cdpSession = await this.page.context().newCDPSession(this.page);
      
      // Get all cookies at the browser level using CDP
      const { cookies } = await cdpSession.send("Network.getAllCookies") as { 
        cookies: Array<{
          name: string;
          value: string;
          domain: string;
          path: string;
          expires: number;
          size: number;
          httpOnly: boolean;
          secure: boolean;
          session: boolean;
          sameSite?: string;
          priority?: string;
          sameParty?: boolean;
          sourceScheme?: string;
          sourcePort?: number;
        }>;
      };
      
      // Filter for Grokipedia-related cookies
      const relevantCookies = cookies.filter(c => 
        c.domain.includes("grokipedia") || 
        c.domain.includes("wikipedia") ||
        c.domain.includes("x.ai") ||
        c.domain.includes("xai")
      );
      
      if (relevantCookies.length > 0) {
        console.log(`Found ${relevantCookies.length} session cookies in browser`);
        
        // Log cookie domains for debugging
        const domains = [...new Set(relevantCookies.map(c => c.domain))];
        console.log(`Cookie domains: ${domains.join(", ")}`);
        
        // Use CDP's Network.setCookie to set cookies directly in the browser's cookie jar
        // This is more reliable than context.addCookies() for CDP connections
        for (const cookie of relevantCookies) {
          try {
            await cdpSession.send("Network.setCookie", {
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path || "/",
              expires: cookie.expires > 0 ? cookie.expires : undefined,
              httpOnly: cookie.httpOnly || false,
              secure: cookie.secure || false,
              sameSite: (cookie.sameSite as "Strict" | "Lax" | "None") || "Lax",
            });
          } catch (setCookieErr) {
            // Individual cookie set might fail, continue with others
          }
        }
        
        // Also add to Playwright context as backup
        const cookiesToAdd = relevantCookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || "/",
          expires: c.expires > 0 ? c.expires : undefined,
          httpOnly: c.httpOnly || false,
          secure: c.secure || false,
          sameSite: (c.sameSite as "Strict" | "Lax" | "None") || "Lax",
        }));
        
        try {
          await this.context!.addCookies(cookiesToAdd);
        } catch (addErr) {
          // Context might already have these cookies, ignore errors
        }
      } else {
        console.log("No Grokipedia session cookies found in browser - user may need to log in");
      }
      
    } catch (err) {
      // Non-fatal - just log and continue
      console.log(`Note: Could not sync cookies via CDP: ${err}`);
    } finally {
      if (cdpSession) {
        try {
          await cdpSession.detach();
        } catch {}
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
    
    // For CDP connections navigating to Grokipedia, ensure cookies are synced
    if (this.useCdp && (url.includes("grokipedia") || url.includes("wikipedia"))) {
      await this.syncCookiesFromBrowser();
    }
    
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
   * For shared connections (CDP browsers), only closes the page/tab, not the browser
   */
  async stop(): Promise<void> {
    await this.saveState();
    if (this.page) {
      try {
        await this.page.close();
      } catch {}
      this.page = null;
    }
    
    if (this.useSharedConnection) {
      // For shared connections, release the reference but don't close the browser
      await releaseSharedBrowserConnection(this.browserType);
      // Don't null out browser/context since other sessions may be using them
    } else if (this.browser) {
      try {
        await this.browser.close();
      } catch {}
      this.browser = null;
      this.context = null;
    }
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
 * Close all shared browser connections.
 * Call this at the end of the process to ensure browsers are properly closed.
 */
export async function closeAllSharedConnections(): Promise<void> {
  for (const [key, conn] of sharedBrowserConnections) {
    try {
      console.log(`Closing shared ${key} browser connection...`);
      await conn.browser.close();
    } catch {}
  }
  sharedBrowserConnections.clear();
  
  // Also kill any CDP processes we spawned
  for (const [port, proc] of cdpProcesses) {
    try {
      proc.kill();
    } catch {}
  }
  cdpProcesses.clear();
}

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
