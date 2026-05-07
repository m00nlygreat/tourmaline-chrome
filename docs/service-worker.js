chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "tourmaline-download-markdown") return false;

  downloadMarkdown(message).then(sendResponse, (error) => {
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});

async function downloadMarkdown(message) {
  const filename = getMarkdownFileName(message.fileName, message.sourceUrl);
  const markdown = String(message.markdown ?? "");
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    type: "tourmaline-offscreen-download-markdown",
    filename,
    markdown
  });
  if (!response?.ok) throw new Error(response?.error || "Offscreen download failed.");
  return { ok: true, filename };
}

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL("offscreen.html");
  if (await hasOffscreenDocument(url)) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Create Markdown Blob downloads with the requested filename."
  });
}

async function hasOffscreenDocument(url) {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url]
  });
  return contexts.length > 0;
}

function getMarkdownFileName(name, sourceUrl = "") {
  const fallback = "Untitled.md";
  const candidate = name || getFileNameFromUrl(sourceUrl) || fallback;
  const clean = candidate.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/^\.+$/, fallback).trim() || fallback;
  return /\.(md|markdown)$/i.test(clean) ? clean : `${clean}.md`;
}

function getFileNameFromUrl(sourceUrl) {
  try {
    const pathName = new URL(sourceUrl).pathname;
    const name = decodeURIComponent(pathName.split(/[\\/]/).filter(Boolean).pop() || "");
    return name || null;
  } catch {
    return null;
  }
}
