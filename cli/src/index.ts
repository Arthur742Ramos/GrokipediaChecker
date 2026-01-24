#!/usr/bin/env node
/**
 * Grokipedia Article Reviewer CLI
 *
 * Uses GitHub Copilot SDK with Claude Opus 4.5 to analyze articles
 * for factual errors and submit corrections.
 * 
 * Flow:
 * 1. We fetch article content using Playwright
 * 2. We pass the content to Copilot for analysis
 * 3. Copilot uses web_search to verify facts and returns JSON with errors
 * 4. We parse the response and submit corrections via Playwright
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { CopilotClient, SessionEvent } from "@github/copilot-sdk";
import { startBrowser, BrowserManager, BrowserType, getAvailableBrowsers } from "./browser.js";
import {
  fetchArticleContent,
  getRandomArticle,
  getArticlesByTheme,
  generateRandomArticleTopics,
  ArticleContent,
} from "./fetcher.js";
import { submitEdit, EditRequest } from "./submitter.js";
import { Page } from "playwright";

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
  page: Page;
  session: Awaited<ReturnType<CopilotClient["createSession"]>>;
  busy: boolean;
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
}

// Global state for the review session
let browserManager: BrowserManager | null = null;

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

async function analyzeArticle(
  session: Awaited<ReturnType<CopilotClient["createSession"]>>,
  article: ArticleContent,
  verbose: boolean = false
): Promise<AnalysisResult> {
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
3. Use web_fetch to verify suspicious claims against Wikipedia or other authoritative sources
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
  let reasoningBuffer = "";

  // Collect the response from multiple event types
  session.on((event: SessionEvent) => {
    const eventAny = event as any; // For accessing properties not in type definitions
    
    // Stream deltas (actual response text)
    if (event.type === "assistant.message_delta") {
      const delta = event.data.deltaContent;
      if (delta) {
        fullResponse += delta;
        if (verbose) {
          process.stdout.write(chalk.white(delta));
        }
      }
    }
    // Show progress dots for reasoning (or full text in verbose mode)
    if (event.type === "assistant.reasoning_delta") {
      const reasoning = event.data?.deltaContent || "";
      if (verbose) {
        process.stdout.write(chalk.gray(reasoning));
      } else {
        dotCount++;
        if (dotCount % 10 === 0) {
          process.stdout.write(chalk.gray("."));
        }
      }
    }
    // Tool calls - show what Copilot is doing (event type may not be in SDK types)
    if (eventAny.type === "tool.call" && verbose) {
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
    if (eventAny.type === "tool.result" && verbose) {
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
  });

  try {
    await session.sendAndWait({ prompt }, 1800000); // 30 minute timeout
    console.log("\n");
  } catch (error) {
    console.error(chalk.red(`\nError during analysis: ${error}`));
  }

  return parseAnalysisResponse(fullResponse);
}

/**
 * Process a single article with a worker (for parallel processing)
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
    // Fetch article
    if (options.verbose) {
      console.log(`${prefix} Fetching: ${articleName}`);
    }
    const article = await fetchArticleContent(worker.page, articleName);

    if (article.error) {
      console.log(chalk.red(`${prefix} Failed to fetch ${articleName}: ${article.error}`));
      return result;
    }

    if (options.verbose) {
      console.log(`${prefix} Fetched ${article.content.length} chars`);
    }

    if (!article.signedIn && !options.dryRun) {
      console.log(chalk.yellow(`${prefix} Warning: Not signed in`));
    }

    // Analyze with Copilot
    if (options.verbose) {
      console.log(`${prefix} Analyzing...`);
    }
    const analysis = await analyzeArticle(worker.session, article, options.verbose);

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

        const submitResult = await submitEdit(worker.page, request);

        if (submitResult.success) {
          console.log(chalk.green(`${prefix}   Correction submitted`));
          result.correctionsSubmitted++;
        } else {
          console.log(chalk.red(`${prefix}   Failed: ${submitResult.message}`));
        }
      }
    }
  } catch (error) {
    console.log(chalk.red(`${prefix} Error processing ${articleName}: ${error}`));
  }

  progress.inProgress.delete(worker.id);
  progress.completed++;

  return result;
}

/**
 * Create worker pool with browser pages and Copilot sessions
 */
