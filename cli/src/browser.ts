/**
 * Grokipedia Browser Manager
 * Handles browser lifecycle with support for multiple browser types
 */

import { chromium, firefox, webkit, Browser, BrowserContext, Page } from "playwright";
import { spawn, ChildProcess } from "child_process";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as net from "net";

export type BrowserType = "chromium" | "firefox" | "webkit" | "comet" | "chrome" | "edge";

export interface BrowserOptions {
  type?: BrowserType;
  headless?: boolean;
  userDataDir?: string;
  cdpPort?: number;
}

export interface BrowserManager {
  page: Page;
  context: BrowserContext;
  browser: Browser | null;
  browserType: BrowserType;
  stop: () => Promise<void>;
  /** Create additional pages for parallel workers */
  createPage: () => Promise<Page>;
}

const DEFAULT_USER_DATA_DIR = path.join(os.homedir(), ".grokipedia_session");

// Browser executable paths for macOS
const BROWSER_PATHS: Record<string, string> = {
  comet: "/Applications/Comet.app/Contents/MacOS/Comet",
  chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  edge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
};

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

let cdpProcess: ChildProcess | null = null;

/**
 * Start a CDP-based browser (Chrome, Edge, Comet, etc.)
 */
async function startCdpBrowser(
  browserType: BrowserType,
  headless: boolean,
  userDataDir: string,
  cdpPort: number
): Promise<BrowserManager | null> {
  const executablePath = BROWSER_PATHS[browserType];
  
  if (!executablePath || !fs.existsSync(executablePath)) {
    return null;
  }

  // Check if CDP port is already in use
  const portUsed = await portInUse(cdpPort);

  if (!portUsed) {
    const args = [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
    ];

    if (headless) {
      args.push("--headless=new");
    }

    args.push("about:blank");

    console.log(`Launching ${browserType} browser...`);
    cdpProcess = spawn(executablePath, args, {
      stdio: "ignore",
      detached: true,
    });

    await new Promise((r) => setTimeout(r, 2000));

    const ready = await waitForCdp(cdpPort, 25000);
    if (!ready) {
      console.log(`${browserType} browser CDP not responding`);
      if (cdpProcess) {
        try {
          cdpProcess.kill();
        } catch {}
      }
      return null;
    }
  } else {
    console.log(`Connecting to existing browser on port ${cdpPort}...`);
  }

  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = await context.newPage();

    return {
      page,
      context,
      browser,
      browserType,
      stop: async () => {
        try {
          await page.close();
        } catch {}
        try {
          await browser.close();
        } catch {}
      },
      createPage: async () => {
        return await context.newPage();
      },
    };
  } catch (error) {
    console.log(`Failed to connect to ${browserType}: ${error}`);
    return null;
  }
}

/**
 * Start a Playwright-managed browser
 */
async function startPlaywrightBrowser(
  browserType: BrowserType,
  headless: boolean,
  userDataDir: string
): Promise<BrowserManager> {
  console.log(`Starting Playwright ${browserType} browser...`);
  
  const launcher = browserType === "firefox" ? firefox : 
                   browserType === "webkit" ? webkit : 
                   chromium;
  
  // Use regular browser launch for better multi-page support
  const browser = await launcher.launch({
    headless,
  });
  
  // Create a context with saved state if it exists
  const storageStatePath = path.join(userDataDir, "storage-state.json");
  let context: BrowserContext;
  
  if (fs.existsSync(storageStatePath)) {
    try {
      context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        storageState: storageStatePath,
      });
    } catch {
      context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
      });
    }
  } else {
    // Ensure directory exists
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
  }
  
  const page = await context.newPage();

  return {
    page,
    context,
    browser,
    browserType,
    stop: async () => {
      // Save storage state before closing
      try {
        if (!fs.existsSync(userDataDir)) {
          fs.mkdirSync(userDataDir, { recursive: true });
        }
        await context.storageState({ path: storageStatePath });
      } catch {}
      try {
        await context.close();
      } catch {}
      try {
        await browser.close();
      } catch {}
    },
    createPage: async () => {
      return await context.newPage();
    },
  };
}

/**
 * Start a browser with the specified options.
 * Tries CDP-based browsers first if specified, then falls back to Playwright.
 */
export async function startBrowser(options: BrowserOptions = {}): Promise<BrowserManager> {
  const {
    type = "chromium",
    headless = true,
    userDataDir = DEFAULT_USER_DATA_DIR,
    cdpPort = 9224,
  } = options;

  // CDP-based browsers (use existing profile/session)
  if (type === "comet" || type === "chrome" || type === "edge") {
    const browserUserDir = type === "comet" 
      ? path.join(os.homedir(), "Library/Application Support/Comet")
      : type === "chrome"
      ? path.join(os.homedir(), "Library/Application Support/Google/Chrome")
      : path.join(os.homedir(), "Library/Application Support/Microsoft Edge");
    
    const manager = await startCdpBrowser(type, headless, browserUserDir, cdpPort);
    if (manager) {
      return manager;
    }
    console.log(`Falling back to Playwright Chromium...`);
  }

  // Playwright-managed browsers
  return startPlaywrightBrowser(
    type === "comet" || type === "chrome" || type === "edge" ? "chromium" : type,
    headless,
    userDataDir
  );
}

export async function stopBrowser(manager: BrowserManager): Promise<void> {
  await manager.stop();
}

/**
 * Get available browser types based on what's installed
 */
export function getAvailableBrowsers(): BrowserType[] {
  const available: BrowserType[] = ["chromium", "firefox", "webkit"];
  
  for (const [name, execPath] of Object.entries(BROWSER_PATHS)) {
    if (fs.existsSync(execPath)) {
      available.push(name as BrowserType);
    }
  }
  
  return available;
}
