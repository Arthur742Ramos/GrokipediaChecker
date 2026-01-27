#!/usr/bin/env node
/**
 * Grokipedia Article Reviewer CLI
 *
 * Uses GitHub Copilot SDK with Claude Opus 4.5 to analyze articles
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
  article?: string;
  themes?: string[];
  headless: boolean;
  dryRun: boolean;
  verbose: boolean;
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

setupBackgroundSafeIO();

function buildCopilotSystemMessage(): string {
  return `You are an expert fact-checker. Your job is to analyze encyclopedia articles and identify factual errors.

When analyzing an article:
1. Look for claims about dates, numbers, names, events, or scientific facts
2. Use web search to verify suspicious claims against authoritative PRIMARY sources (official government sites, academic journals, university websites, museum archives, official biographies, published books). Do NOT use Wikipedia as a source - it is not authoritative.
3. Only report errors you have verified against primary sources - do not guess or speculate
4. Return your findings as structured JSON

Be thorough but precise. Quality over quantity. Primary sources only.`;
}

async function analyzeArticle(
  session: Awaited<ReturnType<CopilotClient["createSession"]>>,
  article: ArticleContent,
  verbose: boolean = false
): Promise<AnalysisResult> {
  const allowInteractiveOutput = canRenderInteractiveOutput();
  const contentForAnalysis = article.content.substring(0, 15000);

  const prompt = `I have already fetched this Grokipedia article for you. Please analyze it for factual errors.

ARTICLE: "${article.article}"
URL: ${article.url}

---
ARTICLE CONTENT:
${contentForAnalysis}
---

IMPORTANT: The article content is provided above. Do NOT try to fetch it again.

Your task:
1. Read through the article content above
2. Identify claims that might be factually incorrect (dates, numbers, names, historical facts)
3. Use web_fetch to verify suspicious claims against PRIMARY sources (official sites, academic journals, university pages, museum archives, published biographies). Do NOT use Wikipedia - find primary sources instead.
4. Report only verified errors

Return your findings as JSON:
\`\`\`json
{
  "errors": [
    {
      "text_to_select": "exact text from article containing the error (copy verbatim)",
      "error_description": "what is wrong with this text",
      "correct_information": "the verified correct fact",
      "corrected_text": "the replacement text that should replace text_to_select (MUST be different from text_to_select)",
      "sources": ["url used to verify"]
    }
  ],
  "summary": "brief analysis summary"
}
\`\`\`

CRITICAL: 
- "text_to_select" must be the EXACT text from the article that contains the error
- "corrected_text" must be the REPLACEMENT text with the error fixed - it MUST be different from text_to_select
- Example: if article says "died in 1861" but correct year is 1860, then:
  - text_to_select: "died in 1861"
  - corrected_text: "died in 1860"

If no factual errors are found, return empty errors array. Focus on factual accuracy, not style.`;

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

  try {
    // Fetch article using playwright-cli session
    if (options.verbose) {
      console.log(`${prefix} Fetching: ${articleName}`);
    }
    const article = await fetchArticleContent(worker.session, articleName, !options.headless);

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
  }

  progress.inProgress.delete(worker.id);
  progress.completed++;
  worker.articlesProcessed++;

  return result;
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
      model: "gpt-5.2-medium",
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
    model: "gpt-5.2-medium",
    streaming: true,
    systemMessage: { content: systemMessage },
  });
  
  worker.articlesProcessed = 0;
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
  console.log(chalk.gray(`Mode: ${options.article ? "Specific article" : options.themes?.length ? "Theme-based" : "Random"}`));
  console.log(chalk.gray(`Browser: ${options.browser}`));
  console.log(chalk.gray(`Headless: ${options.headless}`));
  console.log(chalk.gray(`Dry run: ${options.dryRun}`));
  console.log(chalk.gray(`Verbose: ${options.verbose}`));
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

  // Don't store all results in memory for large runs - just keep recent for summary
  // For runs > 100 articles, only keep last 100 results to show
  const MAX_STORED_RESULTS = 100;
  const results: ArticleResult[] = [];

  // Shared state for topic generation
  let topicIndex = 0;
  const topicBatchSize = 10;
  let topicCache: string[] = [];
  const usedTopics = new Set<string>();
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
    
    // Periodically clear old entries from usedTopics to prevent unbounded growth
    // Keep only recent entries (roughly last 1000)
    if (usedTopics.size > 2000) {
      const entries = Array.from(usedTopics);
      entries.slice(0, 1000).forEach(t => usedTopics.delete(t));
    }
    
    const topic = topicCache.shift();
    if (topic) {
      usedTopics.add(topic);
      return topic;
    }
    return null;
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
        if (options.iterations <= MAX_STORED_RESULTS) {
          results.push(result);
        } else {
          // For large runs, keep a sliding window of recent results
          results.push(result);
          if (results.length > MAX_STORED_RESULTS) {
            results.shift(); // Remove oldest
          }
        }
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
          // One more attempt
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

  if (allowInteractiveOutput) {
    console.log("\n");
  }

  // Print summary - use running totals for large runs
  console.log(chalk.bold.green("\n=== Review Complete ===\n"));
  
  if (options.iterations <= MAX_STORED_RESULTS) {
    // Small run: show per-worker breakdown
    console.log(chalk.bold("Results by worker:"));
    
    const byWorker = new Map<number, ArticleResult[]>();
    for (const r of results) {
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
    console.log(chalk.gray(`Recent articles processed: ${results.map(r => r.article).slice(-10).join(", ")}...`));
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

  // Create session with Claude Opus 4.5
  spinner.start("Creating Copilot session with Claude Opus 4.5...");
  let session;
  try {
    session = await client.createSession({
      model: "gpt-5.2-medium",
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

  // Track results
  const results: { article: string; errorsFound: number; correctionsSubmitted: number }[] = [];

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
    console.log(chalk.cyan("\nAnalyzing article with Claude Opus 4.5...\n"));
    const analysis = await analyzeArticle(session, article, options.verbose);

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

    results.push({
      article: articleName,
      errorsFound: analysis.errors.length,
      correctionsSubmitted,
    });
  }

  // Print summary
  console.log(chalk.bold.green("\n=== Review Complete ===\n"));
  console.log(chalk.bold("Results:"));
  for (const result of results) {
    console.log(chalk.white(`  ${result.article}: ${result.errorsFound} errors found, ${result.correctionsSubmitted} corrections submitted`));
  }

  const totalErrors = results.reduce((sum, r) => sum + r.errorsFound, 0);
  const totalCorrections = results.reduce((sum, r) => sum + r.correctionsSubmitted, 0);
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
  .option("-a, --article <name>", "Specific article to review")
  .option("-t, --theme <themes...>", "Theme(s) to search for articles (e.g., -t physics history)")
  .option("-b, --browser <type>", "Browser to use: chromium, chrome, edge, comet", "chromium")
  .option("--headed", "Show browser window (default: headless/background)")
  .option("--dry-run", "Analyze without submitting corrections")
  .option("-v, --verbose", "Show Copilot's reasoning and tool calls")
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

    const options: ReviewOptions = {
      iterations: parseInt(opts.iterations, 10),
      parallel: parseInt(opts.parallel, 10),
      article: opts.article,
      themes: opts.theme,
      headless: !opts.headed, // Default: headless (background mode)
      dryRun: opts.dryRun || false,
      verbose: opts.verbose || false,
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

    // Cap parallel workers at 10
    if (options.parallel > 10) {
      console.log(chalk.yellow(`Warning: Capping parallel workers at 10 (requested ${options.parallel})`));
      options.parallel = 10;
    }

    // Use parallel loop if more than 1 worker
    if (options.parallel > 1) {
      await runParallelReviewLoop(options);
    } else {
      await runReviewLoop(options);
    }
  });

program.parse();
