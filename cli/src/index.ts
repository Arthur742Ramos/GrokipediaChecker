#!/usr/bin/env node
/**
 * Grokipedia Article Reviewer CLI
 *
 * Uses GitHub Copilot SDK with GPT-5.1-Codex-Mini to analyze articles
 * for factual errors and submit corrections.
 * 
 * Now using playwright-cli for browser automation:
 * - Persistent sessions that preserve login state
 * - Simple CLI-based browser control
 * - Session management for parallel workers
 * 
 * Flow:
 * 1. We fetch article content using playwright-cli
 * 2. We pass the content to Copilot for analysis
 * 3. Copilot uses web_search to verify facts and returns JSON with errors
 * 4. We parse the response and submit corrections via playwright-cli
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { CopilotClient, SessionEvent } from "@github/copilot-sdk";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { appendFileSync } from "fs";

// Global error handlers for resilience
process.on("unhandledRejection", (reason, promise) => {
  const msg = `[${new Date().toISOString()}] Unhandled Rejection: ${reason}\n`;
  console.error(chalk.red(msg));
  appendFileSync("/tmp/grokipedia-errors.log", msg);
});

process.on("uncaughtException", (error) => {
  const msg = `[${new Date().toISOString()}] Uncaught Exception: ${error.message}\n${error.stack}\n`;
  console.error(chalk.red(msg));
  appendFileSync("/tmp/grokipedia-errors.log", msg);
  // Don't exit - try to continue
});

// Get the path to the Node.js copilot loader
// The native binary doesn't support SDK's JSON-RPC protocol, but the Node loader does
const __dirname = dirname(fileURLToPath(import.meta.url));
const COPILOT_LOADER_PATH = join(__dirname, "..", "node_modules", "@github", "copilot", "index.js");

/**
 * Create a CopilotClient configured to use the Node.js loader
 * This is required because the native binary doesn't support the SDK protocol
 */
function createCopilotClient(): CopilotClient {
  return new CopilotClient({
    cliPath: "node",
    cliArgs: [COPILOT_LOADER_PATH],
  });
}
import { startBrowser, BrowserManager, BrowserType, getAvailableBrowsers, stopAllBrowsers } from "./browser.js";
import { PlaywrightCLISession } from "./playwright-cli.js";
import {
  fetchArticleContent,
  getRandomArticle,
  getArticlesByTheme,
  generateRandomArticleTopics,
  ArticleContent,
} from "./fetcher.js";
import { submitEdit, EditRequest } from "./submitter.js";

// Types
interface ReviewOptions {
  iterations: number;
  parallel: number;
  batchSize: number;
  article?: string;
  themes?: string[];
  headless: boolean;
  dryRun: boolean;
  verbose: boolean;
  memoryTelemetry: boolean;
  memoryInterval: number;
  browser: BrowserType;
}

interface FactError {
  text_to_select: string;
  error_description: string;
  correct_information: string;
  corrected_text: string;
  sources: string[];
}

interface AnalysisResult {
  errors: FactError[];
  summary: string;
}

interface BatchAnalysisResult {
  results: { [articleName: string]: AnalysisResult };
}

// Worker types for parallel processing
interface Worker {
  id: number;
  session: PlaywrightCLISession;
  copilotSession: Awaited<ReturnType<CopilotClient["createSession"]>>;
  busy: boolean;
  articlesProcessed: number; // Track for periodic session refresh
}

interface ArticleResult {
  article: string;
  errorsFound: number;
  correctionsSubmitted: number;
  workerId: number;
}

interface WorkerProgress {
  completed: number;
  total: number;
  inProgress: Map<number, string>; // workerId -> articleName
  totalErrors: number; // Running total for summary
  totalCorrections: number; // Running total for summary
}

// Constants for memory management
const SESSION_REFRESH_INTERVAL = 50; // Recreate Copilot session every N articles to prevent memory buildup
const PAGE_RESET_INTERVAL = 50; // Recreate browser session every N articles to limit memory growth
const PAGE_REFRESH_INTERVAL = 20; // Recreate browser tab every N articles to prevent page-level leaks
const TOPIC_CACHE_MAX_SIZE = 100; // Limit topic cache size

// Global state for the review session
let browserManager: BrowserManager | null = null;

function setupBackgroundSafeIO(): void {
  const handleStreamError = (stream: NodeJS.WriteStream) => {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error?.code === "EPIPE") {
        return;
      }
      console.error(chalk.red(`Stream error: ${error?.message || error}`));
    });
  };

  handleStreamError(process.stdout);
  handleStreamError(process.stderr);

  process.on("SIGPIPE", () => {
    // Ignore SIGPIPE to avoid crashes when output is redirected
  });
}

function canRenderInteractiveOutput(): boolean {
  return Boolean(process.stdout.isTTY && process.stderr.isTTY);
}

function formatMemory(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatMemoryDelta(current: number, baseline: number): string {
  const delta = current - baseline;
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${(delta / (1024 * 1024)).toFixed(1)} MiB`;
}

interface MemoryTelemetryTracker {
  enabled: boolean;
  interval: number;
  baselineRss: number;
  baselineHeapUsed: number;
  lastLoggedCompleted: number;
}

function createMemoryTelemetryTracker(options: ReviewOptions): MemoryTelemetryTracker {
  const initial = process.memoryUsage();
  return {
    enabled: options.memoryTelemetry,
    interval: Math.max(1, options.memoryInterval),
    baselineRss: initial.rss,
    baselineHeapUsed: initial.heapUsed,
    lastLoggedCompleted: 0,
  };
}

function maybeLogMemoryTelemetry(
  tracker: MemoryTelemetryTracker,
  completed: number,
  total: number,
  inProgress: number,
  force: boolean = false
): void {
  if (!tracker.enabled) {
    return;
  }
  if (!force) {
    if (completed <= tracker.lastLoggedCompleted) {
      return;
    }
    if (completed === 0 || completed % tracker.interval !== 0) {
      return;
    }
  }

  const mem = process.memoryUsage();
  const line = [
    `[MEM ${completed}/${total}]`,
    `rss=${formatMemory(mem.rss)} (${formatMemoryDelta(mem.rss, tracker.baselineRss)})`,
    `heap=${formatMemory(mem.heapUsed)}/${formatMemory(mem.heapTotal)} (${formatMemoryDelta(mem.heapUsed, tracker.baselineHeapUsed)})`,
    `ext=${formatMemory(mem.external)}`,
    `arr=${formatMemory(mem.arrayBuffers)}`,
    `in_progress=${inProgress}`,
  ].join(" ");
  console.log(chalk.gray(line));
  tracker.lastLoggedCompleted = completed;
}

/**
 * Parse the analysis response from Copilot to extract errors
 */
function parseAnalysisResponse(response: string): AnalysisResult {
  // Try to find JSON in the response
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      return {
        errors: parsed.errors || [],
        summary: parsed.summary || "",
      };
    } catch (e) {
      console.log(chalk.yellow("Could not parse JSON from response"));
    }
  }

  // Try to parse the entire response as JSON
  try {
    const parsed = JSON.parse(response);
    return {
      errors: parsed.errors || [],
      summary: parsed.summary || "",
    };
  } catch (e) {
    // No JSON found, return empty
    return { errors: [], summary: response };
  }
}

/**
 * Parse batch analysis response from Copilot
 * Expects JSON with results keyed by article name
 */
function parseBatchAnalysisResponse(response: string, articleNames: string[]): BatchAnalysisResult {
  const defaultResult: BatchAnalysisResult = {
    results: {},
  };
  
  // Initialize with empty results for all articles
  for (const name of articleNames) {
    defaultResult.results[name] = { errors: [], summary: "" };
  }

  // Try to find JSON in the response
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed.results && typeof parsed.results === "object") {
        for (const name of articleNames) {
          const result = parsed.results[name];
          if (result) {
            defaultResult.results[name] = {
              errors: result.errors || [],
              summary: result.summary || "",
            };
          }
        }
        return defaultResult;
      }
    } catch (e) {
      console.log(chalk.yellow("Could not parse batch JSON from response"));
    }
  }

  // Try to parse the entire response as JSON
  try {
    const parsed = JSON.parse(response);
    if (parsed.results && typeof parsed.results === "object") {
      for (const name of articleNames) {
        const result = parsed.results[name];
        if (result) {
          defaultResult.results[name] = {
            errors: result.errors || [],
            summary: result.summary || "",
          };
        }
      }
      return defaultResult;
    }
  } catch (e) {
    // No JSON found
  }

  return defaultResult;
}

function releaseArticleMemory(article: ArticleContent | null | undefined): void {
  if (!article) return;
  article.content = "";
  article.sections = [];
}

function releaseArticlesMemory(articles: ArticleContent[]): void {
  for (const article of articles) {
    releaseArticleMemory(article);
  }
}

/**
 * Fetch multiple articles in parallel
 */
async function batchFetchArticles(
  session: PlaywrightCLISession,
  articleNames: string[],
  headed: boolean = false,
  verbose: boolean = false
): Promise<ArticleContent[]> {
  const results: ArticleContent[] = [];
  
  // Fetch articles in parallel with a small concurrency limit to avoid overwhelming the browser
  const FETCH_CONCURRENCY = 3;
  
  for (let i = 0; i < articleNames.length; i += FETCH_CONCURRENCY) {
    const batch = articleNames.slice(i, i + FETCH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (articleName) => {
        try {
          return await fetchArticleContent(session, articleName, headed);
        } catch (error) {
          return {
            article: articleName,
            url: `https://grokipedia.com/page/${articleName.replace(/ /g, "_")}`,
            signedIn: false,
            content: "",
            sections: [],
            error: String(error),
          };
        }
      })
    );
    results.push(...batchResults);
    
    // Small delay between fetch batches
    if (i + FETCH_CONCURRENCY < articleNames.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  
  return results;
}

