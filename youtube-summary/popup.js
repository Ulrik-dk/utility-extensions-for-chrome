const MAX_TRANSCRIPT_CHARS = 300000;
const PROMPT_PREFIX = "Summarize the main points very briefly:";

const SERVICES = {
  claude: { url: "https://claude.ai/new", label: "Claude" },
  chatgpt: { url: "https://chatgpt.com/", label: "ChatGPT" },
};

const state = {
  tabId: null,
  phase: "loading", // loading | not-youtube | ready | busy | done | error
  statusMessage: "",
};

const contentEl = document.getElementById("content");

init();

async function init() {
  setPhase("loading");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const videoId = extractVideoId(tab && tab.url);
  state.tabId = tab && tab.id;

  if (!videoId) {
    setPhase("not-youtube");
    return;
  }

  setPhase("ready");
}

// ---------- url helpers ----------

function extractVideoId(url) {
  if (!url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, "");

  if (host === "youtu.be") {
    return u.pathname.slice(1).split("/")[0] || null;
  }

  if (host === "youtube.com") {
    if (u.pathname === "/watch") return u.searchParams.get("v");
    const shorts = u.pathname.match(/^\/shorts\/([^/?]+)/);
    if (shorts) return shorts[1];
    const embed = u.pathname.match(/^\/embed\/([^/?]+)/);
    if (embed) return embed[1];
  }

  return null;
}

// ---------- subtitle extraction ----------
// YouTube's public timedtext API now returns HTTP 200 with an empty body for
// bare requests (confirmed by direct testing) — the same anti-bot lockdown that
// broke yt-dlp and similar tools. Instead, click the page's own "Show transcript"
// button and read the text it renders, which rides on YouTube's own working code path.

async function fetchTranscriptInTab(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      // YouTube's UI is built from Shadow DOM custom elements (ytd-*), so a plain
      // querySelectorAll from the top-level document can't see inside them. Walk
      // every shadow root recursively to find things that are actually on screen.
      function deepQueryAll(selector, root) {
        root = root || document;
        const out = [];
        const scan = (node) => {
          if (!node || !node.querySelectorAll) return;
          node.querySelectorAll(selector).forEach((el) => out.push(el));
          node.querySelectorAll("*").forEach((el) => {
            if (el.shadowRoot) scan(el.shadowRoot);
          });
        };
        scan(root);
        return out;
      }

      function findButtonByLabel(regex) {
        const candidates = deepQueryAll("button, tp-yt-paper-button");
        return candidates.find((el) => {
          const label = (el.getAttribute("aria-label") || el.textContent || "").trim();
          return regex.test(label);
        });
      }

      // The button's visible label/aria-label is localized (e.g. Danish renders
      // "Vis transskription" instead of "Show transcript"), so text matching alone
      // breaks for non-English YouTube UI languages. Custom element TAG NAMES are
      // never translated, so look for the known transcript-section container first
      // — this works regardless of the viewer's language — and only fall back to
      // English text matching if YouTube ever changes that container's tag name.
      function findTranscriptButton() {
        const sections = deepQueryAll("ytd-video-description-transcript-section-renderer");
        for (const section of sections) {
          const btn = deepQueryAll("button", section)[0];
          if (btn) return btn;
        }
        return findButtonByLabel(/show transcript/i);
      }

      try {
        let btn = findTranscriptButton();

        if (!btn) {
          const expandBtn = findButtonByLabel(/^(\.\.\.more|more)$/i);
          if (expandBtn) {
            expandBtn.click();
            await sleep(500);
            btn = findTranscriptButton();
          }
        }

        if (!btn) {
          return {
            error:
              'Couldn\'t find the "Show transcript" button on this page — this video may not have a transcript available.',
          };
        }

        btn.click();

        // YouTube has shipped at least two markups for transcript segments over
        // time: the legacy "ytd-transcript-segment-renderer" (with a ".segment-text"
        // child) and the current "transcript-segment-view-model" (whose caption text
        // lives in a nested span[role="text"], alongside timestamp/a11y-label divs
        // that must NOT be included). Match either.
        const SEGMENT_SELECTOR = "transcript-segment-view-model, ytd-transcript-segment-renderer";

        const deadline = Date.now() + 10000;
        let segments = [];
        while (Date.now() < deadline) {
          segments = deepQueryAll(SEGMENT_SELECTOR);
          if (segments.length > 0) break;
          await sleep(300);
        }

        if (!segments.length) {
          return { error: "Timed out waiting for the transcript panel to load." };
        }

        const transcript = segments
          .map((seg) => {
            const textEl =
              seg.querySelector('span[role="text"]') ||
              seg.querySelector(".ytAttributedStringHost") ||
              seg.querySelector(".segment-text");
            const source = textEl || seg.shadowRoot || seg;
            return source.textContent.trim();
          })
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();

        if (!transcript) return { error: "Transcript panel loaded but no text was found." };
        return { transcript };
      } catch (e) {
        return { error: (e && e.message) || "Unexpected error extracting the transcript." };
      }
    },
  });
  return result;
}

