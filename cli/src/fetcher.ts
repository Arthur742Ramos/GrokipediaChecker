/**
 * Grokipedia Content Fetcher
 * Fetches article content from Grokipedia using playwright-cli
 */

import { PlaywrightCLISession, findRefByText } from "./playwright-cli.js";
import { CopilotClient } from "@github/copilot-sdk";

const DEFAULT_MAX_CONTENT_CHARS = 30000;
const MAX_CONTENT_CHARS = (() => {
  const raw = process.env.GROKIPEDIA_MAX_CONTENT_CHARS;
  if (!raw) return DEFAULT_MAX_CONTENT_CHARS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONTENT_CHARS;
})();
const EXTRACT_SECTIONS = process.env.GROKIPEDIA_EXTRACT_SECTIONS === "1";

export interface ArticleSection {
  level: string;
  title: string;
  content: string;
}

export interface ArticleContent {
  article: string;
  url: string;
  signedIn: boolean;
  content: string;
  sections: ArticleSection[];
  error?: string;
}

export async function fetchArticleContent(
  session: PlaywrightCLISession,
  articleName: string,
  headed: boolean = false
): Promise<ArticleContent> {
  const articleSlug = articleName.replace(/ /g, "_");
  const url = `https://grokipedia.com/page/${articleSlug}`;

  const result: ArticleContent = {
    article: articleName,
    url,
    signedIn: false,
    content: "",
    sections: [],
  };

  try {
    // Navigate to article
    await session.open(url, headed);

    // Wait for page to load
    await session.wait(3000);

    // Check if signed in using JavaScript evaluation
    // This is more reliable than snapshot-based text matching because:
    // 1. It checks for the actual login link href (not just text that contains "Login")
    // 2. It also checks for logged-in indicators like logout links or user profile elements
    const loginCheckScript = `
      (function() {
        // Check for login link pointing to the auth endpoint
        // The login link has text "Login" and points to check-login or sign-in
        var loginLinks = document.querySelectorAll('a[href*="check-login"], a[href*="sign-in"]');
        var hasLoginLink = false;
        for (var i = 0; i < loginLinks.length; i++) {
          var text = (loginLinks[i].textContent || '').trim().toLowerCase();
          if (text === 'login' || text === 'log in' || text === 'sign in') {
            hasLoginLink = true;
            break;
          }
        }
        
        // Check for logged-in indicators - be specific to avoid false positives
        // Logout link should have "logout" or "sign-out" in the path (not just anywhere in URL)
        var allLinks = document.querySelectorAll('a');
        var hasLogoutLink = false;
        var hasProfileLink = false;
        
        for (var i = 0; i < allLinks.length; i++) {
          var href = (allLinks[i].getAttribute('href') || '').toLowerCase();
          var text = (allLinks[i].textContent || '').trim().toLowerCase();
          
          // Check for logout - must be explicit logout action
          if (href.includes('/logout') || href.includes('/sign-out') || 
              text === 'logout' || text === 'log out' || text === 'sign out') {
            hasLogoutLink = true;
          }
          
          // Check for profile link - must be a path like /profile or /user/xxx, not accounts.x.ai
          if ((href.includes('/profile') || href.includes('/user/')) && 
              !href.includes('accounts.x.ai') && !href.includes('check-login')) {
            hasProfileLink = true;
          }
        }
        
        // Check for user avatar
        var userAvatar = document.querySelector('[data-testid="avatar"], [data-testid="user-avatar"], img.avatar, img.user-avatar');
        var hasAvatar = !!userAvatar;
        
        var hasLoggedInIndicator = hasLogoutLink || hasProfileLink || hasAvatar;
        
        // User is signed in if:
        // - There's no login link to auth endpoint, OR
        // - There are logged-in indicators present
        var signedIn = !hasLoginLink || hasLoggedInIndicator;
        
        return JSON.stringify({
          signedIn: signedIn,
          hasLoginLink: hasLoginLink,
          hasLoggedInIndicator: hasLoggedInIndicator
        });
      })()
    `;
    const loginCheckResult = await session.eval(loginCheckScript);
    try {
      const parsed = JSON.parse(loginCheckResult);
      result.signedIn = parsed.signedIn;
    } catch {
      // Fallback to snapshot-based detection if eval fails
      const snapshot = await session.snapshot();
      const loginRef = findRefByText(snapshot, "Login", { partial: true });
      result.signedIn = loginRef === null;
    }

    // Extract content using eval
    const contentScript = `
      (function() {
        var article =
          document.querySelector("article") ||
          document.querySelector('[role="article"]') ||
          document.querySelector("main");
        return article ? article.innerText : document.body.innerText;
      })()
    `;
    const content = await session.eval(contentScript);
    result.content = content.slice(0, MAX_CONTENT_CHARS);

    if (EXTRACT_SECTIONS) {
      // Optional, because section extraction can duplicate a lot of text in memory.
      const sectionsScript = `
        (function() {
          var sections = [];
          var headings = document.querySelectorAll("h1, h2, h3");

          headings.forEach(function(heading) {
            var content = "";
            var sibling = heading.nextElementSibling;

            while (sibling && ["H1", "H2", "H3"].indexOf(sibling.tagName) === -1) {
              content += sibling.innerText + "\\n";
              sibling = sibling.nextElementSibling;
            }

            sections.push({
              level: heading.tagName,
              title: heading.innerText,
              content: content.trim(),
            });
          });

          return JSON.stringify(sections);
        })()
      `;
      const sectionsJson = await session.eval(sectionsScript);
      try {
        result.sections = JSON.parse(sectionsJson);
      } catch {
        result.sections = [];
      }
    }
  } catch (error) {
    result.error = String(error);
  }

  return result;
}