/**
 * Analyze multiple articles in a single Copilot call
 */
async function analyzeBatchArticles(
  session: Awaited<ReturnType<CopilotClient["createSession"]>>,
  articles: ArticleContent[],
  verbose: boolean = false
): Promise<BatchAnalysisResult> {
  const allowInteractiveOutput = canRenderInteractiveOutput();
  const articleNames = articles.map(a => a.article);
  
  // Build the batch prompt
  const articleBlocks: string[] = [];
  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const contentForAnalysis = article.content.substring(0, 8000); // Smaller per-article limit for batches
    articleBlocks.push(`
=== ARTICLE ${i + 1}: "${article.article}" ===
URL: ${article.url}
CONTENT:
${contentForAnalysis}

`);
  }
  const articlesContent = articleBlocks.join("");

  const prompt = `I have fetched ${articles.length} Grokipedia articles for you. Please analyze ALL of them for factual errors.

${articlesContent}
---

IMPORTANT: All article content is provided above. Do NOT try to fetch them again.

Your task for EACH article:
1. Read through the article content
2. Identify claims that might be factually incorrect (dates, numbers, names, historical facts)
3. Use web_fetch to verify suspicious claims against PRIMARY sources (official sites, academic journals, university pages, museum archives, published biographies). Do NOT use Wikipedia - find primary sources instead.
4. Report only verified errors

Return your findings as JSON with results for ALL articles:
\`\`\`json
{
  "results": {
    "${articleNames[0]}": {
      "errors": [
        {
          "text_to_select": "exact text from article containing the error (copy verbatim)",
          "error_description": "what is wrong with this text",
          "correct_information": "the verified correct fact",
          "corrected_text": "the replacement text that should replace text_to_select",
          "sources": ["url used to verify"]
        }
      ],
      "summary": "brief analysis summary"
    },
    "${articleNames.length > 1 ? articleNames[1] : "Article Name 2"}": {
      "errors": [...],
      "summary": "..."
    }${articleNames.length > 2 ? ",\n    // ... continue for all articles" : ""}
  }
}
\`\`\`

CRITICAL: 
- Include results for ALL ${articles.length} articles, even if no errors found (use empty errors array)
- "text_to_select" must be the EXACT text from the article that contains the error
- "corrected_text" must be DIFFERENT from text_to_select
- Focus on factual accuracy, not style`;

  let fullResponse = "";
  let dotCount = 0;

  const eventHandler = (event: SessionEvent) => {
    const eventAny = event as any;
    
    if (event.type === "assistant.message_delta") {
      const delta = event.data.deltaContent;
      if (delta) {
        fullResponse += delta;
        if (verbose && allowInteractiveOutput) {
          process.stdout.write(chalk.white(delta));
        }
      }
    }
    if (event.type === "assistant.reasoning_delta") {
      const reasoning = event.data?.deltaContent || "";
      if (verbose && allowInteractiveOutput) {
        process.stdout.write(chalk.gray(reasoning));
      } else {
        dotCount++;
        if (dotCount % 10 === 0) {
          if (allowInteractiveOutput) {
            process.stdout.write(chalk.gray("."));
          }
        }
      }
    }
    if (eventAny.type === "tool.call" && verbose && allowInteractiveOutput) {
      const toolName = eventAny.data?.name || "unknown";
      const toolArgs = eventAny.data?.arguments || {};
      console.log(chalk.cyan(`\n[Tool: ${toolName}]`));
      if (toolName === "web_fetch" && toolArgs.url) {
        console.log(chalk.gray(`  Fetching: ${toolArgs.url}`));
      } else {
        console.log(chalk.gray(`  Args: ${JSON.stringify(toolArgs).substring(0, 200)}`));
      }
    }
    if (eventAny.type === "tool.result" && verbose && allowInteractiveOutput) {
      const result = eventAny.data?.content || "";
      const preview = typeof result === "string" ? result.substring(0, 300) : JSON.stringify(result).substring(0, 300);
      console.log(chalk.gray(`  Result: ${preview}${preview.length >= 300 ? "..." : ""}`));
    }
    if (event.type === "assistant.message") {
      const content = event.data?.content;
      if (content && !fullResponse) {
        fullResponse = content;
      }
    }
  };

  const unsubscribe = session.on(eventHandler);

  try {
    // Longer timeout for batch analysis (30 min base + 5 min per additional article)
    const timeoutMs = 1800000 + (articles.length - 1) * 300000;
    await session.sendAndWait({ prompt }, timeoutMs);
    if (allowInteractiveOutput) {
      console.log("\n");
    }
  } catch (error) {
    console.error(chalk.red(`\nError during batch analysis: ${error}`));
  } finally {
    unsubscribe();
  }

  return parseBatchAnalysisResponse(fullResponse, articleNames);
}

setupBackgroundSafeIO();