async function getTranscript(tabId) {
  const result = await fetchTranscriptInTab(tabId);
  if (!result || result.error) {
    throw new Error((result && result.error) || "Something went wrong fetching subtitles.");
  }

  let transcript = result.transcript;
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = transcript.slice(0, MAX_TRANSCRIPT_CHARS) + " […transcript truncated]";
  }

  return transcript;
}

// ---------- clipboard ----------

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // fall through to legacy fallback
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

// ---------- main flow ----------

async function onLaunch(service) {
  setPhase("busy", "Fetching subtitles…");
  try {
    const transcript = await getTranscript(state.tabId);
    const prompt = `${PROMPT_PREFIX}\n\n${transcript}`;
    await copyToClipboard(prompt);
    chrome.tabs.create({ url: SERVICES[service].url });
    setPhase("done", `Copied — paste it into the new ${SERVICES[service].label} tab.`);
  } catch (err) {
    setPhase("error", (err && err.message) || "Something went wrong.");
  }
}

// ---------- rendering ----------

function setPhase(phase, statusMessage) {
  state.phase = phase;
  state.statusMessage = statusMessage || "";
  render();
}

function launchButtonsHtml() {
  return `
    <div class="row">
      <button id="claudeBtn" class="btn btn-primary">Open in Claude</button>
      <button id="chatgptBtn" class="btn btn-secondary">Open in ChatGPT</button>
    </div>`;
}

function bindLaunchButtons() {
  document.getElementById("claudeBtn").addEventListener("click", () => onLaunch("claude"));
  document.getElementById("chatgptBtn").addEventListener("click", () => onLaunch("chatgpt"));
}

function render() {
  switch (state.phase) {
    case "loading":
      renderCenter(`<p class="muted">Loading…</p>`);
      break;

    case "not-youtube":
      renderCenter(`<p class="muted">Open a YouTube video tab to summarize it.</p>`);
      break;

    case "ready":
      renderCenter(launchButtonsHtml(), { bindButtons: true });
      break;

    case "busy":
      renderCenter(`
        <div class="spinner"></div>
        <p class="muted">${escapeHtml(state.statusMessage || "Working…")}</p>`);
      break;

    case "done":
      renderCenter(
        `<p class="status-text success">${escapeHtml(state.statusMessage)}</p>${launchButtonsHtml()}`,
        { bindButtons: true },
      );
      break;

    case "error":
      renderCenter(
        `<p class="status-text error">${escapeHtml(state.statusMessage)}</p>${launchButtonsHtml()}`,
        { bindButtons: true },
      );
      break;
  }
}

function renderCenter(bodyHtml, { bindButtons } = {}) {
  contentEl.innerHTML = `<div class="center">${bodyHtml}</div>`;
  if (bindButtons) bindLaunchButtons();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : str;
  return div.innerHTML;
}
