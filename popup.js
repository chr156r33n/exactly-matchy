import {
  chatbotLinks,
  generatePrompts,
  promptListText,
} from "./generator.js";

const $ = (selector) => document.querySelector(selector);
const CACHE_KEY = "latestPromptResults";

async function chromeAiSession() {
  if (!globalThis.LanguageModel) return null;
  const languageOptions = {
    expectedInputs: [{ type: "text", languages: ["en"] }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
  };
  let availability;
  try {
    availability = await LanguageModel.availability(languageOptions);
  } catch {
    return null;
  }
  if (availability === "unavailable") return null;
  $("#model-status").textContent =
    availability === "available"
      ? "Chrome AI ready"
      : "Preparing Chrome on-device model…";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    return await LanguageModel.create({
      ...languageOptions,
      signal: controller.signal,
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          $("#model-status").textContent =
            `Downloading Chrome AI… ${Math.round(event.loaded * 100)}%`;
        });
      },
    });
  } catch {
    $("#model-status").textContent =
      "Chrome AI timed out — heuristic selection ready";
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function rankWithTimeout(session, instruction) {
  let timeout;
  try {
    return await Promise.race([
      session.prompt(instruction),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Chrome AI selection timed out.")),
          12_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function extractRenderedEvidence() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active page was found.");
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const noiseSelector = [
        "script", "style", "noscript", "svg", "nav", "footer", "form", "header",
        "aside", "dialog", "[hidden]", '[aria-hidden="true"]',
        '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
        '[role="dialog"]', '[class*="breadcrumb" i]', '[class*="cookie" i]',
        '[class*="consent" i]', '[class*="footer" i]', '[class*="header" i]',
        '[class*="menu" i]', '[class*="modal" i]', '[class*="nav-" i]',
        '[class*="navigation" i]', '[class*="newsletter" i]',
        '[class*="sidebar" i]', '[class*="social" i]', '[id*="cookie" i]',
        '[id*="consent" i]', '[id*="footer" i]', '[id*="menu" i]',
        '[id*="navigation" i]',
      ].join(",");
      const root =
        document.querySelector("main, article, [role=main]") || document.body;
      const score = { H1: 85, H2: 75, H3: 65, P: 40, LI: 35 };
      const chunks = [];
      const description =
        document
          .querySelector(
            'meta[name="description" i], meta[property="og:description" i]',
          )
          ?.getAttribute("content")
          ?.trim() || null;
      if (description) {
        chunks.push({
          kind: "meta_description",
          text: description.replace(/\s+/g, " ").trim().slice(0, 900),
          score: 95,
        });
      }
      for (const element of root.querySelectorAll("h1, h2, h3, p, li")) {
        if (element.closest(noiseSelector)) continue;
        if (!element.getClientRects().length) continue;
        const text = element.innerText.replace(/\s+/g, " ").trim();
        const minimum = /^H[1-3]$/.test(element.tagName) ? 12 : 40;
        if (text.length < minimum) continue;
        chunks.push({
          kind: element.tagName.toLowerCase(),
          text: text.slice(0, 900),
          score: score[element.tagName] || 40,
        });
        if (chunks.length >= 80) break;
      }
      return {
        source: location.href,
        title: document.title || null,
        description,
        chunks,
      };
    },
  });
  if (!result?.chunks?.length) {
    throw new Error("No useful visible page content was found.");
  }
  return result;
}

function render(prompts, evidence, usedChromeAi, restored = false) {
  $("#page-title").textContent =
    `${evidence.title || evidence.source} · ` +
    `${usedChromeAi ? "Chrome AI selection" : "heuristic selection"}` +
    `${restored ? " · restored" : ""}`;
  $("#prompt-list").innerHTML = prompts
    .map(
      (item, index) => `
        <article class="prompt-card">
          <pre class="prompt">${escapeHtml(`${index + 1}. ${item.prompt}`)}</pre>
          <div class="links">
            ${chatbotLinks(item.prompt)
              .map(
                (link) =>
                  `<a class="chat-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.name)}</a>`,
              )
              .join("")}
            <button class="copy-one" data-prompt="${encodeURIComponent(item.prompt)}" type="button">Copy</button>
          </div>
          <details>
            <summary>Supporting page text</summary>
            ${escapeHtml(item.supportingText)}
          </details>
        </article>`,
    )
    .join("");
  document.querySelectorAll(".copy-one").forEach((button) => {
    button.addEventListener("click", async () => {
      await navigator.clipboard.writeText(decodeURIComponent(button.dataset.prompt));
      button.textContent = "Copied";
    });
  });
  $("#copy-all").onclick = async () => {
    await navigator.clipboard.writeText(promptListText(prompts));
    $("#copy-all").textContent = "Copied all";
  };
  $("#results").hidden = false;
}

async function cacheResults(prompts, evidence, usedChromeAi) {
  try {
    await chrome.storage.session.set({
      [CACHE_KEY]: {
        prompts,
        evidence: {
          source: evidence.source,
          title: evidence.title,
        },
        usedChromeAi,
        count: Number($("#count").value || 5),
      },
    });
  } catch {
    // Results still work if session storage is unavailable.
  }
}

async function restoreCachedResults() {
  try {
    const cached = (await chrome.storage.session.get(CACHE_KEY))[CACHE_KEY];
    if (!cached || !Array.isArray(cached.prompts) || !cached.prompts.length) {
      return false;
    }
    $("#count").value = cached.count || cached.prompts.length;
    render(cached.prompts, cached.evidence, Boolean(cached.usedChromeAi), true);
    $("#model-status").textContent = "Results restored from this browser session";
    return true;
  } catch {
    return false;
  }
}

$("#analyze").addEventListener("click", async () => {
  const button = $("#analyze");
  $("#error").textContent = "";
  $("#results").hidden = true;
  button.disabled = true;
  button.textContent = "Reading rendered page…";
  try {
    const evidence = await extractRenderedEvidence();
    const session = await chromeAiSession();
    button.textContent = session ? "Selecting passages…" : "Scoring passages…";
    const prompts = await generatePrompts(evidence, {
      count: Number($("#count").value || 5),
      session,
      rankPassages: rankWithTimeout,
    });
    const usedChromeAi = prompts.some(
      (item) => item.generationMethod === "chrome_ai_selection",
    );
    render(prompts, evidence, usedChromeAi);
    await cacheResults(prompts, evidence, usedChromeAi);
    $("#model-status").textContent = usedChromeAi
      ? "Chrome AI ready"
      : "Chrome AI unavailable — heuristic selection used";
  } catch (error) {
    $("#error").textContent =
      error?.message || "The current page could not be analyzed.";
  } finally {
    button.disabled = false;
    button.textContent = "Select test passages";
  }
});

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

$("#model-status").textContent = globalThis.LanguageModel
  ? "Chrome AI available"
  : "Chrome AI unavailable — heuristic fallback ready";

restoreCachedResults();