function buildCopilotSystemMessage(): string {
  return `You are a skeptical fact-checker analyzing AI-GENERATED encyclopedia articles that frequently contain hallucinated "facts".

CRITICAL: These articles are written by AI and OFTEN contain plausible-sounding but COMPLETELY FABRICATED information. Do NOT trust the content at face value.

Your approach:
1. ASSUME the article may contain fabrications until you verify claims
2. ALWAYS use web_search to verify specific claims (dates, names, numbers, events)
3. If you cannot find corroborating evidence for a claim, it may be fabricated - flag it
4. Look for red flags: overly specific details, obscure "historical" events, suspiciously detailed narratives
5. Use authoritative sources: academic sites, official records, established encyclopedias, news archives
6. Wikipedia IS acceptable as a starting point for verification (it's more reliable than AI hallucinations)

Be skeptical. Verify aggressively. These are AI-generated articles prone to hallucination.`;
}

async function analyzeArticle(
  session: Awaited<ReturnType<CopilotClient["createSession"]>>,
  article: ArticleContent,
  verbose: boolean = false
): Promise<AnalysisResult> {
  const allowInteractiveOutput = canRenderInteractiveOutput();
  const contentForAnalysis = article.content.substring(0, 15000);

  const prompt = `Fact-check this Grokipedia article. This is AI-GENERATED content that may contain HALLUCINATED facts.

ARTICLE: "${article.article}"
CONTENT:
${contentForAnalysis}

VERIFICATION RULES:
- DO NOT trust your training data. This article may contain fabricated information that sounds plausible.
- MUST use web_search to verify at least 3-5 specific claims (dates, names, numbers, events).
- If a claim cannot be verified via web search, it may be a hallucination - report it as "unverifiable/potentially fabricated".
- Look for red flags: obscure historical events with suspiciously specific details, people/places that don't appear in searches.
- Wikipedia and other encyclopedias ARE valid sources for verification.

WHAT TO CHECK:
- Dates (births, deaths, events) - search for "[person name] born" or "[event] date"
- Numbers (scores, statistics, counts) - search for official records
- Names (people, places) - verify they exist and did what the article claims
- Events - verify they actually happened

JSON format:
\`\`\`json
{"errors":[{"text_to_select":"exact wrong text","error_description":"why wrong (include your source)","corrected_text":"fixed text OR 'UNVERIFIABLE - no evidence found'","sources":["urls you searched"]}],"summary":"1 sentence including how many claims verified"}
\`\`\`

If all checked claims verify: {"errors":[],"summary":"Verified X claims, all accurate"}`;

  let fullResponse = "";
  let dotCount = 0;

  // Create event handler as a named function so we can remove it later
  // This prevents memory leaks from accumulating listeners
  const eventHandler = (event: SessionEvent) => {
    const eventAny = event as any;
    
    // Stream deltas (actual response text)
    if (event.type === "assistant.message_delta") {
      const delta = event.data.deltaContent;
      if (delta) {
        fullResponse += delta;
        if (verbose && allowInteractiveOutput) {
          process.stdout.write(chalk.white(delta));
        }
      }
    }
    // Show progress dots for reasoning
    if (event.type === "assistant.reasoning_delta") {
      const reasoning = event.data?.deltaContent || "";
      if (verbose && allowInteractiveOutput) {
        process.stdout.write(chalk.gray(reasoning));
      } else {
        dotCount++;
        if (dotCount % 10 === 0) {
          if (allowInteractiveOutput) {
            process.stdout.write(chalk.gray("."));
          }
        }
      }
    }
    // Tool calls
    if (eventAny.type === "tool.call" && verbose && allowInteractiveOutput) {
      const toolName = eventAny.data?.name || "unknown";
      const toolArgs = eventAny.data?.arguments || {};
      console.log(chalk.cyan(`\n[Tool: ${toolName}]`));
      if (toolName === "web_fetch" && toolArgs.url) {
        console.log(chalk.gray(`  Fetching: ${toolArgs.url}`));
      } else {
        console.log(chalk.gray(`  Args: ${JSON.stringify(toolArgs).substring(0, 200)}`));
      }
    }
    // Tool results
    if (eventAny.type === "tool.result" && verbose && allowInteractiveOutput) {
      const result = eventAny.data?.content || "";
      const preview = typeof result === "string" ? result.substring(0, 300) : JSON.stringify(result).substring(0, 300);
      console.log(chalk.gray(`  Result: ${preview}${preview.length >= 300 ? "..." : ""}`));
    }
    // Final message (fallback if no deltas)
    if (event.type === "assistant.message") {
      const content = event.data?.content;
      if (content && !fullResponse) {
        fullResponse = content;
      }
    }
  };

  // Register the event handler - session.on() returns an unsubscribe function
  const unsubscribe = session.on(eventHandler);

  try {
    await session.sendAndWait({ prompt }, 1800000); // 30 minute timeout
    if (allowInteractiveOutput) {
      console.log("\n");
    }
  } catch (error) {
    console.error(chalk.red(`\nError during analysis: ${error}`));
  } finally {
    // CRITICAL: Remove the event handler to prevent memory leaks and duplicated output
    // The SDK's on() method returns an unsubscribe function we must call
    unsubscribe();
  }

  return parseAnalysisResponse(fullResponse);
}

/**
 * Process a single article with a worker (for parallel processing)
 * Returns minimal result to reduce memory usage - stats tracked in progress
 */
async function processArticle(
  worker: Worker,
  articleName: string,
  options: ReviewOptions,
  progress: WorkerProgress
): Promise<ArticleResult> {
  const result: ArticleResult = {
    article: articleName,
    errorsFound: 0,
    correctionsSubmitted: 0,
    workerId: worker.id,
  };

  progress.inProgress.set(worker.id, articleName);
  
  const prefix = chalk.cyan(`[W${worker.id}]`);
  let article: ArticleContent | null = null;

  try {
    // Fetch article using playwright-cli session
    if (options.verbose) {
      console.log(`${prefix} Fetching: ${articleName}`);
    }
    article = await fetchArticleContent(worker.session, articleName, !options.headless);

    if (article.error) {
      console.log(chalk.red(`${prefix} Failed to fetch ${articleName}: ${article.error}`));
      return result;
    }

    if (options.verbose) {
      console.log(`${prefix} Fetched ${article.content.length} chars`);
    }

    if (!article.signedIn && !options.dryRun) {
      console.log(chalk.yellow(`${prefix} Warning: Not signed in to Grokipedia`));
      console.log(chalk.dim(`${prefix}   The browser session may not have your login cookies.`));
      console.log(chalk.dim(`${prefix}   Try: 1) Close other Comet instances, 2) Log in via the CLI browser window`));
    }

    // Analyze with Copilot
    if (options.verbose) {
      console.log(`${prefix} Analyzing...`);
    }
    const analysis = await analyzeArticle(worker.copilotSession, article, options.verbose);

    result.errorsFound = analysis.errors.length;
    console.log(`${prefix} ${articleName}: ${analysis.errors.length} error(s) found`);

    // Process errors
    for (const error of analysis.errors) {
      console.log(chalk.yellow(`${prefix} Error: "${error.text_to_select.substring(0, 50)}..."`));
      console.log(chalk.white(`${prefix}   Problem: ${error.error_description}`));
      console.log(chalk.white(`${prefix}   Fix: "${(error.corrected_text || "").substring(0, 50)}..."`));

      // Skip if corrected_text is missing or same as original
      if (!error.corrected_text || error.corrected_text === error.text_to_select) {
        console.log(chalk.yellow(`${prefix}   Skipping: corrected text same as original or missing`));
        continue;
      }

      if (options.dryRun) {
        console.log(chalk.blue(`${prefix}   [DRY RUN] Would submit correction`));
      } else {
        const request: EditRequest = {
          articleName: article.article,
          textToSelect: error.text_to_select,
          summary: `${error.error_description}\n\nCorrect information: ${error.correct_information}`,
          correction: error.corrected_text,
          sources: error.sources,
        };

        const submitResult = await submitEdit(worker.session, request, !options.headless);

        if (submitResult.success) {
          console.log(chalk.green(`${prefix}   Correction submitted`));
          result.correctionsSubmitted++;
        } else {
          console.log(chalk.red(`${prefix}   Failed: ${submitResult.message}`));
        }
      }
    }
    
    // Update running totals in progress (reduces need to store all results)
    progress.totalErrors += result.errorsFound;
    progress.totalCorrections += result.correctionsSubmitted;
    
  } catch (error) {
    console.log(chalk.red(`${prefix} Error processing ${articleName}: ${error}`));
  } finally {
    // Release large payloads as early as possible.
    releaseArticleMemory(article);
  }

  progress.inProgress.delete(worker.id);
  progress.completed++;
  worker.articlesProcessed++;

  return result;
}