async function createWorkerPool(
  browserManager: BrowserManager,
  client: CopilotClient,
  workerCount: number
): Promise<Worker[]> {
  const workers: Worker[] = [];

  const systemMessage = `You are an expert fact-checker. Your job is to analyze encyclopedia articles and identify factual errors.

When analyzing an article:
1. Look for claims about dates, numbers, names, events, or scientific facts
2. Use web search to verify suspicious claims against authoritative sources (Wikipedia, official websites, academic sources)
3. Only report errors you have verified - do not guess or speculate
4. Return your findings as structured JSON

Be thorough but precise. Quality over quantity.`;

  // Create pages sequentially with small delays to avoid race conditions
  for (let i = 0; i < workerCount; i++) {
    let page: Page;
    if (i === 0) {
      page = browserManager.page;
    } else {
      // Small delay between page creations
      await new Promise(r => setTimeout(r, 200));
      page = await browserManager.createPage();
    }
    
    const session = await client.createSession({
      model: "claude-opus-4-5",
      streaming: true,
      systemMessage: { content: systemMessage },
    });

    workers.push({
      id: i + 1,
      page,
      session,
      busy: false,
    });
  }

  return workers;
}

/**
 * Get next available worker from pool
 */
function getAvailableWorker(workers: Worker[]): Worker | null {
  return workers.find((w) => !w.busy) || null;
}

/**
 * Display progress bar
 */