export async function getRandomArticle(
  session: PlaywrightCLISession,
  headed: boolean = false
): Promise<string | null> {
  try {
    // Go to Grokipedia homepage
    await session.open("https://grokipedia.com", headed);
    await session.wait(3000);

    // Extract article links using eval
    const script = `
      (function() {
        var links = Array.from(document.querySelectorAll('a[href*="/page/"]'));
        return JSON.stringify(links
          .map(function(link) {
            var href = link.getAttribute("href");
            if (href) {
              var match = href.match(/\\/page\\/([^/]+)/);
              return match ? match[1].replace(/_/g, " ") : null;
            }
            return null;
          })
          .filter(function(name) { return name !== null; }));
      })()
    `;
    const linksJson = await session.eval(script);
    const articleLinks: string[] = JSON.parse(linksJson);

    if (articleLinks.length > 0) {
      const randomIndex = Math.floor(Math.random() * articleLinks.length);
      return articleLinks[randomIndex];
    }

    return null;
  } catch {
    return null;
  }
}

export async function getArticlesByTheme(
  session: PlaywrightCLISession,
  theme: string,
  headed: boolean = false
): Promise<string[]> {
  try {
    // Search for articles by theme
    const searchUrl = `https://grokipedia.com/search?q=${encodeURIComponent(theme)}`;
    await session.open(searchUrl, headed);
    await session.wait(3000);

    // Extract article names from search results
    const script = `
      (function() {
        var links = Array.from(document.querySelectorAll('a[href*="/page/"]'));
        return JSON.stringify(links
          .map(function(link) {
            var href = link.getAttribute("href");
            if (href) {
              var match = href.match(/\\/page\\/([^/]+)/);
              return match ? match[1].replace(/_/g, " ") : null;
            }
            return null;
          })
          .filter(function(name) { return name !== null; }));
      })()
    `;
    const articlesJson = await session.eval(script);
    const articles: string[] = JSON.parse(articlesJson);

    return [...new Set(articles)]; // Remove duplicates
  } catch {
    return [];
  }
}

/**
 * Generate random encyclopedia article topics using Copilot
 * This uses the LLM to suggest diverse, interesting topics that would exist in an encyclopedia
 * Generates in batches of 50 to handle large counts
 */
export async function generateRandomArticleTopics(
  client: CopilotClient,
  count: number
): Promise<string[]> {
  const allowInteractiveOutput = Boolean(process.stdout.isTTY && process.stderr.isTTY);
  const allTopics: string[] = [];
  const batchSize = 50;
  const batches = Math.ceil(count / batchSize);

  for (let batch = 0; batch < batches; batch++) {
    const remaining = count - allTopics.length;
    const batchCount = Math.min(batchSize, remaining);
    
    if (batchCount <= 0) break;

    const session = await client.createSession({
      model: "gpt-5.1-codex-mini",
      streaming: true,
      systemMessage: {
        content: `You are a helpful assistant that generates random encyclopedia article topics.
Generate diverse topics across different categories: history, science, geography, animals, plants, 
famous people, events, inventions, places, mythology, sports, music, art, literature, etc.
Return ONLY a JSON array of topic names, nothing else. Each topic should be a real encyclopedia-worthy subject.`,
      },
    });

    // Make each batch request different topics by using batch number as a seed hint
    const categories = [
      "obscure historical events and figures",
      "scientific phenomena and discoveries", 
      "unusual animals and plants",
      "ancient civilizations and artifacts",
      "geographic features and locations",
      "inventions and technological milestones",
      "mythology and folklore",
      "sports history and athletes",
      "music and art history",
      "literature and authors"
    ];
    const categoryHint = categories[batch % categories.length];

    const prompt = `Generate ${batchCount} random encyclopedia article topics, focusing especially on ${categoryHint}.
Make them diverse and specific (e.g., "Antikythera mechanism" not "Ancient technology").
Avoid common topics - prefer obscure but real subjects.
${allTopics.length > 0 ? `Avoid these already generated topics: ${allTopics.slice(-20).join(", ")}` : ""}
Return ONLY a valid JSON array of strings, like: ["Topic 1", "Topic 2", ...]`;

    let response = "";

    // Register handler and get unsubscribe function - MUST call unsubscribe after each batch
    const unsubscribe = session.on((event) => {
      if (event.type === "assistant.message_delta") {
        const delta = event.data.deltaContent;
        if (delta) {
          response += delta;
        }
      }
      if (event.type === "assistant.message") {
        const content = event.data?.content;
        if (content && !response) {
          response = content;
        }
      }
    });

    try {
      await session.sendAndWait({ prompt }, 120000); // 2 minute timeout per batch
    } catch (error) {
      console.error(`Error generating topics batch ${batch + 1}: ${error}`);
      unsubscribe(); // Clean up handler before continuing to next batch
      continue;
    }
    
    // Clean up the event handler to prevent accumulation
    unsubscribe();

    // Close the Copilot session to avoid leaks
    try {
      (session as any).close?.();
    } catch {}

    // Parse the JSON array from the response
    try {
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const topics = JSON.parse(jsonMatch[0]);
        if (Array.isArray(topics)) {
          const validTopics = topics.filter((t): t is string => typeof t === "string");
           allTopics.push(...validTopics);
           if (allowInteractiveOutput) {
             process.stdout.write(`\r  Generated ${allTopics.length}/${count} topics...`);
           }
        }
      }
    } catch (error) {
      console.error(`Failed to parse topics batch ${batch + 1}: ${error}`);
    }
  }

  if (allowInteractiveOutput) {
    console.log(); // New line after progress
  }
  return [...new Set(allTopics)].slice(0, count); // Remove duplicates and limit to count
}