/**
 * Process a batch of articles with a worker
 * Fetches all articles, analyzes them in a single Copilot call, then submits corrections
 */
async function processBatch(
  worker: Worker,
  articleNames: string[],
  options: ReviewOptions,
  progress: WorkerProgress
): Promise<ArticleResult[]> {
  const results: ArticleResult[] = [];
  const prefix = chalk.cyan(`[W${worker.id}]`);
  
  // Initialize results for each article
  for (const name of articleNames) {
    results.push({
      article: name,
      errorsFound: 0,
      correctionsSubmitted: 0,
      workerId: worker.id,
    });
  }

  // Track batch in progress
  const batchLabel = articleNames.length > 1 
    ? `${articleNames[0]} +${articleNames.length - 1}` 
    : articleNames[0];
  progress.inProgress.set(worker.id, batchLabel);
  let fetchedArticles: ArticleContent[] = [];
  
  try {
    // Fetch all articles in parallel
    if (options.verbose) {
      console.log(`${prefix} Fetching batch: ${articleNames.join(", ")}`);
    }
    fetchedArticles = await batchFetchArticles(worker.session, articleNames, !options.headless, options.verbose);
    
    // Filter out failed fetches but keep track for reporting
    const successfulArticles: ArticleContent[] = [];
    const failedArticles = new Set<string>();
    
    for (let i = 0; i < fetchedArticles.length; i++) {
      const article = fetchedArticles[i];
      if (article.error) {
        console.log(chalk.red(`${prefix} Failed to fetch ${article.article}: ${article.error}`));
        failedArticles.add(article.article);
      } else {
        successfulArticles.push(article);
        if (options.verbose) {
          console.log(`${prefix} Fetched ${article.article}: ${article.content.length} chars`);
        }
      }
    }
    
    // Check login status once
    const firstSuccess = successfulArticles[0];
    if (firstSuccess && !firstSuccess.signedIn && !options.dryRun) {
      console.log(chalk.yellow(`${prefix} Warning: Not signed in to Grokipedia`));
      console.log(chalk.dim(`${prefix}   The browser session may not have your login cookies.`));
    }
    
    if (successfulArticles.length === 0) {
      console.log(chalk.red(`${prefix} All articles in batch failed to fetch`));
      return results;
    }
    
    // Analyze batch with Copilot
    if (options.verbose) {
      console.log(`${prefix} Analyzing ${successfulArticles.length} articles...`);
    }
    const batchAnalysis = await analyzeBatchArticles(worker.copilotSession, successfulArticles, options.verbose);
    releaseArticlesMemory(fetchedArticles);
    fetchedArticles = [];
    
    // Process results for each article
    for (let i = 0; i < articleNames.length; i++) {
      const articleName = articleNames[i];
      const result = results[i];
      const analysis = batchAnalysis.results[articleName] || { errors: [], summary: "" };
      
      result.errorsFound = analysis.errors.length;
      console.log(`${prefix} ${articleName}: ${analysis.errors.length} error(s) found`);
      
      // Skip if article fetch failed
      if (failedArticles.has(articleName)) {
        continue;
      }
      
      // Process errors for this article
      for (const error of analysis.errors) {
        console.log(chalk.yellow(`${prefix} Error: "${error.text_to_select.substring(0, 50)}..."`));
        console.log(chalk.white(`${prefix}   Problem: ${error.error_description}`));
        console.log(chalk.white(`${prefix}   Fix: "${(error.corrected_text || "").substring(0, 50)}..."`));

        if (!error.corrected_text || error.corrected_text === error.text_to_select) {
          console.log(chalk.yellow(`${prefix}   Skipping: corrected text same as original or missing`));
          continue;
        }

        if (options.dryRun) {
          console.log(chalk.blue(`${prefix}   [DRY RUN] Would submit correction`));
        } else {
          const request: EditRequest = {
            articleName,
            textToSelect: error.text_to_select,
            summary: `${error.error_description}\n\nCorrect information: ${error.correct_information}`,
            correction: error.corrected_text,
            sources: error.sources,
          };

          const submitResult = await submitEdit(worker.session, request, !options.headless);

          if (submitResult.success) {
            console.log(chalk.green(`${prefix}   Correction submitted`));
            result.correctionsSubmitted++;
          } else {
            console.log(chalk.red(`${prefix}   Failed: ${submitResult.message}`));
          }
        }
      }
      
      // Update running totals
      progress.totalErrors += result.errorsFound;
      progress.totalCorrections += result.correctionsSubmitted;
    }
    
  } catch (error) {
    console.log(chalk.red(`${prefix} Error processing batch: ${error}`));
  } finally {
    releaseArticlesMemory(fetchedArticles);
  }

  progress.inProgress.delete(worker.id);
  progress.completed += articleNames.length;
  worker.articlesProcessed += articleNames.length;

  return results;
}

/**
 * Create worker pool with playwright-cli sessions and Copilot sessions
 */
async function createWorkerPool(
  browserManager: BrowserManager,
  client: CopilotClient,
  workerCount: number
): Promise<Worker[]> {
  const workers: Worker[] = [];

  const systemMessage = buildCopilotSystemMessage();

  // Determine if we're using CDP browsers (need longer delays)
  const isCdpBrowser = ["comet", "chrome", "edge"].includes(browserManager.browserType);

  // Create sessions sequentially with appropriate delays
  // CDP browsers need longer delays due to mutex and startup time
  for (let i = 0; i < workerCount; i++) {
    let session: PlaywrightCLISession;
    if (i === 0) {
      session = browserManager.session;
    } else {
      // Longer delay between session creations for CDP browsers
      // The mutex in launchCdpBrowser will serialize actual launches,
      // but we still want some spacing to reduce overall contention
      const delay = isCdpBrowser ? 1000 : 200;
      await new Promise(r => setTimeout(r, delay));
      session = await browserManager.createSession();
    }
    
    const copilotSession = await client.createSession({
      model: "gpt-5.1-codex-mini",
      streaming: true,
      systemMessage: { content: systemMessage },
    });

    workers.push({
      id: i + 1,
      session,
      copilotSession,
      busy: false,
      articlesProcessed: 0,
    });
    
    console.log(chalk.gray(`  Worker ${i + 1}/${workerCount} created`));
  }

  return workers;
}

/**
 * Refresh a worker's Copilot session to prevent memory buildup
 */