function displayProgress(progress: WorkerProgress): void {
  const pct = Math.round((progress.completed / progress.total) * 100);
  const bar = "█".repeat(Math.floor(pct / 5)) + "░".repeat(20 - Math.floor(pct / 5));
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

  console.log(chalk.bold.blue("\n=== Grokipedia Parallel Article Reviewer ===\n"));
  console.log(chalk.gray(`Iterations: ${options.iterations}`));
  console.log(chalk.gray(`Parallel workers: ${options.parallel}`));
  console.log(chalk.gray(`Mode: ${options.article ? "Specific article" : options.themes?.length ? "Theme-based" : "Random"}`));
  console.log(chalk.gray(`Browser: ${options.browser}`));
  console.log(chalk.gray(`Headless: ${options.headless}`));
  console.log(chalk.gray(`Dry run: ${options.dryRun}`));
  console.log(chalk.gray(`Verbose: ${options.verbose}`));
  console.log();

  // Start browser
  spinner.start(`Starting ${options.browser} browser...`);
  try {
    browserManager = await startBrowser({
      type: options.browser,
      headless: options.headless,
    });
    spinner.succeed(`Browser started (${browserManager.browserType})`);
  } catch (error) {
    spinner.fail(`Failed to start browser: ${error}`);
    process.exit(1);
  }

  // Initialize Copilot client
  spinner.start("Connecting to Copilot...");
  let client: CopilotClient;
  try {
    client = new CopilotClient();
    spinner.succeed("Connected to Copilot");
  } catch (error) {
    spinner.fail(`Failed to connect to Copilot: ${error}`);
    await browserManager.stop();
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
    await browserManager.stop();
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
      const articles = await getArticlesByTheme(browserManager.page, theme);
      specificArticles.push(...articles.slice(0, 5));
    }
    specificArticles = [...new Set(specificArticles)].slice(0, options.iterations);
    spinner.succeed(`Found ${specificArticles.length} articles`);
    useSpecificList = true;
  }

  console.log(chalk.bold(`\nStarting parallel processing of ${options.iterations} article(s)...\n`));

  // Track progress
  const progress: WorkerProgress = {
    completed: 0,
    total: options.iterations,
    inProgress: new Map(),
  };

  // Results collection
  const results: ArticleResult[] = [];

  // Shared state for topic generation
  let topicIndex = 0;
  const topicBatchSize = 10;
  let topicCache: string[] = [];
  const usedTopics = new Set<string>();
  
  // Get next article name - either from specific list or generate on demand
  const getNextArticle = async (workerId: number): Promise<string | null> => {
    if (useSpecificList) {
      const idx = topicIndex++;
      if (idx >= specificArticles.length) return null;
      return specificArticles[idx];
    }
    
    // Generate topics on demand in small batches
    if (topicCache.length === 0 && progress.completed + progress.inProgress.size < options.iterations) {
      const remaining = options.iterations - progress.completed - progress.inProgress.size;
      const batchCount = Math.min(topicBatchSize, remaining);
      
      if (batchCount > 0) {
        if (options.verbose) {
          console.log(chalk.gray(`[W${workerId}] Generating ${batchCount} article topics...`));
        }
        const newTopics = await generateRandomArticleTopics(client, batchCount);
        // Filter out already used topics
        const freshTopics = newTopics.filter(t => !usedTopics.has(t));
        topicCache.push(...freshTopics);
      }
    }
    
    const topic = topicCache.shift();
    if (topic) {
      usedTopics.add(topic);
      return topic;
    }
    return null;
  };

  // Process articles with worker pool - each worker runs independently
  const runningTasks: Promise<void>[] = [];

  const processNext = async (worker: Worker): Promise<void> => {
    // Small stagger per worker to avoid thundering herd
    await new Promise(r => setTimeout(r, worker.id * 300));
    
    while (progress.completed < options.iterations) {
      // Check if we've done enough
      if (progress.completed >= options.iterations) break;
      
      // Get next article
      const articleName = await getNextArticle(worker.id);
      if (!articleName) {
        // No more articles available, wait a bit and check again
        await new Promise(r => setTimeout(r, 1000));
        if (progress.completed >= options.iterations) break;
        continue;
      }

      worker.busy = true;
      try {
        const result = await processArticle(worker, articleName, options, progress);
        results.push(result);
      } catch (error) {
        console.log(chalk.red(`[W${worker.id}] Fatal error: ${error}`));
        progress.completed++; // Count as completed to avoid infinite loop
        // Try to recover by getting a new page
        try {
          worker.page = await browserManager!.createPage();
        } catch (e) {
          console.log(chalk.red(`[W${worker.id}] Could not recover, stopping worker`));
          break;
        }
      }
      worker.busy = false;

      if (!options.verbose) {
        displayProgress(progress);
      }
      
      // Small delay between articles
      await new Promise(r => setTimeout(r, 300));
    }
  };

  // Start all workers
  for (const worker of workers) {
    runningTasks.push(processNext(worker));
  }

  // Wait for all workers to complete
  await Promise.all(runningTasks);

  console.log("\n");

  // Print summary
  console.log(chalk.bold.green("\n=== Review Complete ===\n"));
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

  const totalErrors = results.reduce((sum, r) => sum + r.errorsFound, 0);
  const totalCorrections = results.reduce((sum, r) => sum + r.correctionsSubmitted, 0);
  console.log(chalk.bold(`\nTotal: ${totalErrors} errors found, ${totalCorrections} corrections submitted`));
  console.log(chalk.bold(`Processed: ${results.length} articles with ${workers.length} parallel worker(s)`));

  spinner.start("Cleaning up...");
  await client.stop();
  await browserManager.stop();
  spinner.succeed("Done");
}

