/**
 * Grokipedia Browser Manager
 * Handles browser lifecycle using playwright-cli for persistent sessions
 */

import { PlaywrightCLISession, PlaywrightCLIManager, BrowserType as CLIBrowserType } from "./playwright-cli.js";
import * as fs from "fs";

export type BrowserType = "chromium" | "firefox" | "webkit" | "comet" | "chrome" | "edge";

export interface BrowserOptions {
  type?: BrowserType;
  headless?: boolean;
  userDataDir?: string;
  cdpPort?: number;
}

export interface BrowserManager {
  session: PlaywrightCLISession;
  browserType: BrowserType;
  headed: boolean;
  stop: () => Promise<void>;
  /** Create additional sessions for parallel workers */
  createSession: () => Promise<PlaywrightCLISession>;
}

// Session manager for this run
const sessionManager = new PlaywrightCLIManager();

// Browser executable paths for macOS
const BROWSER_PATHS: Record<string, string> = {
  comet: "/Applications/Comet.app/Contents/MacOS/Comet",
  chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  edge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
};

/**
 * Start a browser session.
 * For comet/chrome/edge: Uses CDP to connect to existing browser profile (preserves login)
 * For chromium: Uses Playwright's bundled browser with session storage
 */
export async function startBrowser(options: BrowserOptions = {}): Promise<BrowserManager> {
  const {
    type = "chromium",
    headless = true,
  } = options;

  const headed = !headless;
  
  // Map browser type to CLI browser type
  let cliBrowserType: CLIBrowserType = "chromium";
  if (type === "comet" || type === "chrome" || type === "edge") {
    cliBrowserType = type as CLIBrowserType;
  }

  console.log(`Starting browser session (${type}, headed=${headed})...`);
  
  // Configure the session manager
  sessionManager.setBrowserType(cliBrowserType);
  sessionManager.setHeaded(headed);
  
  // Create a session for this browser
  const session = sessionManager.createSession("grokipedia", headed);

  return {
    session,
    browserType: type,
    headed,
    stop: async () => {
      await session.stop();
    },
    createSession: async () => {
      return sessionManager.createSession("grokipedia-worker", headed);
    },
  };
}

export async function stopBrowser(manager: BrowserManager): Promise<void> {
  await manager.stop();
}

/**
 * Stop all browser sessions
 */
export async function stopAllBrowsers(): Promise<void> {
  await sessionManager.stopAll();
}

/**
 * Get available browser types based on what's installed
 */
export function getAvailableBrowsers(): BrowserType[] {
  const available: BrowserType[] = ["chromium"];
  
  for (const [name, execPath] of Object.entries(BROWSER_PATHS)) {
    if (fs.existsSync(execPath)) {
      available.push(name as BrowserType);
    }
  }
  
  return available;
}