async function refreshWorkerSession(
  worker: Worker,
  client: CopilotClient
): Promise<void> {
  const systemMessage = buildCopilotSystemMessage();

  // Close old session (best effort)
  try {
    (worker.copilotSession as any).close?.();
  } catch {}

  // Create fresh session
  worker.copilotSession = await client.createSession({
    model: "gpt-5.1-codex-mini",
    streaming: true,
    systemMessage: { content: systemMessage },
  });
  
  worker.articlesProcessed = 0;
}

async function maybeResetWorkerPage(worker: Worker): Promise<void> {
  if (worker.articlesProcessed > 0 && worker.articlesProcessed % PAGE_REFRESH_INTERVAL === 0) {
    try {
      await worker.session.resetPage?.();
    } catch {}
  }
}

async function cleanupWorkers(workers: Worker[]): Promise<void> {
  await Promise.all(
    workers.map(async (worker) => {
      try {
        await worker.session.stop();
      } catch {}
      try {
        await (worker.copilotSession as any).close?.();
      } catch {}
    })
  );
}

/**
 * Display progress bar
 */
function displayProgress(progress: WorkerProgress): void {
  const pct = Math.min(100, Math.round((progress.completed / progress.total) * 100));
  const filled = Math.min(20, Math.floor(pct / 5));
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);
  const inProgressList = Array.from(progress.inProgress.values()).join(", ");
  process.stdout.write(
    `\r${chalk.cyan(`[${bar}] ${pct}% (${progress.completed}/${progress.total})`)} ${chalk.gray(inProgressList.substring(0, 40))}     `
  );
}

/**
 * Run parallel review loop
 */