async function runReviewLoop(options: ReviewOptions): Promise<void> {
  const spinner = ora();

  console.log(chalk.bold.blue("\n=== Grokipedia Article Reviewer ===\n"));
  console.log(chalk.gray(`Iterations: ${options.iterations}`));
  console.log(chalk.gray(`Mode: ${options.article ? "Specific article" : options.themes?.length ? "Theme-based" : "Random"}`));
  console.log(chalk.gray(`Browser: ${options.browser}`));
  console.log(chalk.gray(`Headless: ${options.headless}`));
  console.log(chalk.gray(`Dry run: ${options.dryRun}`));
  console.log(chalk.gray(`Verbose: ${options.verbose}`));
  console.log();

  // Start browser
  spinner.start(`Starting ${options.browser} browser...`);
  try {
    browserManager = await startBrowser({
      type: options.browser,
      headless: options.headless,
    });
    spinner.succeed(`Browser started (${browserManager.browserType})`);
  } catch (error) {
    spinner.fail(`Failed to start browser: ${error}`);
    process.exit(1);
  }

  // Initialize Copilot client
  spinner.start("Connecting to Copilot...");
  let client: CopilotClient;
  try {
    client = new CopilotClient();
    spinner.succeed("Connected to Copilot");
  } catch (error) {
    spinner.fail(`Failed to connect to Copilot: ${error}`);
    await browserManager.stop();
    process.exit(1);
  }

  // Create session with Claude Opus 4.5
  spinner.start("Creating Copilot session with Claude Opus 4.5...");
  let session;
  try {
    session = await client.createSession({
      model: "claude-opus-4-5",
      streaming: true,
      systemMessage: {
        content: `You are an expert fact-checker. Your job is to analyze encyclopedia articles and identify factual errors.

When analyzing an article:
1. Look for claims about dates, numbers, names, events, or scientific facts
2. Use web search to verify suspicious claims against authoritative sources (Wikipedia, official websites, academic sources)
3. Only report errors you have verified - do not guess or speculate
4. Return your findings as structured JSON

Be thorough but precise. Quality over quantity.`,
      },
    });
    spinner.succeed("Session created");
  } catch (error) {
    spinner.fail(`Failed to create session: ${error}`);
    await client.stop();
    await browserManager.stop();
    process.exit(1);
  }

  // Build the articles list to review
  let articlesToReview: string[] = [];

  if (options.article) {
    articlesToReview = [options.article];
  } else if (options.themes && options.themes.length > 0) {
    spinner.start(`Searching for articles in themes: ${options.themes.join(", ")}`);
    for (const theme of options.themes) {
      const articles = await getArticlesByTheme(browserManager.page, theme);
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

    // Determine which article to review
    if (articlesToReview.length === 0) {
      console.log(chalk.yellow("No articles available to review"));
      break;
    }
    const articleName = articlesToReview[i % articlesToReview.length];

    // Fetch article content
    spinner.start(`Fetching article: ${articleName}`);
    const article = await fetchArticleContent(browserManager.page, articleName);

    if (article.error) {
      spinner.fail(`Failed to fetch article: ${article.error}`);
      continue;
    }

    spinner.succeed(`Fetched ${article.content.length} characters`);

    if (!article.signedIn && !options.dryRun) {
      console.log(chalk.yellow("Warning: Not signed in to Grokipedia. Edit submissions may fail."));
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

        const result = await submitEdit(browserManager.page, request);

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
  await client.stop();
  await browserManager.stop();
  spinner.succeed("Done");
}

// CLI setup
const program = new Command();

program
  .name("grokipedia-review")
  .description("Automated Grokipedia article fact-checker using GitHub Copilot SDK")
  .version("1.0.0");

program
  .option("-n, --iterations <number>", "Number of articles to review", "1")
  .option("-p, --parallel <number>", "Number of parallel workers (default: 1, sequential)", "1")
  .option("-a, --article <name>", "Specific article to review")
  .option("-t, --theme <themes...>", "Theme(s) to search for articles (e.g., -t physics history)")
  .option("-b, --browser <type>", "Browser to use: chromium, firefox, webkit, chrome, edge, comet", "chromium")
  .option("--no-headless", "Show browser window (default: headless)")
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

    const validBrowsers: BrowserType[] = ["chromium", "firefox", "webkit", "chrome", "edge", "comet"];
    if (!validBrowsers.includes(opts.browser)) {
      console.error(chalk.red(`Error: Invalid browser type "${opts.browser}". Valid options: ${validBrowsers.join(", ")}`));
      process.exit(1);
    }

    const options: ReviewOptions = {
      iterations: parseInt(opts.iterations, 10),
      parallel: parseInt(opts.parallel, 10),
      article: opts.article,
      themes: opts.theme,
      headless: opts.headless !== false,
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

    // Cap parallel workers at 10 to avoid overwhelming resources
    if (options.parallel > 10) {
      console.log(chalk.yellow(`Warning: Capping parallel workers at 10 (requested ${options.parallel})`));
      options.parallel = 10;
    }

    // Use parallel loop if more than 1 worker, otherwise use sequential
    if (options.parallel > 1) {
      await runParallelReviewLoop(options);
    } else {
      await runReviewLoop(options);
    }
  });

program.parse();
