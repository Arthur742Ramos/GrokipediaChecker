/**
 * Grokipedia Content Fetcher
 * Fetches article content from Grokipedia using playwright-cli
 */

import { PlaywrightCLISession, findRefByText } from "./playwright-cli.js";
import { CopilotClient } from "@github/copilot-sdk";

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

    // Get a snapshot to check for Login button
    const snapshot = await session.snapshot();
    
    // Check if signed in (no Login button visible)
    const loginRef = findRefByText(snapshot, "Login", { partial: true });
    result.signedIn = loginRef === null;

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
    result.content = await session.eval(contentScript);

    // Extract sections using eval
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
  const allTopics: string[] = [];
  const batchSize = 50;
  const batches = Math.ceil(count / batchSize);

  for (let batch = 0; batch < batches; batch++) {
    const remaining = count - allTopics.length;
    const batchCount = Math.min(batchSize, remaining);
    
    if (batchCount <= 0) break;

    const session = await client.createSession({
      model: "claude-sonnet-4-20250514",
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

    session.on((event) => {
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
      continue;
    }

    // Parse the JSON array from the response
    try {
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const topics = JSON.parse(jsonMatch[0]);
        if (Array.isArray(topics)) {
          const validTopics = topics.filter((t): t is string => typeof t === "string");
          allTopics.push(...validTopics);
          process.stdout.write(`\r  Generated ${allTopics.length}/${count} topics...`);
        }
      }
    } catch (error) {
      console.error(`Failed to parse topics batch ${batch + 1}: ${error}`);
    }
  }

  console.log(); // New line after progress
  return [...new Set(allTopics)].slice(0, count); // Remove duplicates and limit to count
}