async function runParallelReviewLoop(options: ReviewOptions): Promise<void> {
  const spinner = ora();
  const allowInteractiveOutput = canRenderInteractiveOutput();
  if (!allowInteractiveOutput) {
    spinner.stop();
  }

  console.log(chalk.bold.blue("\n=== Grokipedia Parallel Article Reviewer (playwright-cli) ===\n"));
  console.log(chalk.gray(`Iterations: ${options.iterations}`));
  console.log(chalk.gray(`Parallel workers: ${options.parallel}`));
  console.log(chalk.gray(`Batch size: ${options.batchSize}`));
  console.log(chalk.gray(`Mode: ${options.article ? "Specific article" : options.themes?.length ? "Theme-based" : "Random"}`));
  console.log(chalk.gray(`Browser: ${options.browser}`));
  console.log(chalk.gray(`Headless: ${options.headless}`));
  console.log(chalk.gray(`Dry run: ${options.dryRun}`));
  console.log(chalk.gray(`Verbose: ${options.verbose}`));
  console.log(chalk.gray(`Memory telemetry: ${options.memoryTelemetry ? `on (every ${options.memoryInterval})` : "off"}`));
  console.log();

  // Start browser manager
  spinner.start(`Starting playwright-cli browser sessions...`);
  try {
    browserManager = await startBrowser({
      type: options.browser,
      headless: options.headless,
    });
    spinner.succeed(`Browser manager started`);
  } catch (error) {
    spinner.fail(`Failed to start browser: ${error}`);
    process.exit(1);
  }

  // Initialize Copilot client
  spinner.start("Connecting to Copilot...");
  let client: CopilotClient;
  try {
    client = createCopilotClient();
    spinner.succeed("Connected to Copilot");
  } catch (error) {
    spinner.fail(`Failed to connect to Copilot: ${error}`);
    await stopAllBrowsers();
    process.exit(1);
  }

  // Create worker pool
  spinner.start(`Creating ${options.parallel} worker(s) with Copilot sessions...`);
  let workers: Worker[];
  try {
    workers = await createWorkerPool(browserManager, client, options.parallel);
    spinner.succeed(`Created ${workers.length} worker(s)`);
  } catch (error) {
    spinner.fail(`Failed to create workers: ${error}`);
    await client.stop();
    await stopAllBrowsers();
    process.exit(1);
  }

  // For specific article or theme mode, build list upfront
  let specificArticles: string[] = [];
  let useSpecificList = false;

  if (options.article) {
    specificArticles = [options.article];
    useSpecificList = true;
  } else if (options.themes && options.themes.length > 0) {
    spinner.start(`Searching for articles in themes: ${options.themes.join(", ")}`);
    for (const theme of options.themes) {
      const articles = await getArticlesByTheme(browserManager.session, theme, !options.headless);
      specificArticles.push(...articles.slice(0, 5));
    }
    specificArticles = [...new Set(specificArticles)].slice(0, options.iterations);
    spinner.succeed(`Found ${specificArticles.length} articles`);
    useSpecificList = true;
  }

  console.log(chalk.bold(`\nStarting parallel processing of ${options.iterations} article(s)...\n`));

  // Track progress with running totals
  const progress: WorkerProgress = {
    completed: 0,
    total: options.iterations,
    inProgress: new Map(),
    totalErrors: 0,
    totalCorrections: 0,
  };
  const memoryTracker = createMemoryTelemetryTracker(options);

  // Don't store all results in memory for large runs - just keep recent for summary
  // For runs > 100 articles, only keep last 100 results to show
  const MAX_STORED_RESULTS = 100;
  const results: ArticleResult[] = [];
  let resultsCursor = 0;
  let resultsWrapped = false;

  const pushResult = (result: ArticleResult): void => {
    if (results.length < MAX_STORED_RESULTS) {
      results.push(result);
      return;
    }
    results[resultsCursor] = result;
    resultsCursor = (resultsCursor + 1) % MAX_STORED_RESULTS;
    resultsWrapped = true;
  };

  const getOrderedRecentResults = (): ArticleResult[] => {
    if (!resultsWrapped) {
      return results;
    }
    return [...results.slice(resultsCursor), ...results.slice(0, resultsCursor)];
  };

  // Shared state for topic generation
  let topicIndex = 0;
  const topicBatchSize = 10;
  let topicCache: string[] = [];
  const usedTopics = new Set<string>();
  const usedTopicOrder: string[] = [];
  const USED_TOPIC_WINDOW = 1000;
  let topicGenerationPromise: Promise<void> | null = null;
  let topicGenerationErrorCount = 0;
  const MAX_TOPIC_GENERATION_ERRORS = 3;
  
  // Get next article name (with memory management)
  const getNextArticle = async (workerId: number): Promise<string | null> => {
    if (useSpecificList) {
      const idx = topicIndex++;
      if (idx >= specificArticles.length) return null;
      return specificArticles[idx];
    }
    
    // Generate topics on demand in small batches
    if (topicCache.length === 0 && progress.completed + progress.inProgress.size < options.iterations) {
      if (!topicGenerationPromise && topicGenerationErrorCount < MAX_TOPIC_GENERATION_ERRORS) {
        const remaining = options.iterations - progress.completed - progress.inProgress.size;
        const batchCount = Math.min(topicBatchSize, remaining);

        if (batchCount > 0) {
        if (options.verbose && allowInteractiveOutput) {
          console.log(chalk.gray(`[W${workerId}] Generating ${batchCount} article topics...`));
        }

          topicGenerationPromise = (async () => {
            try {
              const newTopics = await generateRandomArticleTopics(client, batchCount);
              const freshTopics = newTopics.filter(t => !usedTopics.has(t));
              topicCache.push(...freshTopics);

              // Limit topic cache size to prevent memory bloat
              if (topicCache.length > TOPIC_CACHE_MAX_SIZE) {
                topicCache = topicCache.slice(-TOPIC_CACHE_MAX_SIZE);
              }

              topicGenerationErrorCount = 0;
            } catch (error) {
              topicGenerationErrorCount++;
              if (options.verbose && allowInteractiveOutput) {
                console.log(chalk.yellow(`[W${workerId}] Topic generation failed: ${error}`));
              }
            } finally {
              topicGenerationPromise = null;
            }
          })();
        }
      }
    }

    if (topicGenerationPromise) {
      await topicGenerationPromise;
    }

    if (topicGenerationErrorCount >= MAX_TOPIC_GENERATION_ERRORS && topicCache.length === 0) {
      return null;
    }

    const topic = topicCache.shift();
    if (topic) {
      usedTopics.add(topic);
      usedTopicOrder.push(topic);
      if (usedTopicOrder.length > USED_TOPIC_WINDOW) {
        const oldest = usedTopicOrder.shift();
        if (oldest) {
          usedTopics.delete(oldest);
        }
      }
      return topic;
    }
    return null;
  };

  // Get next batch of articles (up to batchSize)
  const getNextBatch = async (workerId: number, batchSize: number): Promise<string[]> => {
    const batch: string[] = [];
    const remaining = options.iterations - progress.completed - (progress.inProgress.size * options.batchSize);
    const targetSize = Math.min(batchSize, Math.max(0, remaining));
    
    for (let i = 0; i < targetSize; i++) {
      const article = await getNextArticle(workerId);
      if (!article) break;
      batch.push(article);
    }
    
    return batch;
  };

  // Process articles with worker pool
  const runningTasks: Promise<void>[] = [];

  const processNext = async (worker: Worker): Promise<void> => {
    // Small stagger per worker
    await new Promise(r => setTimeout(r, worker.id * 300));
    
    while (progress.completed < options.iterations) {
      if (progress.completed >= options.iterations) break;
      
      // Refresh Copilot session periodically to prevent memory buildup
      if (worker.articlesProcessed > 0 && worker.articlesProcessed % SESSION_REFRESH_INTERVAL === 0) {
        console.log(chalk.gray(`[W${worker.id}] Refreshing Copilot session (processed ${worker.articlesProcessed} articles)...`));
        try {
          await refreshWorkerSession(worker, client);
        } catch (e) {
          console.log(chalk.yellow(`[W${worker.id}] Failed to refresh session, continuing with existing`));
        }
      }

      // Recreate browser session periodically to prevent Playwright memory growth
      if (worker.articlesProcessed > 0 && worker.articlesProcessed % PAGE_RESET_INTERVAL === 0) {
        console.log(chalk.gray(`[W${worker.id}] Resetting browser session (processed ${worker.articlesProcessed} articles)...`));
        try {
          await worker.session.stop().catch(() => {});
          worker.session = await browserManager!.createSession();
        } catch (e) {
          console.log(chalk.yellow(`[W${worker.id}] Failed to reset browser session, continuing with existing`));
        }
      }
      
      // Use batch processing if batchSize > 1
      if (options.batchSize > 1) {
        const batch = await getNextBatch(worker.id, options.batchSize);
        if (batch.length === 0) {
          await new Promise(r => setTimeout(r, 1000));
          if (progress.completed >= options.iterations) break;
          continue;
        }

        worker.busy = true;
        try {
          const batchResults = await processBatch(worker, batch, options, progress);
          
          // Memory management: only store recent results for large runs
          for (const result of batchResults) {
            pushResult(result);
          }
        } catch (error) {
          const errorMsg = `[W${worker.id}] Fatal error in batch: ${error}`;
          console.log(chalk.red(errorMsg));
          appendFileSync("/tmp/grokipedia-errors.log", `[${new Date().toISOString()}] ${errorMsg}\n`);
          progress.completed += batch.length;
          // Try to recover
          try {
            await worker.session.stop().catch(() => {});
            worker.session = await browserManager!.createSession();
            await refreshWorkerSession(worker, client);
            console.log(chalk.green(`[W${worker.id}] Recovered successfully`));
          } catch (e) {
            console.log(chalk.yellow(`[W${worker.id}] Recovery failed, retrying in 5s...`));
            await new Promise(r => setTimeout(r, 5000));
            try {
              worker.session = await browserManager!.createSession();
              await refreshWorkerSession(worker, client);
              console.log(chalk.green(`[W${worker.id}] Recovered on retry`));
            } catch (e2) {
              console.log(chalk.red(`[W${worker.id}] Could not recover, stopping worker`));
              break;
            }
          }
        }
        worker.busy = false;
      } else {
        // Original single-article processing for batchSize=1
        const articleName = await getNextArticle(worker.id);
        if (!articleName) {
          await new Promise(r => setTimeout(r, 1000));
          if (progress.completed >= options.iterations) break;
          continue;
        }

        worker.busy = true;
        try {
          const result = await processArticle(worker, articleName, options, progress);
          
          // Memory management: only store recent results for large runs
          pushResult(result);
        } catch (error) {
          const errorMsg = `[W${worker.id}] Fatal error: ${error}`;
          console.log(chalk.red(errorMsg));
          appendFileSync("/tmp/grokipedia-errors.log", `[${new Date().toISOString()}] ${errorMsg}\n`);
          progress.completed++;
          // Try to recover by getting a new session
          try {
            await worker.session.stop().catch(() => {});
            worker.session = await browserManager!.createSession();
            await refreshWorkerSession(worker, client);
            console.log(chalk.green(`[W${worker.id}] Recovered successfully`));
          } catch (e) {
            console.log(chalk.yellow(`[W${worker.id}] Recovery failed, retrying in 5s...`));
            await new Promise(r => setTimeout(r, 5000));
            try {
              worker.session = await browserManager!.createSession();
              await refreshWorkerSession(worker, client);
              console.log(chalk.green(`[W${worker.id}] Recovered on retry`));
            } catch (e2) {
              console.log(chalk.red(`[W${worker.id}] Could not recover, stopping worker`));
              break;
            }
          }
        }
        worker.busy = false;
      }

      await maybeResetWorkerPage(worker);
      maybeLogMemoryTelemetry(memoryTracker, progress.completed, progress.total, progress.inProgress.size);

      if (!options.verbose && allowInteractiveOutput) {
        displayProgress(progress);
      }
      
      await new Promise(r => setTimeout(r, 300));
    }
  };

  // Start all workers
  for (const worker of workers) {
    runningTasks.push(processNext(worker));
  }

  await Promise.all(runningTasks);
  maybeLogMemoryTelemetry(memoryTracker, progress.completed, progress.total, progress.inProgress.size, true);

  if (allowInteractiveOutput) {
    console.log("\n");
  }

  // Print summary - use running totals for large runs
  console.log(chalk.bold.green("\n=== Review Complete ===\n"));
  
  if (options.iterations <= MAX_STORED_RESULTS) {
    // Small run: show per-worker breakdown
    console.log(chalk.bold("Results by worker:"));
    
    const byWorker = new Map<number, ArticleResult[]>();
    for (const r of getOrderedRecentResults()) {
      if (!byWorker.has(r.workerId)) {
        byWorker.set(r.workerId, []);
      }
      byWorker.get(r.workerId)!.push(r);
    }

    for (const [workerId, workerResults] of byWorker) {
      console.log(chalk.cyan(`\nWorker ${workerId}:`));
      for (const r of workerResults) {
        console.log(chalk.white(`  ${r.article}: ${r.errorsFound} errors, ${r.correctionsSubmitted} corrections`));
      }
    }
  } else {
    // Large run: show summary only (we didn't store all results)
    console.log(chalk.gray(`(Detailed per-article breakdown omitted for large runs)`));
    const recent = getOrderedRecentResults();
    console.log(chalk.gray(`Recent articles processed: ${recent.map(r => r.article).slice(-10).join(", ")}...`));
  }

  // Use running totals from progress object (more memory efficient)
  console.log(chalk.bold(`\nTotal: ${progress.totalErrors} errors found, ${progress.totalCorrections} corrections submitted`));
  console.log(chalk.bold(`Processed: ${progress.completed} articles with ${workers.length} parallel worker(s)`));

  spinner.start("Cleaning up...");
  await cleanupWorkers(workers);
  await client.stop();
  await stopAllBrowsers();
  spinner.succeed("Done");
}

async function runReviewLoop(options: ReviewOptions): Promise<void> {
  const spinner = ora();
  const allowInteractiveOutput = canRenderInteractiveOutput();
  if (!allowInteractiveOutput) {
    spinner.stop();
  }

  console.log(chalk.bold.blue("\n=== Grokipedia Article Reviewer (playwright-cli) ===\n"));
  console.log(chalk.gray(`Iterations: ${options.iterations}`));
  console.log(chalk.gray(`Mode: ${options.article ? "Specific article" : options.themes?.length ? "Theme-based" : "Random"}`));
  console.log(chalk.gray(`Browser: ${options.browser}`));
  console.log(chalk.gray(`Headless: ${options.headless}`));
  console.log(chalk.gray(`Dry run: ${options.dryRun}`));
  console.log(chalk.gray(`Verbose: ${options.verbose}`));
  console.log(chalk.gray(`Memory telemetry: ${options.memoryTelemetry ? `on (every ${options.memoryInterval})` : "off"}`));
  console.log();

  // Start browser
  spinner.start(`Starting playwright-cli browser session...`);
  try {
    browserManager = await startBrowser({
      type: options.browser,
      headless: options.headless,
    });
    spinner.succeed(`Browser session started`);
  } catch (error) {
    spinner.fail(`Failed to start browser: ${error}`);
    process.exit(1);
  }

  // Initialize Copilot client
  spinner.start("Connecting to Copilot...");
  let client: CopilotClient;
  try {
    client = createCopilotClient();
    spinner.succeed("Connected to Copilot");
  } catch (error) {
    spinner.fail(`Failed to connect to Copilot: ${error}`);
    await stopAllBrowsers();
    process.exit(1);
  }

  // Create Copilot session
  spinner.start("Creating Copilot session...");
  let session;
  try {
    session = await client.createSession({
      model: "gpt-5.1-codex-mini",
      streaming: true,
      systemMessage: {
        content: buildCopilotSystemMessage(),
      },
    });
    spinner.succeed("Session created");
  } catch (error) {
    spinner.fail(`Failed to create session: ${error}`);
    await client.stop();
    await stopAllBrowsers();
    process.exit(1);
  }

  // Build the articles list to review
  let articlesToReview: string[] = [];

  if (options.article) {
    articlesToReview = [options.article];
  } else if (options.themes && options.themes.length > 0) {
    spinner.start(`Searching for articles in themes: ${options.themes.join(", ")}`);
    for (const theme of options.themes) {
      const articles = await getArticlesByTheme(browserManager.session, theme, !options.headless);
      articlesToReview.push(...articles.slice(0, 5));
    }
    articlesToReview = [...new Set(articlesToReview)];
    spinner.succeed(`Found ${articlesToReview.length} articles`);
  }

  // For random mode, use Copilot to generate article topics
  if (articlesToReview.length === 0) {
    spinner.start(`Generating ${options.iterations} random article topics with AI...`);
    const topics = await generateRandomArticleTopics(client, options.iterations);
    articlesToReview = topics;
    spinner.succeed(`Generated ${articlesToReview.length} article topics`);
    
    if (articlesToReview.length > 0) {
      console.log(chalk.gray(`Topics: ${articlesToReview.slice(0, 5).join(", ")}${articlesToReview.length > 5 ? "..." : ""}`));
    }
  }

  // Track only recent results and running totals to keep memory bounded.
  const MAX_STORED_RESULTS = 100;
  const results: { article: string; errorsFound: number; correctionsSubmitted: number }[] = [];
  let resultsCursor = 0;
  let resultsWrapped = false;
  let totalErrors = 0;
  let totalCorrections = 0;
  let completedIterations = 0;
  const memoryTracker = createMemoryTelemetryTracker(options);

  const pushResult = (result: { article: string; errorsFound: number; correctionsSubmitted: number }): void => {
    if (results.length < MAX_STORED_RESULTS) {
      results.push(result);
      return;
    }
    results[resultsCursor] = result;
    resultsCursor = (resultsCursor + 1) % MAX_STORED_RESULTS;
    resultsWrapped = true;
  };

  const getOrderedRecentResults = (): { article: string; errorsFound: number; correctionsSubmitted: number }[] => {
    if (!resultsWrapped) {
      return results;
    }
    return [...results.slice(resultsCursor), ...results.slice(0, resultsCursor)];
  };

  // Main review loop
  for (let i = 0; i < options.iterations; i++) {
    console.log(chalk.bold.yellow(`\n${"=".repeat(60)}`));
    console.log(chalk.bold.yellow(`Iteration ${i + 1} of ${options.iterations}`));
    console.log(chalk.bold.yellow(`${"=".repeat(60)}\n`));

    if (articlesToReview.length === 0) {
      console.log(chalk.yellow("No articles available to review"));
      break;
    }
    const articleName = articlesToReview[i % articlesToReview.length];

    // Fetch article content using playwright-cli
    spinner.start(`Fetching article: ${articleName}`);
    const article = await fetchArticleContent(browserManager.session, articleName, !options.headless);

    if (article.error) {
      spinner.fail(`Failed to fetch article: ${article.error}`);
      continue;
    }

    spinner.succeed(`Fetched ${article.content.length} characters`);

    if (!article.signedIn && !options.dryRun) {
      console.log(chalk.yellow("Warning: Not signed in to Grokipedia. Edit submissions may fail."));
      console.log(chalk.dim("  The browser session may not have your login cookies."));
      console.log(chalk.dim("  Try: 1) Close other Comet instances, 2) Log in via the CLI browser window"));
    }

    // Analyze with Copilot
    console.log(chalk.cyan("\nAnalyzing article with Copilot...\n"));
    const analysis = await analyzeArticle(session, article, options.verbose);
    releaseArticleMemory(article);

    console.log(chalk.bold(`\nAnalysis complete. Found ${analysis.errors.length} potential error(s).`));

    if (analysis.summary) {
      console.log(chalk.gray(`Summary: ${analysis.summary}`));
    }

    let correctionsSubmitted = 0;

    // Process each error
    for (const error of analysis.errors) {
      console.log(chalk.yellow(`\n--- Error Found ---`));
      console.log(chalk.white(`Text: "${error.text_to_select.substring(0, 100)}${error.text_to_select.length > 100 ? "..." : ""}"`));
      console.log(chalk.white(`Problem: ${error.error_description}`));
      console.log(chalk.white(`Correction: ${error.correct_information}`));
      console.log(chalk.white(`Fixed text: "${(error.corrected_text || "").substring(0, 100)}${(error.corrected_text || "").length > 100 ? "..." : ""}"`));
      if (error.sources.length > 0) {
        console.log(chalk.gray(`Sources: ${error.sources.join(", ")}`));
      }

      // Skip if corrected_text is missing or same as original
      if (!error.corrected_text || error.corrected_text === error.text_to_select) {
        console.log(chalk.yellow(`Skipping: corrected text same as original or missing`));
        continue;
      }

      if (options.dryRun) {
        console.log(chalk.blue(`[DRY RUN] Would submit correction`));
      } else {
        // Submit the correction
        spinner.start("Submitting correction...");
        const request: EditRequest = {
          articleName: article.article,
          textToSelect: error.text_to_select,
          summary: `${error.error_description}\n\nCorrect information: ${error.correct_information}`,
          correction: error.corrected_text,
          sources: error.sources,
        };

        const result = await submitEdit(browserManager.session, request, !options.headless);

        if (result.success) {
          spinner.succeed("Correction submitted");
          correctionsSubmitted++;
        } else {
          spinner.fail(`Failed to submit: ${result.message}`);
        }
      }
    }

    const iterationResult = {
      article: articleName,
      errorsFound: analysis.errors.length,
      correctionsSubmitted,
    };
    pushResult(iterationResult);
    totalErrors += iterationResult.errorsFound;
    totalCorrections += iterationResult.correctionsSubmitted;
    completedIterations++;
    maybeLogMemoryTelemetry(memoryTracker, completedIterations, options.iterations, 0);
  }
  maybeLogMemoryTelemetry(memoryTracker, completedIterations, options.iterations, 0, true);

  // Print summary
  console.log(chalk.bold.green("\n=== Review Complete ===\n"));
  if (options.iterations <= MAX_STORED_RESULTS) {
    console.log(chalk.bold("Results:"));
    for (const result of getOrderedRecentResults()) {
      console.log(chalk.white(`  ${result.article}: ${result.errorsFound} errors found, ${result.correctionsSubmitted} corrections submitted`));
    }
  } else {
    const recent = getOrderedRecentResults();
    console.log(chalk.gray(`(Detailed per-article breakdown omitted for large runs)`));
    console.log(chalk.gray(`Recent articles processed: ${recent.map(r => r.article).slice(-10).join(", ")}...`));
  }

  console.log(chalk.bold(`\nTotal: ${totalErrors} errors found, ${totalCorrections} corrections submitted`));

  spinner.start("Cleaning up...");
  try {
    (session as any).close?.();
  } catch {}
  await client.stop();
  await stopAllBrowsers();
  spinner.succeed("Done");
}

// CLI setup
const program = new Command();

program
  .name("grokipedia-review")
  .description("Automated Grokipedia article fact-checker using GitHub Copilot SDK and playwright-cli")
  .version("2.0.0");

// Login subcommand - opens browser for manual login
program
  .command("login")
  .description("Open browser to log in to Grokipedia (session will be saved)")
  .action(async () => {
    console.log(chalk.bold.blue("\n=== Grokipedia Login ===\n"));
    console.log(chalk.gray("Opening browser for login. Please log in to Grokipedia."));
    console.log(chalk.gray("The session will be saved for future use."));
    console.log(chalk.gray("Press Ctrl+C when done.\n"));

    const browserManager = await startBrowser({
      type: "chromium",
      headless: false, // Must be headed for login
    });

    // Navigate to Grokipedia
    await browserManager.session.open("https://grokipedia.com", true);
    
    console.log(chalk.cyan("Browser opened. Please log in to Grokipedia."));
    console.log(chalk.cyan("Press Ctrl+C when you're done logging in.\n"));

    // Keep the process running until user presses Ctrl+C
    process.on("SIGINT", async () => {
      console.log(chalk.yellow("\n\nSaving session..."));
      await browserManager.stop();
      console.log(chalk.green("Session saved! You can now run reviews without --no-headless."));
      process.exit(0);
    });

    // Keep alive
    await new Promise(() => {});
  });

program
  .option("-n, --iterations <number>", "Number of articles to review", "1")
  .option("-p, --parallel <number>", "Number of parallel workers (default: 1, sequential)", "1")
  .option("--batch-size <number>", "Articles per Copilot call (default: 5)", "5")
  .option("-a, --article <name>", "Specific article to review")
  .option("-t, --theme <themes...>", "Theme(s) to search for articles (e.g., -t physics history)")
  .option("-b, --browser <type>", "Browser to use: chromium, chrome, edge, comet", "chromium")
  .option("--headed", "Show browser window (default: headless/background)")
  .option("--dry-run", "Analyze without submitting corrections")
  .option("-v, --verbose", "Show Copilot's reasoning and tool calls")
  .option("--memory-telemetry", "Print periodic process memory usage")
  .option("--memory-interval <number>", "Memory telemetry interval in completed articles", process.env.GROKIPEDIA_MEMORY_INTERVAL || "10")
  .option("--list-browsers", "List available browsers")
  .action(async (opts) => {
    if (opts.listBrowsers) {
      console.log(chalk.bold("\nAvailable browsers:"));
      const available = getAvailableBrowsers();
      for (const browser of available) {
        console.log(chalk.green(`  - ${browser}`));
      }
      console.log();
      process.exit(0);
    }

    const validBrowsers: BrowserType[] = ["chromium", "chrome", "edge", "comet"];
    if (!validBrowsers.includes(opts.browser)) {
      console.error(chalk.red(`Error: Invalid browser type "${opts.browser}". Valid options: ${validBrowsers.join(", ")}`));
      process.exit(1);
    }

    const memoryTelemetryFromEnv = process.env.GROKIPEDIA_MEMORY_TELEMETRY === "1";
    const options: ReviewOptions = {
      iterations: parseInt(opts.iterations, 10),
      parallel: parseInt(opts.parallel, 10),
      batchSize: parseInt(opts.batchSize, 10),
      article: opts.article,
      themes: opts.theme,
      headless: !opts.headed, // Default: headless (background mode)
      dryRun: opts.dryRun || false,
      verbose: opts.verbose || false,
      memoryTelemetry: Boolean(opts.memoryTelemetry || memoryTelemetryFromEnv),
      memoryInterval: parseInt(opts.memoryInterval, 10),
      browser: opts.browser as BrowserType,
    };

    if (isNaN(options.iterations) || options.iterations < 1) {
      console.error(chalk.red("Error: iterations must be a positive number"));
      process.exit(1);
    }

    if (isNaN(options.parallel) || options.parallel < 1) {
      console.error(chalk.red("Error: parallel must be a positive number"));
      process.exit(1);
    }

    if (isNaN(options.batchSize) || options.batchSize < 1) {
      console.error(chalk.red("Error: batch-size must be a positive number"));
      process.exit(1);
    }

    if (isNaN(options.memoryInterval) || options.memoryInterval < 1) {
      console.error(chalk.red("Error: memory-interval must be a positive number"));
      process.exit(1);
    }

    // Cap batch size at 10 to avoid overly long prompts
    if (options.batchSize > 10) {
      console.log(chalk.yellow(`Warning: Capping batch size at 10 (requested ${options.batchSize})`));
      options.batchSize = 10;
    }

    // Cap parallel workers at 30
    if (options.parallel > 30) {
      console.log(chalk.yellow(`Warning: Capping parallel workers at 30 (requested ${options.parallel})`));
      options.parallel = 30;
    }

    // Use parallel loop if more than 1 worker OR batch size > 1
    if (options.parallel > 1 || options.batchSize > 1) {
      await runParallelReviewLoop(options);
    } else {
      await runReviewLoop(options);
    }
  });

program.parse();
