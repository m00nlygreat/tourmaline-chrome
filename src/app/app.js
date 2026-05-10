import { Editor, Node, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import MarkdownIt from "markdown-it";
import TurndownService from "turndown";

const STAGE_WIDTH = 14000;
const STAGE_HEIGHT = 9000;
const DEFAULT_CARD_WIDTH = 380;
const DEFAULT_CARD_HEIGHT = 320;
const MIN_CARD_WIDTH = 240;
const MAX_CARD_WIDTH = 1200;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2.5;
const MIN_SCROLLABLE_OVERFLOW = 2;
const GRID_SPACING = 28;
const GRID_DOT_RADIUS = 0.9;
const MIN_GRID_SCREEN_SPACING = 14;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"]);
const MARKDOWN_PICKER_ID = "tourmaline-markdown-file";
const SAMPLE_MARKDOWN = `# Tourmaline Chrome

Tourmaline turns a Markdown document into movable cards on a browser canvas.

## Background

The Chrome version turns each canvas card into an editable writing surface.

![Remote sample](https://picsum.photos/seed/tourmaline/480/240)

## Browser Port

- Manifest V3 extension page
- File System Access API for local Markdown files
- IndexedDB layout metadata

## Embeds

![[diagram.png]]

![[Project notes.md#Roadmap]]

## Interaction

Drag cards, resize them from the right edge, select rows in the layer panel, and pan or zoom the canvas.
`;

const MarkdownImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      class: { default: null },
      "data-item-id": { default: null },
      "data-embed-id": { default: null },
      "data-owner-id": { default: null },
      "data-line": { default: null },
      "data-markdown": { default: null }
    };
  }
});

const EmbedPill = Node.create({
  name: "embedPill",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      class: { default: "embed-pill selectable-embed" },
      "data-item-id": { default: null },
      "data-embed-id": { default: null },
      "data-owner-id": { default: null },
      "data-line": { default: null },
      "data-markdown": { default: null },
      label: { default: "File embed" }
    };
  },
  parseHTML() {
    return [{ tag: "div.embed-pill" }];
  },
  renderHTML({ HTMLAttributes }) {
    const label = HTMLAttributes.label || "File embed";
    const attrs = { ...HTMLAttributes };
    delete attrs.label;
    return ["div", mergeAttributes(attrs), label];
  }
});

const editorExtensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    link: {
      openOnClick: false,
      autolink: true,
      defaultProtocol: "https"
    },
    trailingNode: false
  }),
  MarkdownImage,
  Table.configure({
    resizable: false
  }),
  TableRow,
  TableHeader,
  TableCell,
  EmbedPill
];

const markdownIt = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false
});

const turndown = new TurndownService({
  codeBlockStyle: "fenced",
  headingStyle: "atx",
  bulletListMarker: "-"
});

turndown.addRule("preserveEmbeds", {
  filter: (node) => node instanceof HTMLElement && node.hasAttribute("data-markdown"),
  replacement: (_content, node) => node.getAttribute("data-markdown") || ""
});

turndown.addRule("markdownTables", {
  filter: "table",
  replacement: (_content, node) => tableToMarkdown(node)
});

function tableToMarkdown(table) {
  const rows = [...table.querySelectorAll("tr")].map((row) =>
    [...row.children]
      .filter((cell) => cell.matches("th, td"))
      .map((cell) => normalizeTableCell(cell.textContent || ""))
  );
  if (!rows.length) return "";

  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => [
    ...row,
    ...Array(Math.max(0, columnCount - row.length)).fill("")
  ]);
  const [head, ...body] = normalizedRows;
  const separator = Array(columnCount).fill("---");
  const markdownRows = [head, separator, ...body].map((row) => `| ${row.join(" | ")} |`);
  return `\n\n${markdownRows.join("\n")}\n\n`;
}

function normalizeTableCell(value) {
  return value.replace(/\s+/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").trim();
}

const state = {
  markdown: SAMPLE_MARKDOWN,
  fileHandle: null,
  directoryHandle: null,
  fileName: "Untitled.md",
  documentKey: "sample:untitled",
  documentStack: [],
  parsed: null,
  selectedId: null,
  editingItemId: null,
  currentScopeId: "scope:root",
  scopeStack: ["scope:root"],
  zoom: 1,
  viewportOffsetX: 0,
  viewportOffsetY: 0,
  hasSavedLayout: false,
  hasSavedViewport: false,
  hasInitialFit: false,
  isSpacePressed: false,
  expandedLayerIds: new Set(),
  gridFrame: null,
  itemStates: {},
  localImageUrls: new Map(),
  cardEditors: new Map(),
  saveTimer: null,
  layoutSaveTimer: null,
  isAutoSaving: false,
  hasPendingAutoSave: false
};

const pendingLaunch = {
  fileHandle: null,
  isInitializing: true
};

const els = {
  workspace: document.querySelector(".workspace"),
  canvasArea: document.querySelector("#canvas-area"),
  gridLayer: document.querySelector("#grid-layer"),
  stage: document.querySelector("#stage"),
  stageSize: document.querySelector("#stage-size"),
  stageScroll: document.querySelector("#stage-scroll"),
  layerPanel: document.querySelector("#layer-panel"),
  layerTree: document.querySelector("#layer-tree"),
  layerResize: document.querySelector("#layer-resize"),
  breadcrumbs: document.querySelector("#breadcrumbs"),
  scopeTitle: document.querySelector("#scope-title"),
  scopeMeta: document.querySelector("#scope-meta"),
  fileLabel: document.querySelector("#file-label"),
  itemCount: document.querySelector("#item-count"),
  statusText: document.querySelector("#status-text"),
  zoomStatus: document.querySelector("#zoom-status"),
  zoomReset: document.querySelector("#zoom-reset"),
  layersExpand: document.querySelector("#layers-expand"),
  layerCollapse: document.querySelector("#layer-collapse")
};

const db = {
  unavailableReason: null,
  open() {
    if (this.unavailableReason) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open("tourmaline-chrome", 2);
      } catch (error) {
        this.unavailableReason = error.message;
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        const stores = request.result.objectStoreNames;
        if (!stores.contains("layouts")) request.result.createObjectStore("layouts");
        if (!stores.contains("documents")) request.result.createObjectStore("documents");
        if (!stores.contains("handles")) request.result.createObjectStore("handles");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        this.unavailableReason = request.error?.message || "IndexedDB is unavailable.";
        resolve(null);
      };
    });
  },
  async get(store, key) {
    try {
      const database = await this.open();
      if (!database) return null;
      return await new Promise((resolve, reject) => {
        const tx = database.transaction(store, "readonly");
        const request = tx.objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => database.close();
      });
    } catch (error) {
      this.unavailableReason = error.message;
      return null;
    }
  },
  async set(store, key, value) {
    try {
      const database = await this.open();
      if (!database) return false;
      return await new Promise((resolve, reject) => {
        const tx = database.transaction(store, "readwrite");
        tx.objectStore(store).put(value, key);
        tx.oncomplete = () => {
          database.close();
          resolve(true);
        };
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      this.unavailableReason = error.message;
      return false;
    }
  }
};

if (els.workspace && els.stage && document.querySelector("#open-file")) {
  init();
}

async function init() {
  bindEvents();
  bindLaunchQueue();
  const loadedFromLaunch = await loadMarkdownFromLaunchQueue();
  const loadedFromContentScript = loadedFromLaunch ? false : await loadMarkdownFromContentScript();
  const loadedFromUrl = loadedFromLaunch || loadedFromContentScript ? false : await loadMarkdownFromUrlParam();
  if (!loadedFromLaunch && !loadedFromContentScript && !loadedFromUrl) {
    await loadPersistedSample();
  }
  await loadPersistedHandles();
  await loadLayout();
  await reparseAndRender();
  requestAnimationFrame(() => {
    fitInitialViewport();
    renderGrid();
  });
  pendingLaunch.isInitializing = false;
}

function bindEvents() {
  document.querySelector("#open-file").addEventListener("click", openMarkdownFile);
  document.querySelector("#save-file").addEventListener("click", saveMarkdownFile);
  document.querySelector("#zoom-in").addEventListener("click", () => setZoom(state.zoom + 0.1, getViewportAnchor()));
  document.querySelector("#zoom-out").addEventListener("click", () => setZoom(state.zoom - 0.1, getViewportAnchor()));
  document.querySelector("#zoom-reset").addEventListener("click", () => setZoom(1, getViewportAnchor()));
  document.querySelector("#fit-view").addEventListener("click", fitView);
  els.layersExpand.addEventListener("click", toggleExpandAllLayers);
  els.layerCollapse.addEventListener("click", toggleLayerPanel);
  bindCanvasPan();
  bindLayerResize();
  bindKeyboardShortcuts();
  els.stageScroll.addEventListener("scroll", scheduleGridRender);
  new ResizeObserver(() => {
    enforceZoomBounds();
    normalizeViewportPresentation();
    scheduleGridRender();
  }).observe(els.canvasArea);
}

function bindLaunchQueue() {
  if (!("launchQueue" in window)) return;

  window.launchQueue.setConsumer((launchParams) => {
    const [fileHandle] = launchParams.files || [];
    if (!fileHandle) return;

    if (pendingLaunch.isInitializing) {
      pendingLaunch.fileHandle = fileHandle;
      return;
    }

    loadFromFileHandle(fileHandle).catch((error) => {
      setStatus(`Could not open launched file: ${error.message}`);
    });
  });
}

async function loadMarkdownFromLaunchQueue() {
  if (!pendingLaunch.fileHandle) return false;
  await loadFromFileHandle(pendingLaunch.fileHandle);
  pendingLaunch.fileHandle = null;
  return true;
}

async function loadPersistedSample() {
  const saved = await db.get("documents", state.documentKey);
  if (saved?.markdown) {
    state.markdown = saved.markdown;
  }
}

async function loadMarkdownFromContentScript() {
  const file = window.__TOURMALINE_FILE__;
  if (!file?.fileUrl) return false;

  state.fileHandle = null;
  state.fileName = getMarkdownFileName(file.fileName, file.fileUrl);
  state.markdown = await getContentScriptMarkdown(file);
  state.documentKey = `url:${file.fileUrl}`;
  state.documentStack = [];
  state.hasInitialFit = false;
  setStatus(`Opened ${file.fileUrl} (${state.markdown.length} chars)`);
  return true;
}

async function getContentScriptMarkdown(file) {
  const markdown = file.markdown || "";
  if (markdown.trim()) return markdown;

  try {
    const url = new URL(file.fileUrl);
    if (!/^https?:$/.test(url.protocol)) return markdown;
    const response = await fetch(url.href, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    setStatus(`Could not read Markdown URL: ${error.message}`);
    return markdown;
  }
}

async function loadMarkdownFromUrlParam() {
  const params = new URLSearchParams(location.search);
  const fileUrl = params.get("file") || params.get("md");
  if (!fileUrl) return false;

  try {
    const url = new URL(fileUrl, location.href);
    if (url.protocol !== "file:") {
      setStatus("Only file:// Markdown URLs are supported in this mode.");
      return false;
    }

    const response = await fetch(url.href);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    state.fileHandle = null;
    state.fileName = decodeURIComponent(url.pathname.split(/[\\/]/).filter(Boolean).pop() || "Markdown.md");
    state.markdown = await response.text();
    state.documentKey = `url:${url.href}`;
    state.documentStack = [];
    state.hasInitialFit = false;
    setStatus(`Opened ${url.href}`);
    return true;
  } catch (error) {
    setStatus(`Could not open Markdown URL: ${error.message}`);
    return false;
  }
}

async function openMarkdownFile() {
  if (!window.showOpenFilePicker) {
    setStatus("File System Access API is not available in this browser.");
    return;
  }
  const [handle] = await window.showOpenFilePicker({
    id: MARKDOWN_PICKER_ID,
    startIn: getPickerStartIn(),
    multiple: false,
    types: [{ description: "Markdown", accept: { "text/markdown": [".md", ".markdown"] } }]
  });
  await loadFromFileHandle(handle);
}

async function loadFromFileHandle(handle) {
  const file = await handle.getFile();
  state.fileHandle = handle;
  state.fileName = file.name;
  state.markdown = await file.text();
  state.documentKey = getDocumentIdentity(file);
  state.documentStack = [];
  state.hasInitialFit = false;
  await persistHandles();
  await loadLayout();
  await reparseAndRender();
  setStatus(`Opened ${file.name}`);
}

async function saveMarkdownFile() {
  try {
    flushActiveEditor({ reparse: false });
    if (shouldDownloadOnSave()) {
      const filename = await downloadMarkdownWithExtension();
      setStatus(`Downloaded ${filename}.`);
      return;
    }
    if (!state.fileHandle) {
      if (state.directoryHandle) {
        const handle = await state.directoryHandle.getFileHandle(state.fileName || "Untitled.md", { create: true });
        state.fileHandle = handle;
        await persistHandles();
        if (await writeMarkdownToFileHandle(handle)) setStatus(`Saved ${state.fileName} in linked folder.`);
        return;
      }
      const handle = await requestSaveFileHandle();
      if (handle === undefined) return;
      if (handle) {
        state.fileHandle = handle;
        state.fileName = handle.name || state.fileName;
        if (shouldRetargetDocumentIdentity()) state.documentKey = getDocumentIdentity({ name: state.fileName });
        await persistHandles();
        renderShell();
        await saveLayout();
        if (await writeMarkdownToFileHandle(handle)) setStatus(`Saved ${state.fileName}`);
        return;
      }
      await db.set("documents", state.documentKey, { markdown: state.markdown, updatedAt: Date.now() });
      await downloadMarkdownFallback();
      setStatus("Saved a browser copy and downloaded the Markdown file.");
      return;
    }
    if (await writeMarkdownToFileHandle(state.fileHandle)) setStatus(`Saved ${state.fileName}`);
  } catch (error) {
    setStatus(`Save failed: ${error.message}`);
  }
}

function shouldDownloadOnSave() {
  if (state.fileHandle || state.directoryHandle) return false;
  if (!state.documentKey.startsWith("url:")) return false;
  try {
    return /^https?:$/.test(new URL(state.documentKey.slice(4)).protocol);
  } catch {
    return false;
  }
}

async function requestSaveFileHandle() {
  if (!window.showSaveFilePicker) return null;
  try {
    return await window.showSaveFilePicker({
      id: MARKDOWN_PICKER_ID,
      startIn: getPickerStartIn(),
      suggestedName: state.fileName || "Untitled.md",
      types: [{ description: "Markdown", accept: { "text/markdown": [".md", ".markdown"] } }]
    });
  } catch (error) {
    if (error?.name !== "AbortError") setStatus(`Could not choose save location: ${error.message}`);
    return undefined;
  }
}

async function writeMarkdownToFileHandle(handle) {
  const permission = await ensureWritable(handle);
  if (!permission) {
    setStatus("Write permission was not granted.");
    return false;
  }
  const writable = await handle.createWritable();
  await writable.write(state.markdown);
  await writable.close();
  return true;
}

async function downloadMarkdownFallback() {
  const filename = getMarkdownFileName(state.fileName, getCurrentUrlDocumentSource());
  if (canUseExtensionRuntime()) return Boolean(await downloadMarkdownWithExtension(filename));

  return downloadMarkdownViaAnchor(filename);
}

async function downloadMarkdownWithExtension(filename = getMarkdownFileName(state.fileName, getCurrentUrlDocumentSource())) {
  if (!canUseExtensionRuntime()) {
    throw new Error("Extension download API is unavailable in this page.");
  }
  const response = await sendExtensionMessage({
    type: "tourmaline-download-markdown",
    fileName: filename,
    sourceUrl: getCurrentUrlDocumentSource(),
    markdown: state.markdown
  });
  if (response?.ok && response.filename) return response.filename;
  throw new Error(response?.error || "Extension download did not complete.");
}

function canUseExtensionRuntime() {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage);
}

function sendExtensionMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function downloadMarkdownViaAnchor(filename) {
  const blob = new Blob([state.markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 1000);
  return true;
}

function getCurrentUrlDocumentSource() {
  return state.documentKey.startsWith("url:") ? state.documentKey.slice(4) : "";
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

function getPickerStartIn() {
  return state.directoryHandle || "documents";
}

async function loadPersistedHandles() {
  try {
    const saved = await db.get("handles", state.documentKey);
    if (!saved) return;
    if (saved.fileHandle) {
      state.fileHandle = saved.fileHandle;
      state.fileName = saved.fileName || saved.fileHandle.name || state.fileName;
    }
    if (saved.directoryHandle) state.directoryHandle = saved.directoryHandle;
  } catch (error) {
    setStatus(`Could not restore file access: ${error.message}`);
  }
}

async function persistHandles() {
  try {
    if (!state.fileHandle && !state.directoryHandle) return;
    await db.set("handles", state.documentKey, {
      fileHandle: state.fileHandle,
      directoryHandle: state.directoryHandle,
      fileName: state.fileName,
      updatedAt: Date.now()
    });
  } catch (error) {
    setStatus(`Could not remember file access: ${error.message}`);
  }
}

function shouldRetargetDocumentIdentity() {
  return state.documentKey.startsWith("sample:") || state.documentKey.startsWith("doc:");
}

async function ensureWritable(handle) {
  const options = { mode: "readwrite" };
  if ((await handle.queryPermission(options)) === "granted") return true;
  return (await handle.requestPermission(options)) === "granted";
}

function scheduleDocumentSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(autoSaveDocument, 800);
}

function flushActiveEditor(options = {}) {
  const itemId = state.editingItemId;
  const editor = itemId ? state.cardEditors.get(itemId) : null;
  const item = state.parsed?.items.find((candidate) => candidate.id === itemId);
  if (editor && item) updateItemMarkdownFromEditor(editor, item, options);
}

function scheduleLayoutSave() {
  clearTimeout(state.layoutSaveTimer);
  state.layoutSaveTimer = setTimeout(saveLayout, 300);
}

async function autoSaveDocument() {
  if (state.isAutoSaving) {
    state.hasPendingAutoSave = true;
    return;
  }
  state.isAutoSaving = true;
  try {
    do {
      state.hasPendingAutoSave = false;
      await persistDocumentChange();
    } while (state.hasPendingAutoSave);
  } finally {
    state.isAutoSaving = false;
  }
}

async function persistDocumentChange() {
  try {
    if (state.fileHandle) {
      if (await writeMarkdownToFileHandle(state.fileHandle)) setStatus(`Auto-saved ${state.fileName}`);
      return;
    }
    if (state.directoryHandle) {
      const handle = await state.directoryHandle.getFileHandle(state.fileName || "Untitled.md", { create: true });
      state.fileHandle = handle;
      await persistHandles();
      if (await writeMarkdownToFileHandle(handle)) setStatus(`Auto-saved ${state.fileName} in linked folder.`);
      return;
    }
    await db.set("documents", state.documentKey, { markdown: state.markdown, updatedAt: Date.now() });
  } catch (error) {
    setStatus(`Auto-save failed: ${error.message}`);
  }
}

async function reparseAndRender() {
  const previousItems = state.parsed?.items ?? [];
  const previousFrames = previousItems
    .map((item) => ({ item, frame: state.itemStates[item.id] }))
    .filter((entry) => entry.frame);
  const previousSelectedItem = previousItems.find((item) => item.id === state.selectedId);
  const previousEditingItem = previousItems.find((item) => item.id === state.editingItemId);
  const previousScope = getCurrentScopeSnapshot();
  const previousScopeTitlePath = getCurrentScopeTitlePath();
  state.parsed = parseMarkdown(state.markdown);
  restoreScope(previousScope, previousScopeTitlePath);
  migrateItemStates(previousFrames);
  const previousSelection = state.selectedId;
  if (previousSelectedItem && !findRenderableById(previousSelection)) {
    const nextSelectedItem = findMatchingItem(previousSelectedItem);
    if (nextSelectedItem) state.selectedId = nextSelectedItem.id;
  }
  if (previousEditingItem && !findRenderableById(state.editingItemId)) {
    const nextEditingItem = findMatchingItem(previousEditingItem);
    if (nextEditingItem) state.editingItemId = nextEditingItem.id;
  }
  ensureItemStates();
  if (!findRenderableById(state.selectedId)) {
    state.selectedId = state.parsed.items[0]?.id ?? null;
  }
  if (!findRenderableById(state.editingItemId)) {
    state.editingItemId = null;
  }
  renderShell();
  await renderCanvas();
  setStatus(`Loaded ${state.fileName}: ${state.markdown.length} chars, ${state.parsed.items.length} items.`);
  scheduleLayoutSave();
  if (!state.hasInitialFit) {
    requestAnimationFrame(fitInitialViewport);
  }
}

function migrateItemStates(previousFrames) {
  if (!previousFrames.length) return;
  const usedFrames = new Set();
  state.parsed.items.forEach((item) => {
    if (state.itemStates[item.id]) return;
    const availableFrames = previousFrames.filter((entry) => !usedFrames.has(entry));
    const match = availableFrames.find((entry) => entry.item.startLine === item.startLine && entry.item.endLine === item.endLine)
      ?? availableFrames.find((entry) => entry.item.startLine === item.startLine && entry.item.kind === item.kind && entry.item.level === item.level)
      ?? findNearestPreviousItemFrame(availableFrames, item);
    if (match?.frame) state.itemStates[item.id] = { ...match.frame };
    if (match) usedFrames.add(match);
  });
}

function findNearestPreviousItemFrame(previousFrames, item) {
  const candidates = previousFrames.filter((entry) => entry.item.kind === item.kind && entry.item.level === item.level && entry.item.title === item.title);
  if (!candidates.length) return null;
  return candidates.reduce((closest, entry) => {
    const distance = Math.abs(entry.item.startLine - item.startLine);
    const closestDistance = Math.abs(closest.item.startLine - item.startLine);
    return distance < closestDistance ? entry : closest;
  });
}

function findMatchingItem(previousItem) {
  return state.parsed.items.find((item) => item.startLine === previousItem.startLine && item.endLine === previousItem.endLine)
    ?? state.parsed.items.find((item) => item.startLine === previousItem.startLine && item.kind === previousItem.kind && item.level === previousItem.level)
    ?? findNearestPreviousItemFrame(state.parsed.items.map((item) => ({ item })), previousItem)?.item
    ?? null;
}

function getCurrentScopeTitlePath() {
  if (!state.parsed?.scopes) return [];
  return state.scopeStack.map((scopeId) => state.parsed.scopes[scopeId]?.title).filter(Boolean);
}

function getCurrentScopeSnapshot() {
  const scope = state.parsed?.scopes?.[state.currentScopeId];
  if (!scope) return null;
  return {
    id: scope.id,
    title: scope.title,
    startLine: scope.startLine,
    endLine: scope.endLine,
    headingLevel: scope.headingLevel,
    depth: state.scopeStack.length
  };
}

function restoreScope(previousScope, titlePath) {
  if (!state.parsed?.scopes) return;
  if (previousScope && state.parsed.scopes[previousScope.id]) {
    setCurrentScopeStack(buildScopeStack(previousScope.id));
    return;
  }
  const lineMatchedScope = previousScope ? findScopeByPreviousPosition(previousScope) : null;
  if (lineMatchedScope) {
    setCurrentScopeStack(buildScopeStack(lineMatchedScope.id));
    return;
  }
  restoreScopeFromTitlePath(titlePath);
}

function findScopeByPreviousPosition(previousScope) {
  const scopes = Object.values(state.parsed.scopes);
  return scopes.find((scope) =>
    scope.startLine === previousScope.startLine &&
    scope.headingLevel === previousScope.headingLevel
  ) ?? scopes
    .filter((scope) => scope.headingLevel === previousScope.headingLevel && scope.title === previousScope.title)
    .sort((a, b) => Math.abs(a.startLine - previousScope.startLine) - Math.abs(b.startLine - previousScope.startLine))[0]
    ?? null;
}

function setCurrentScopeStack(scopeStack) {
  state.scopeStack = scopeStack.length ? scopeStack : ["scope:root"];
  state.currentScopeId = state.scopeStack[state.scopeStack.length - 1];
  syncCurrentScope();
}

function buildScopeStack(scopeId) {
  const stack = [];
  let currentId = scopeId;
  while (currentId && state.parsed.scopes[currentId]) {
    stack.unshift(currentId);
    if (currentId === "scope:root") break;
    currentId = findParentScopeId(currentId);
  }
  return stack[0] === "scope:root" ? stack : ["scope:root", ...stack];
}

function findParentScopeId(scopeId) {
  return Object.values(state.parsed.scopes).find((scope) =>
    scope.items.some((item) => item.childScopeId === scopeId)
  )?.id ?? null;
}

function restoreScopeFromTitlePath(titlePath) {
  if (!titlePath.length || !state.parsed?.scopes) return;
  const nextStack = ["scope:root"];
  let currentScope = state.parsed.scopes["scope:root"];
  for (const title of titlePath.slice(1)) {
    const nextItem = currentScope?.items.find((item) => item.childScopeId && item.title === title);
    const nextScope = nextItem ? state.parsed.scopes[nextItem.childScopeId] : null;
    if (!nextScope) break;
    nextStack.push(nextScope.id);
    currentScope = nextScope;
  }
  const nextScopeId = nextStack[nextStack.length - 1];
  setCurrentScopeStack(nextStack);
}

function parseMarkdown(markdown) {
  const frontmatter = getFrontmatterInfo(markdown);
  const body = frontmatter.body;
  const bodyLines = body.split(/\r?\n/);
  const allLines = markdown.split(/\r?\n/);
  const headings = [];
  bodyLines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) headings.push({ line: frontmatter.lineOffset + index, level: match[1].length, title: match[2].trim() });
  });

  const scopes = {};
  buildScope("scope:root", "Document", frontmatter.lineOffset, allLines.length - 1, null);
  if (!scopes[state.currentScopeId]) {
    state.currentScopeId = "scope:root";
    state.scopeStack = ["scope:root"];
  }
  const current = scopes[state.currentScopeId] ?? scopes["scope:root"];
  return { title: current.title, scopes, items: current.items, tree: current.tree };

  function buildScope(scopeId, title, startLine, endLine, openingHeading) {
    const scopeHeadings = headings.filter((heading) => heading.line >= startLine && heading.line <= endLine);
    const items = [];
    if (openingHeading) {
      items.push(createItem(`orphan:${scopeId}:scope-heading`, "orphan", openingHeading.title, openingHeading.line, openingHeading.line, allLines[openingHeading.line], openingHeading.level));
    }
    if (!scopeHeadings.length) {
      const content = allLines.slice(startLine, endLine + 1).join("\n").trim();
      if (content) items.push(createItem(`orphan:${scopeId}:body`, "orphan", title, startLine, endLine, content, 1));
      scopes[scopeId] = {
        id: scopeId,
        title,
        startLine,
        endLine,
        depth: null,
        headingLevel: openingHeading?.level ?? 0,
        canvasHeadingLevel: clamp((openingHeading?.level ?? 0) + 1, 1, 6),
        items,
        tree: []
      };
      scopes[scopeId].tree = buildLayerTreeForItems(items, scopes);
      return scopes[scopeId];
    }
    const minLevel = Math.min(...scopeHeadings.map((heading) => heading.level));
    const shellHeadings = scopeHeadings.filter((heading) => heading.level === minLevel);
    const firstShell = shellHeadings[0];
    if (!openingHeading && firstShell.line > startLine) {
      const prefix = allLines.slice(startLine, firstShell.line).join("\n").trim();
      if (prefix) items.push(createItem(`orphan:${scopeId}:prefix`, "orphan", "Intro", startLine, firstShell.line - 1, prefix, 1));
    }
    shellHeadings.forEach((heading, index) => {
      const next = shellHeadings[index + 1];
      const sectionEnd = next ? next.line - 1 : endLine;
      const content = allLines.slice(heading.line, sectionEnd + 1).join("\n").trim();
      const id = `section:${scopeId}:${slugSafe(heading.title)}:${heading.line}`;
      const childScopeId = `scope:${scopeId}:${slugSafe(heading.title)}:${heading.line}`;
      const item = createItem(id, "section", heading.title, heading.line, sectionEnd, content, heading.level);
      item.childScopeId = childScopeId;
      items.push(item);
      buildScope(childScopeId, heading.title, heading.line + 1, sectionEnd, heading);
    });
    scopes[scopeId] = {
      id: scopeId,
      title: title === "Document" ? shellHeadings[0]?.title ?? title : title,
      startLine,
      endLine,
      depth: minLevel,
      headingLevel: openingHeading?.level ?? 0,
      canvasHeadingLevel: clamp(minLevel, 1, 6),
      items,
      tree: []
    };
    scopes[scopeId].tree = buildLayerTreeForItems(items, scopes);
    return scopes[scopeId];
  }
}

function getFrontmatterInfo(markdown) {
  if (!markdown.startsWith("---")) return { body: markdown, lineOffset: 0 };
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return { body: markdown, lineOffset: 0 };
  const bodyStart = markdown.indexOf("\n", end + 4) + 1;
  return {
    body: markdown.slice(bodyStart),
    lineOffset: markdown.slice(0, bodyStart).split(/\r?\n/).length - 1
  };
}

function findNextBoundary(headings, index) {
  const current = headings[index];
  return headings.slice(index + 1).find((candidate) => candidate.level <= current.level);
}

function slugPath(headings, index) {
  const current = headings[index];
  const ancestors = [];
  for (let i = 0; i <= index; i += 1) {
    const heading = headings[i];
    if (i === index || heading.line < current.line) {
      while (ancestors.length && ancestors[ancestors.length - 1].level >= heading.level) ancestors.pop();
      ancestors.push(heading);
    }
  }
  return ancestors.map((heading) => slugSafe(heading.title)).join("/");
}

function createItem(id, kind, title, startLine, endLine, content, level) {
  const item = { id, kind, title, startLine, endLine, content, level, embeds: [] };
  item.embeds = extractEmbeds(content, startLine, id);
  return item;
}

function buildLayerTree(items) {
  const root = [];
  const stack = [];
  for (const item of items) {
    const node = { ...item, children: item.embeds.map((embed) => ({ ...embed, kind: "embed", children: [] })) };
    if (item.kind === "orphan") {
      root.push(node);
      continue;
    }
    while (stack.length && stack[stack.length - 1].level >= item.level) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else root.push(node);
    stack.push(node);
  }
  return root;
}

function buildLayerTreeForItems(items, scopes) {
  return items.map((item) => {
    const childScope = item.childScopeId ? scopes[item.childScopeId] : null;
    const childNodes = (childScope?.tree ?? []).filter((node) => !node.id.endsWith(":scope-heading"));
    return {
      ...item,
      children: [
        ...childNodes,
        ...item.embeds.map((embed) => ({ ...embed, kind: "embed", children: [] }))
      ]
    };
  });
}

function extractEmbeds(markdown, lineOffset, ownerId) {
  const embeds = [];
  const patterns = [
    /!\[\[([^\]]+)\]\]/g,
    /!\[([^\]]*)\]\(([^)]+)\)/g
  ];
  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) {
      const rawTarget = match[2] ?? match[1];
      const target = rawTarget.split("|")[0].trim();
      const before = markdown.slice(0, match.index);
      const line = lineOffset + before.split(/\r?\n/).length - 1;
      embeds.push({
        id: `embed:${ownerId}:${embeds.length}:${slugSafe(target)}`,
        ownerId,
        original: match[0],
        target,
        title: match[1] || target,
        label: match[1] || target,
        line,
        level: 99,
        isImage: isImageTarget(target)
      });
    }
  }
  return embeds;
}

function ensureItemStates() {
  const supportItems = state.parsed.items.filter((item) => item.kind !== "section");
  const sectionItems = state.parsed.items.filter((item) => item.kind === "section");
  const defaults = {};
  supportItems.forEach((item, index) => {
    defaults[item.id] = {
      x: -620,
      y: -240 + index * 190,
      width: DEFAULT_CARD_WIDTH,
      height: 140
    };
  });
  sectionItems.forEach((item, index) => {
    defaults[item.id] = {
      x: index * 460,
      y: -240,
      width: DEFAULT_CARD_WIDTH,
      height: DEFAULT_CARD_HEIGHT
    };
  });
  state.parsed.items.forEach((item) => {
    if (state.itemStates[item.id]) return;
    state.itemStates[item.id] = defaults[item.id];
  });
}

function renderShell() {
  els.scopeTitle.textContent = state.parsed.title;
  els.scopeMeta.textContent = `${state.parsed.items.length} items`;
  els.fileLabel.textContent = state.fileName;
  els.itemCount.textContent = `${state.parsed.items.length} items`;
  renderBreadcrumbs();
  renderLayers();
  updateZoomText();
}

function renderBreadcrumbs() {
  els.breadcrumbs.replaceChildren();
  state.documentStack.forEach((entry, index) => {
    els.breadcrumbs.append(button("breadcrumb", entry.fileName || "Document", () => restoreDocumentFromTrail(index)));
    els.breadcrumbs.append(span("breadcrumb-sep", "/"));
  });
  state.scopeStack.forEach((scopeId, index) => {
    const scope = state.parsed.scopes[scopeId];
    const label = index === 0 ? state.fileName : scope?.title ?? "Scope";
    els.breadcrumbs.append(button(`breadcrumb ${index === state.scopeStack.length - 1 ? "current" : ""}`, label, () => enterScope(scopeId, index)));
    if (index < state.scopeStack.length - 1) els.breadcrumbs.append(span("breadcrumb-sep", "/"));
  });
}

async function navigateToReference(rawTarget, source = "link") {
  const target = normalizeReferenceTarget(rawTarget);
  if (!target) return false;
  if (/^https?:/i.test(target)) {
    window.open(target, "_blank", "noopener,noreferrer");
    return true;
  }

  if (isMarkdownTarget(target) && !isCurrentMarkdownTarget(target)) {
    return loadLinkedMarkdownDocument(target, source);
  }

  const scope = resolveReferenceScope(target);
  if (scope) {
    await enterScope(scope.id);
    setStatus(`Opened ${source}: ${scope.title}`);
    return true;
  }

  setStatus(`Could not enter ${source}: ${target}`);
  return false;
}

async function loadLinkedMarkdownDocument(target, source = "link") {
  const url = resolveReferenceUrl(target);
  if (!url) {
    setStatus(`Could not resolve ${source}: ${target}`);
    return false;
  }

  const markdownUrl = stripUrlSubpath(url);
  const subpath = url.hash ? decodeURIComponent(url.hash.slice(1)) : "";
  try {
    flushActiveEditor({ reparse: false });
    await saveLayout();
    const markdown = await readMarkdownUrl(markdownUrl.href);
    state.documentStack.push(createDocumentSnapshot());
    state.fileHandle = null;
    state.directoryHandle = null;
    state.fileName = getMarkdownFileName("", markdownUrl.href);
    state.markdown = markdown;
    state.documentKey = `url:${markdownUrl.href}`;
    state.currentScopeId = "scope:root";
    state.scopeStack = ["scope:root"];
    state.selectedId = null;
    state.editingItemId = null;
    state.hasInitialFit = false;
    await loadPersistedHandles();
    await loadLayout();
    await reparseAndRender();
    if (subpath) await enterResolvedSubpath(subpath, source);
    setStatus(`Opened ${source}: ${state.fileName}`);
    return true;
  } catch (error) {
    setStatus(`Could not open ${source}: ${target} (${error.message})`);
    return false;
  }
}

async function readMarkdownUrl(url) {
  if (canUseExtensionRuntime()) {
    const response = await sendExtensionMessage({
      type: "tourmaline-read-markdown-url",
      url
    });
    if (response?.ok) return String(response.markdown ?? "");
    throw new Error(response?.error || "Extension could not read the Markdown file.");
  }

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
}

function createDocumentSnapshot() {
  return {
    markdown: state.markdown,
    fileName: state.fileName,
    documentKey: state.documentKey,
    fileHandle: state.fileHandle,
    directoryHandle: state.directoryHandle,
    currentScopeId: state.currentScopeId,
    scopeStack: [...state.scopeStack],
    selectedId: state.selectedId
  };
}

async function restoreDocumentFromTrail(index) {
  const snapshot = state.documentStack[index];
  if (!snapshot) return;
  flushActiveEditor({ reparse: false });
  await saveLayout();
  state.documentStack = state.documentStack.slice(0, index);
  await restoreDocumentSnapshot(snapshot);
}

async function restoreDocumentSnapshot(snapshot) {
  state.markdown = snapshot.markdown;
  state.fileName = snapshot.fileName;
  state.documentKey = snapshot.documentKey;
  state.fileHandle = snapshot.fileHandle ?? null;
  state.directoryHandle = snapshot.directoryHandle ?? null;
  state.currentScopeId = snapshot.currentScopeId || "scope:root";
  state.scopeStack = snapshot.scopeStack?.length ? [...snapshot.scopeStack] : ["scope:root"];
  state.selectedId = snapshot.selectedId ?? null;
  state.editingItemId = null;
  state.hasInitialFit = false;
  await loadLayout();
  await reparseAndRender();
}

async function enterResolvedSubpath(subpath, source) {
  const scope = resolveReferenceScope(`#${subpath}`);
  if (!scope) {
    setStatus(`Opened ${source}, but could not find #${subpath}`);
    return false;
  }
  await enterScope(scope.id);
  return true;
}

function normalizeReferenceTarget(rawTarget) {
  let target = String(rawTarget ?? "").trim();
  if (!target) return "";
  if ((target.startsWith("<") && target.endsWith(">")) || (target.startsWith("[[") && target.endsWith("]]"))) {
    target = target.slice(target.startsWith("[[") ? 2 : 1, target.endsWith("]]") ? -2 : -1);
  }
  target = target.split("|")[0].trim();
  try {
    target = decodeURIComponent(target);
  } catch {
    // Keep the original target when it contains non-URI markdown text.
  }
  return target;
}

function resolveReferenceScope(target) {
  if (!state.parsed?.scopes) return null;
  const subpath = getReferenceSubpath(target);
  if (!subpath) return null;
  const normalizedSubpath = normalizeReferenceName(subpath);
  return Object.values(state.parsed.scopes).find((scope) =>
    scope.id !== "scope:root" && (
      normalizeReferenceName(scope.title) === normalizedSubpath ||
      slugSafe(scope.title) === normalizedSubpath
    )
  ) ?? null;
}

function getReferenceSubpath(target) {
  const hashIndex = target.indexOf("#");
  if (hashIndex !== -1) {
    const fileTarget = target.slice(0, hashIndex).trim();
    return isCurrentMarkdownTarget(fileTarget) ? target.slice(hashIndex + 1).trim() : null;
  }
  if (isCurrentMarkdownTarget(target)) return "";
  return target.trim();
}

function resolveReferenceUrl(target) {
  try {
    return new URL(target, getCurrentUrlDocumentSource() || location.href);
  } catch {
    return null;
  }
}

function stripUrlSubpath(url) {
  const nextUrl = new URL(url.href);
  nextUrl.hash = "";
  return nextUrl;
}

function isCurrentMarkdownTarget(target) {
  const cleanTarget = target.split("#")[0].split("?")[0].replace(/\\/g, "/").trim();
  if (!cleanTarget) return true;
  const targetName = cleanTarget.split("/").filter(Boolean).pop();
  return Boolean(targetName && targetName.toLowerCase() === state.fileName.toLowerCase());
}

function isMarkdownTarget(target) {
  const cleanTarget = target.split("#")[0].split("?")[0];
  return /\.(md|markdown)$/i.test(cleanTarget);
}

function normalizeReferenceName(value) {
  return String(value ?? "")
    .trim()
    .replace(/^#+/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function renderLayers() {
  els.layerTree.replaceChildren(...state.parsed.tree.map((node) => renderLayerNode(node)));
  revealSelectedLayerRow();
  updateLayerPanelButtons();
}

function renderLayerNode(node) {
  const wrapper = document.createElement("div");
  wrapper.className = "layer-item";
  const hasChildren = Boolean(node.children?.length);
  const isExpanded = !hasChildren || state.expandedLayerIds.has(node.id);
  const row = button(`layer-row ${hasChildren ? "drillable" : ""} ${node.id === state.selectedId ? "selected" : ""}`, "", (event) => {
    selectItem(node.id, { revealOnCanvas: true });
    if ((event.ctrlKey || event.metaKey) && node.kind === "embed") {
      navigateToReference(node.target, "embed");
      return;
    }
    if ((event.ctrlKey || event.metaKey) && node.childScopeId) {
      enterScope(node.childScopeId);
      return;
    }
    if (hasChildren && !isExpanded && !(event.ctrlKey || event.metaKey)) {
      state.expandedLayerIds.add(node.id);
      renderShell();
    }
  });
  row.dataset.layerNodeId = node.id;
  row.draggable = node.kind !== "embed";
  row.innerHTML = `
    <span class="layer-toggle">${hasChildren ? chevronSvg(isExpanded) : ""}</span>
    <span class="layer-glyph">${node.kind === "embed" ? embedSvg() : node.kind === "orphan" ? lineSvg() : cardSvg()}</span>
    <span class="layer-label"></span>
    <span class="layer-count">${hasChildren ? node.children.length : ""}</span>
  `;
  row.querySelector(".layer-label").textContent = node.title;
  const toggle = row.querySelector(".layer-toggle");
  toggle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!hasChildren) return;
    if (state.expandedLayerIds.has(node.id)) state.expandedLayerIds.delete(node.id);
    else state.expandedLayerIds.add(node.id);
    renderShell();
  });
  row.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    focusEditorLine(node.line ?? node.startLine ?? 0);
  });
  bindLayerReorder(row, node);
  wrapper.append(row);
  if (hasChildren && isExpanded) {
    const children = document.createElement("div");
    children.className = "layer-children";
    children.append(...node.children.map((child) => renderLayerNode(child)));
    wrapper.append(children);
  }
  return wrapper;
}

function expandLayerPathToItem(id) {
  const path = findLayerNodePathIds(state.parsed?.tree ?? [], id);
  path.slice(0, -1).forEach((nodeId) => state.expandedLayerIds.add(nodeId));
}

function findLayerNodePathIds(nodes, targetId, path = []) {
  for (const node of nodes) {
    const nextPath = [...path, node.id];
    if (node.id === targetId) return nextPath;
    const childPath = findLayerNodePathIds(node.children ?? [], targetId, nextPath);
    if (childPath.length) return childPath;
  }
  return [];
}

function revealSelectedLayerRow() {
  if (!state.selectedId) return;
  requestAnimationFrame(() => {
    const row = els.layerTree.querySelector(`[data-layer-node-id="${cssEscape(state.selectedId)}"]`);
    row?.scrollIntoView({ block: "nearest" });
  });
}

function bindLayerReorder(row, node) {
  row.addEventListener("dragstart", (event) => {
    if (node.kind === "embed") {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", node.id);
    row.classList.add("dragging");
  });
  row.addEventListener("dragend", () => {
    row.classList.remove("dragging", "drop-before", "drop-after");
  });
  row.addEventListener("dragover", (event) => {
    const draggedId = event.dataTransfer.getData("text/plain");
    if (!canReorderLayerNodes(draggedId, node.id)) return;
    event.preventDefault();
    const position = getLayerDropPosition(row, event);
    row.classList.toggle("drop-before", position === "before");
    row.classList.toggle("drop-after", position === "after");
  });
  row.addEventListener("dragleave", () => {
    row.classList.remove("drop-before", "drop-after");
  });
  row.addEventListener("drop", (event) => {
    const draggedId = event.dataTransfer.getData("text/plain");
    if (!canReorderLayerNodes(draggedId, node.id)) return;
    event.preventDefault();
    const position = getLayerDropPosition(row, event);
    row.classList.remove("drop-before", "drop-after");
    moveMarkdownBlock(draggedId, node.id, position);
  });
}

function getLayerDropPosition(row, event) {
  const rect = row.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function canReorderLayerNodes(draggedId, targetId) {
  if (!draggedId || !targetId || draggedId === targetId) return false;
  const dragged = state.parsed.items.find((item) => item.id === draggedId);
  const target = state.parsed.items.find((item) => item.id === targetId);
  return Boolean(dragged && target);
}

function toggleExpandAllLayers() {
  const ids = getExpandableLayerNodeIds(state.parsed?.tree ?? []);
  const hasCollapsed = ids.some((id) => !state.expandedLayerIds.has(id));
  if (hasCollapsed) ids.forEach((id) => state.expandedLayerIds.add(id));
  else ids.forEach((id) => state.expandedLayerIds.delete(id));
  renderShell();
}

function getExpandableLayerNodeIds(nodes) {
  const ids = [];
  const visit = (node) => {
    if (node.children?.length) {
      ids.push(node.id);
      node.children.forEach(visit);
    }
  };
  nodes.forEach(visit);
  return ids;
}

function toggleLayerPanel() {
  const collapsed = els.workspace.classList.toggle("layer-collapsed");
  els.layerCollapse.title = collapsed ? "Expand layer panel" : "Collapse layer panel";
  els.layerCollapse.setAttribute("aria-label", els.layerCollapse.title);
  els.layerCollapse.innerHTML = collapsed
    ? '<svg viewBox="0 0 16 16"><path d="M5 3v10M8 5l3 3-3 3"/></svg>'
    : '<svg viewBox="0 0 16 16"><path d="M5 3v10M11 5L8 8l3 3"/></svg>';
  requestAnimationFrame(() => {
    enforceZoomBounds();
    normalizeViewportPresentation();
    scheduleGridRender();
  });
}

function updateLayerPanelButtons() {
  const ids = getExpandableLayerNodeIds(state.parsed?.tree ?? []);
  const hasCollapsed = ids.some((id) => !state.expandedLayerIds.has(id));
  els.layersExpand.title = hasCollapsed ? "Expand all layers" : "Collapse all layers";
  els.layersExpand.setAttribute("aria-label", els.layersExpand.title);
  els.layersExpand.innerHTML = hasCollapsed
    ? '<svg viewBox="0 0 16 16"><path d="M4 5l4 4 4-4M4 10l4 4 4-4"/></svg>'
    : '<svg viewBox="0 0 16 16"><path d="M4 7l4-4 4 4M4 12l4-4 4 4"/></svg>';
}

async function renderCanvas() {
  destroyCardEditors();
  clearLocalImageUrls();
  els.stage.replaceChildren();
  for (const item of state.parsed.items) {
    const el = document.createElement("article");
    el.className = `${item.kind === "orphan" ? "orphan" : "card"} ${item.id === state.selectedId ? "selected" : ""} ${item.id === state.editingItemId ? "editing" : ""}`;
    el.dataset.itemId = item.id;
    if (item.childScopeId) el.dataset.childScopeId = item.childScopeId;
    applyFrame(el, state.itemStates[item.id]);
    const body = document.createElement("div");
    body.className = item.kind === "orphan" ? "orphan-body" : "card-body";
    const editor = document.createElement("div");
    editor.className = "editable-card-body";
    editor.dataset.itemId = item.id;
    editor.setAttribute("aria-label", `Edit ${item.title}`);
    if (item.kind === "orphan") {
      body.append(span("orphan-label", item.title), editor);
    } else {
      body.append(editor);
    }
    el.append(createResizeHandle(item.id));
    el.append(body);
    bindCardDrag(el, item.id);
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      const link = getEventLink(event);
      if (link && (event.ctrlKey || event.metaKey || !isEditingItem(item.id))) {
        event.preventDefault();
        navigateToReference(link.getAttribute("href"), "link");
        return;
      }
      if ((event.ctrlKey || event.metaKey) && item.childScopeId) {
        event.preventDefault();
        enterScope(item.childScopeId);
        return;
      }
      selectItem(item.id);
    });
    el.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      enterEditMode(item.id, event);
    });
    els.stage.append(el);
    const content = await renderMarkdownHtml(item.content, item);
    createCardEditor(editor, item, content);
  }
  setCardEditorsEditable();
  decorateEmbeds();
}

async function renderMarkdownHtml(markdown, item) {
  const html = markdownIt.render(await replaceEmbeds(markdown, item));
  return normalizeRenderedHeadingDepth(html, item);
}

async function replaceEmbeds(markdown, item) {
  let output = markdown;
  for (const embed of item.embeds) {
    const html = await renderEmbedHtml(embed);
    output = output.replace(embed.original, `\n\n${html}\n\n`);
  }
  return output;
}

async function renderEmbedHtml(embed) {
  const className = `selectable-embed${embed.id === state.selectedId ? " selected" : ""}`;
  const attrs = `data-item-id="${escapeAttribute(embed.id)}" data-embed-id="${escapeAttribute(embed.id)}" data-owner-id="${escapeAttribute(embed.ownerId)}" data-line="${embed.line}" data-markdown="${escapeAttribute(embed.original)}"`;
  if (embed.isImage) {
    const src = await resolveImageSource(embed.target);
    if (src) return `<img class="${className}" ${attrs} src="${escapeAttribute(src)}" alt="${escapeAttribute(embed.label)}" draggable="false">`;
    return `<div class="embed-pill ${className}" ${attrs}>Image unavailable: ${escapeHtml(embed.target)}</div>`;
  }
  return `<div class="embed-pill ${className}" ${attrs} label="${escapeAttribute(`File embed: ${embed.target}`)}">File embed: ${escapeHtml(embed.target)}</div>`;
}

async function resolveImageSource(target) {
  if (/^(https?:|data:|blob:)/i.test(target)) return target;
  const url = resolveReferenceUrl(target);
  if (url && /^(file|https?):$/i.test(url.protocol)) return url.href;
  if (!state.directoryHandle) return null;
  try {
    const parts = target.split(/[\\/]/).filter(Boolean);
    let handle = state.directoryHandle;
    for (const part of parts.slice(0, -1)) handle = await handle.getDirectoryHandle(part);
    const fileHandle = await handle.getFileHandle(parts[parts.length - 1]);
    const file = await fileHandle.getFile();
    const url = URL.createObjectURL(file);
    state.localImageUrls.set(target, url);
    return url;
  } catch {
    return null;
  }
}

function decorateEmbeds() {
  els.stage.querySelectorAll(".selectable-embed").forEach((element) => {
    element.addEventListener("pointerdown", (event) => {
      if (state.isSpacePressed || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      selectItem(element.dataset.embedId || element.dataset.itemId);
    }, true);
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        openEmbedTarget(element.dataset.embedId);
      }
    }, true);
    element.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openEmbedTarget(element.dataset.embedId);
    }, true);
  });
  els.stage.querySelectorAll("img").forEach((image) => {
    image.draggable = false;
  });
}

function createCardEditor(element, item, content) {
  const editor = new Editor({
    element,
    extensions: editorExtensions,
    content,
    editable: item.id === state.editingItemId,
    editorProps: {
      attributes: {
        "aria-label": `Edit ${item.title}`,
        spellcheck: "true"
      },
      handleDOMEvents: {
        pointerdown: (_view, event) => {
          if (state.editingItemId !== item.id) return false;
          event.stopPropagation();
          selectItem(item.id);
          return false;
        },
        click: (_view, event) => {
          if (state.editingItemId !== item.id) return false;
          event.stopPropagation();
          selectItem(item.id);
          return false;
        }
      }
    },
    onUpdate: ({ editor: currentEditor }) => {
      updateItemMarkdownFromEditor(currentEditor, item, { reparse: false });
    },
    onBlur: ({ editor: currentEditor }) => {
      updateItemMarkdownFromEditor(currentEditor, item, { reparse: false });
    }
  });
  state.cardEditors.set(item.id, editor);
}

function destroyCardEditors() {
  for (const editor of state.cardEditors.values()) {
    editor.destroy();
  }
  state.cardEditors.clear();
}

function enterEditMode(itemId, event = null) {
  const editor = state.cardEditors.get(itemId);
  if (!editor) return;
  state.editingItemId = itemId;
  setCardEditorsEditable();
  selectItem(itemId);
  focusEditorAtEvent(editor, event);
  updateCanvasSelection();
}

function exitEditMode(options = {}) {
  if (!state.editingItemId) return;
  const itemId = state.editingItemId;
  const editor = state.cardEditors.get(itemId);
  const item = state.parsed?.items.find((candidate) => candidate.id === itemId);
  state.editingItemId = null;
  if (editor && item) {
    updateItemMarkdownFromEditor(editor, item, { reparse: options.reparse ?? true });
  }
  setCardEditorsEditable();
  updateCanvasSelection();
}

function setCardEditorsEditable() {
  for (const [itemId, editor] of state.cardEditors) {
    editor.setEditable(itemId === state.editingItemId, false);
  }
}

function updateItemMarkdownFromEditor(editor, item, options = {}) {
  const html = typeof editor.getHTML === "function" ? editor.getHTML() : editor.innerHTML;
  const relativeMarkdown = turndown.turndown(html).trim();
  const nextMarkdown = denormalizeMarkdownHeadingDepth(relativeMarkdown, item);
  replaceItemMarkdown(item, nextMarkdown, options);
}

function replaceItemMarkdown(item, replacement, options = {}) {
  const lines = state.markdown.split(/\r?\n/);
  const replacementLines = replacement ? replacement.split(/\r?\n/) : [];
  const nextLines = [
    ...lines.slice(0, item.startLine),
    ...replacementLines,
    ...lines.slice(item.endLine + 1)
  ];
  state.markdown = nextLines.join("\n").replace(/\n{4,}/g, "\n\n\n").trimStart();
  item.content = replacement;
  item.endLine = item.startLine + Math.max(0, replacementLines.length - 1);
  scheduleDocumentSave();
  state.hasInitialFit = true;
  if (options.reparse) {
    reparseAndRender();
  }
}

function normalizeRenderedHeadingDepth(html, item) {
  const offset = getHeadingDepthOffset(item);
  if (!offset) return html;
  return html.replace(/<\/?h([1-6])(\s[^>]*)?>/gi, (tag, levelText) => {
    const relativeLevel = clamp(Number(levelText) - offset, 1, 6);
    return tag.replace(/h[1-6]/i, `h${relativeLevel}`);
  });
}

function denormalizeMarkdownHeadingDepth(markdown, item) {
  const offset = getHeadingDepthOffset(item);
  if (!offset) return markdown;
  let fenceMarker = null;
  return markdown.split(/\r?\n/).map((line) => {
    const fence = /^(\s*)(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const marker = fence[2][0];
      if (!fenceMarker) fenceMarker = marker;
      else if (marker === fenceMarker) fenceMarker = null;
      return line;
    }
    return fenceMarker ? line : shiftMarkdownHeadingLine(line, offset);
  }).join("\n");
}

function shiftMarkdownHeadingLine(line, offset) {
  return line.replace(/^(#{1,6})(\s+)/, (_match, hashes, spacing) => {
    const sourceLevel = clamp(hashes.length + offset, 1, 6);
    return `${"#".repeat(sourceLevel)}${spacing}`;
  });
}

function getHeadingDepthOffset(item) {
  if (!item || item.kind === "embed") return 0;
  const baselineLevel = Number.isFinite(item.level) ? item.level : getCurrentCanvasHeadingBaseline();
  return clamp(baselineLevel, 1, 6) - 1;
}

function getCurrentCanvasHeadingBaseline() {
  const scope = state.parsed?.scopes?.[state.currentScopeId];
  return scope?.depth ?? scope?.canvasHeadingLevel ?? 1;
}

function focusCardEditor(itemId) {
  const editor = state.cardEditors.get(itemId);
  if (!editor) return;
  focusEditorAtEvent(editor);
}

function focusEditorAtEvent(editor, event = null) {
  editor.commands.focus();
  if (!event) {
    editor.commands.focus("end");
    return;
  }
  requestAnimationFrame(() => {
    const position = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
    if (position?.pos) {
      editor.chain().focus().setTextSelection(position.pos).run();
    } else {
      editor.commands.focus("end");
    }
  });
}

function findRenderableById(id) {
  if (!id || !state.parsed) return null;
  return state.parsed.items.find((item) => item.id === id) || findEmbedById(id);
}

function findEmbedById(id) {
  if (!id || !state.parsed) return null;
  for (const item of state.parsed.items) {
    const embed = item.embeds.find((candidate) => candidate.id === id);
    if (embed) return embed;
  }
  return null;
}

function openEmbedTarget(id) {
  const embed = findEmbedById(id);
  if (!embed) return;
  navigateToReference(embed.target, "embed");
}

function selectItem(id, options = {}) {
  if (!id) return;
  if (els.workspace.classList.contains("layer-collapsed")) {
    toggleLayerPanel();
  }
  state.selectedId = id;
  expandLayerPathToItem(id);
  renderShell();
  updateCanvasSelection();
  if (options.revealOnCanvas ?? false) revealItemOnCanvas(id);
}

function clearSelection() {
  if (!state.selectedId) return;
  state.selectedId = null;
  renderShell();
  updateCanvasSelection();
}

function isEditingItem(id) {
  return Boolean(id) && state.editingItemId === id;
}

async function enterScope(scopeId, stackIndex = null) {
  if (!state.parsed?.scopes?.[scopeId]) return;
  state.currentScopeId = scopeId;
  if (stackIndex === null) {
    const existing = state.scopeStack.indexOf(scopeId);
    state.scopeStack = existing === -1 ? [...state.scopeStack, scopeId] : state.scopeStack.slice(0, existing + 1);
  } else {
    state.scopeStack = state.scopeStack.slice(0, stackIndex + 1);
  }
  state.selectedId = null;
  state.hasInitialFit = false;
  syncCurrentScope();
  ensureItemStates();
  renderShell();
  await renderCanvas();
  requestAnimationFrame(fitInitialViewport);
}

function syncCurrentScope() {
  const scope = state.parsed?.scopes?.[state.currentScopeId];
  if (!scope) return;
  state.parsed.title = scope.title;
  state.parsed.items = scope.items;
  state.parsed.tree = scope.tree;
}

function bindCardDrag(element, id) {
  element.addEventListener("pointerdown", (event) => {
    if (!isEditingItem(id) && startCanvasPan(event)) return;
    if (state.isSpacePressed || event.button !== 0) return;
    if (event.target.closest(".card-resize-handle")) return;
    if (isEditingItem(id) && isInteractiveTarget(event.target)) return;
    event.preventDefault();
    exitEditMode({ reparse: false });
    selectItem(id);
    const start = { clientX: event.clientX, clientY: event.clientY, ...state.itemStates[id] };
    const move = (moveEvent) => {
      state.itemStates[id].x = start.x + (moveEvent.clientX - start.clientX) / state.zoom;
      state.itemStates[id].y = start.y + (moveEvent.clientY - start.clientY) / state.zoom;
      applyFrame(element, state.itemStates[id]);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      saveLayout();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, true);
  element.addEventListener("dragstart", (event) => event.preventDefault());
}

function createResizeHandle(id) {
  const handle = document.createElement("div");
  handle.className = "card-resize-handle";
  handle.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    event.preventDefault();
    if (event.button !== 0 || state.isSpacePressed) return;
    const card = event.currentTarget.closest("[data-item-id]");
    const startX = event.clientX;
    const startWidth = state.itemStates[id].width;
    const move = (moveEvent) => {
      state.itemStates[id].width = clamp(startWidth + (moveEvent.clientX - startX) / state.zoom, MIN_CARD_WIDTH, MAX_CARD_WIDTH);
      applyFrame(card, state.itemStates[id]);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      saveLayout();
    };
    selectItem(id);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  return handle;
}

function bindCanvasPan() {
  els.stageScroll.addEventListener("pointerdown", (event) => {
    if (event.target !== els.stageScroll && event.target !== els.stageSize && event.target !== els.stage) return;
    exitEditMode();
    clearSelection();
    startCanvasPan(event);
  });
  els.stageScroll.addEventListener("auxclick", (event) => {
    if (event.button === 1) event.preventDefault();
  });
  els.stageScroll.addEventListener("dblclick", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (event.target !== els.stageScroll && event.target !== els.stageSize && event.target !== els.stage) return;
    event.preventDefault();
    createHeadingAtViewportPoint(event.clientX, event.clientY);
  });
  els.stageScroll.addEventListener("wheel", (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const zoomDelta = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    setZoom(state.zoom * zoomDelta, { clientX: event.clientX, clientY: event.clientY });
  }, { passive: false });
}

function startCanvasPan(event) {
  const shouldPan = (state.isSpacePressed && event.button === 0) || event.button === 1;
  if (!shouldPan) return false;
  event.preventDefault();
  event.stopPropagation();
  const start = { x: event.clientX, y: event.clientY, left: els.stageScroll.scrollLeft, top: els.stageScroll.scrollTop };
  els.stageScroll.classList.add("panning");
  const move = (moveEvent) => {
    els.stageScroll.scrollLeft = start.left - (moveEvent.clientX - start.x);
    els.stageScroll.scrollTop = start.top - (moveEvent.clientY - start.y);
  };
  const up = () => {
    els.stageScroll.classList.remove("panning");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    saveLayout();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  return true;
}

function bindKeyboardShortcuts() {
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.editingItemId) {
      event.preventDefault();
      exitEditMode();
      return;
    }
    if (event.code === "Space" && !isTypingTarget(event.target)) {
      event.preventDefault();
      state.isSpacePressed = true;
      els.stageScroll.classList.add("space-panning");
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && !isTypingTarget(event.target)) {
      event.preventDefault();
      deleteSelectedItem();
    }
  });
  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") {
      if (!isTypingTarget(event.target)) event.preventDefault();
      state.isSpacePressed = false;
      els.stageScroll.classList.remove("space-panning");
    }
  });
  window.addEventListener("blur", () => {
    state.isSpacePressed = false;
    els.stageScroll.classList.remove("space-panning");
  });
}

function deleteSelectedItem() {
  if (!state.selectedId) return;
  const embed = findEmbedById(state.selectedId);
  if (embed) {
    replaceLineRange(embed.line, embed.line, "");
    setStatus("Deleted selected embed.");
    return;
  }
  const item = state.parsed.items.find((candidate) => candidate.id === state.selectedId);
  if (!item) return;
  replaceLineRange(item.startLine, item.endLine, "");
  delete state.itemStates[item.id];
  state.selectedId = null;
  setStatus(`Deleted ${item.title}.`);
}

function moveMarkdownBlock(draggedId, targetId, position) {
  const dragged = state.parsed.items.find((item) => item.id === draggedId);
  const target = state.parsed.items.find((item) => item.id === targetId);
  if (!dragged || !target) return;
  const lines = state.markdown.split(/\r?\n/);
  const block = lines.slice(dragged.startLine, dragged.endLine + 1);
  const remaining = [
    ...lines.slice(0, dragged.startLine),
    ...lines.slice(dragged.endLine + 1)
  ];
  let targetIndex = position === "before" ? target.startLine : target.endLine + 1;
  if (dragged.startLine < targetIndex) targetIndex -= block.length;
  remaining.splice(targetIndex, 0, ...block);
  state.markdown = remaining.join("\n").replace(/\n{4,}/g, "\n\n\n");
  scheduleDocumentSave();
  state.selectedId = draggedId;
  state.hasInitialFit = true;
  reparseAndRender();
  setStatus("Reordered layer.");
}

function replaceLineRange(startLine, endLine, replacement) {
  const lines = state.markdown.split(/\r?\n/);
  const nextLines = [
    ...lines.slice(0, startLine),
    ...(replacement ? replacement.split(/\r?\n/) : []),
    ...lines.slice(endLine + 1)
  ];
  state.markdown = nextLines.join("\n").replace(/\n{4,}/g, "\n\n\n").trimStart();
  scheduleDocumentSave();
  state.hasInitialFit = true;
  reparseAndRender();
}

function getNewHeadingLevelForCurrentCanvas() {
  const scope = state.parsed?.scopes?.[state.currentScopeId];
  if (scope?.canvasHeadingLevel) return clamp(scope.canvasHeadingLevel, 1, 6);
  return getCurrentCanvasHeadingBaseline();
}

function createHeadingAtViewportPoint(clientX, clientY) {
  const point = getStageAnchorPoint({ clientX, clientY }, state.zoom);
  const worldX = Math.round(point.x - STAGE_WIDTH / 2);
  const worldY = Math.round(point.y - STAGE_HEIGHT / 2);
  const level = getNewHeadingLevelForCurrentCanvas();
  const title = "New heading";
  const lines = state.markdown.split(/\r?\n/);
  const scope = state.parsed.scopes[state.currentScopeId];
  const insertAt = scope ? Math.min(lines.length, scope.endLine + 1) : lines.length;
  const insertion = ["", `${"#".repeat(level)} ${title}`, ""];
  lines.splice(insertAt, 0, ...insertion);
  state.markdown = lines.join("\n").replace(/\n{4,}/g, "\n\n\n");
  scheduleDocumentSave();
  state.hasInitialFit = true;
  reparseAndRender().then(() => {
    const item = state.parsed.items.find((candidate) => candidate.title === title);
    if (!item) return;
    state.itemStates[item.id] = {
      x: worldX,
      y: worldY,
      width: DEFAULT_CARD_WIDTH,
      height: DEFAULT_CARD_HEIGHT
    };
    renderCanvas().then(() => selectItem(item.id, { revealOnCanvas: false }));
    saveLayout();
    focusEditorLine(item.startLine);
  });
}

function focusEditorLine(line) {
  const item = state.parsed?.items.find((candidate) => line >= candidate.startLine && line <= candidate.endLine);
  if (!item) return;
  selectItem(item.id, { revealOnCanvas: true });
  requestAnimationFrame(() => focusCardEditor(item.id));
}

function bindLayerResize() {
  els.layerResize.addEventListener("pointerdown", (event) => {
    const startX = event.clientX;
    const startWidth = els.layerPanel.getBoundingClientRect().width;
    els.layerResize.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      els.layerPanel.style.width = `${clamp(startWidth + moveEvent.clientX - startX, 180, 420)}px`;
    };
    const up = () => els.layerResize.removeEventListener("pointermove", move);
    els.layerResize.addEventListener("pointermove", move);
    els.layerResize.addEventListener("pointerup", up, { once: true });
    els.layerResize.addEventListener("pointercancel", up, { once: true });
  });
}

function setZoom(value, anchor = getViewportAnchor()) {
  const previousZoom = state.zoom;
  const nextZoom = clamp(Math.round(value * 1000) / 1000, getMinZoom(), MAX_ZOOM);
  if (nextZoom === previousZoom) return;
  const anchorPoint = getStageAnchorPoint(anchor, previousZoom);
  state.zoom = nextZoom;
  updateStageScale();
  restoreStageAnchorPoint(anchor, anchorPoint);
  updateZoomText();
  scheduleGridRender();
  saveLayout();
}

function fitView() {
  const states = Object.values(state.itemStates);
  if (!states.length) return;
  fitViewportToItems(states);
  saveLayout();
}

function fitInitialViewport() {
  if (state.hasInitialFit) return;
  state.hasInitialFit = true;
  if (state.hasSavedLayout) {
    if (state.hasSavedViewport) {
      normalizeViewportPresentation();
    } else {
      fitViewportToItems(Object.values(state.itemStates));
    }
    return;
  }
  fitViewportToItems(Object.values(state.itemStates));
}

function fitViewportToItems(states) {
  if (!states.length) {
    centerOnWorldPoint(0, 0);
    return;
  }
  const bounds = getItemBounds(states);
  const viewportWidth = Math.max(1, els.stageScroll.clientWidth);
  const viewportHeight = Math.max(1, els.stageScroll.clientHeight);
  const padding = 140;
  const width = Math.max(bounds.maxX - bounds.minX, 1) + padding * 2;
  const height = Math.max(bounds.maxY - bounds.minY, 1) + padding * 2;
  state.zoom = clamp(Math.min(viewportWidth / width, viewportHeight / height), getMinZoom(), MAX_ZOOM);
  updateStageScale();
  centerOnWorldPoint(bounds.centerX, bounds.centerY);
  updateZoomText();
  scheduleGridRender();
}

function updateStageScale() {
  els.stage.style.transform = `scale(${state.zoom})`;
  els.stageSize.style.width = `${STAGE_WIDTH * state.zoom}px`;
  els.stageSize.style.height = `${STAGE_HEIGHT * state.zoom}px`;
  applyViewportOffset();
}

function updateCanvasSelection() {
  els.stage.querySelectorAll("[data-item-id]").forEach((node) => {
    node.classList.toggle("selected", node.dataset.itemId === state.selectedId);
    node.classList.toggle("editing", node.dataset.itemId === state.editingItemId);
  });
  els.stage.querySelectorAll("[data-embed-id]").forEach((node) => {
    node.classList.toggle("selected", node.dataset.embedId === state.selectedId);
  });
}

function getViewportAnchor() {
  const rect = els.stageScroll.getBoundingClientRect();
  return {
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2
  };
}

function getStageAnchorPoint(anchor, zoom) {
  const rect = els.stageScroll.getBoundingClientRect();
  return {
    x: (els.stageScroll.scrollLeft + anchor.clientX - rect.left - state.viewportOffsetX) / zoom,
    y: (els.stageScroll.scrollTop + anchor.clientY - rect.top - state.viewportOffsetY) / zoom
  };
}

function restoreStageAnchorPoint(anchor, point) {
  const rect = els.stageScroll.getBoundingClientRect();
  positionViewportAroundStagePoint(point.x, point.y, anchor.clientX - rect.left, anchor.clientY - rect.top);
}

function revealItemOnCanvas(id) {
  const frame = state.itemStates[id];
  const embed = findEmbedById(id);
  if (embed) return revealItemOnCanvas(embed.ownerId);
  if (!frame) return;
  const nextZoom = clamp(Math.max(state.zoom, 1), getMinZoom(), MAX_ZOOM);
  if (nextZoom !== state.zoom) {
    state.zoom = nextZoom;
    updateStageScale();
    updateZoomText();
    saveLayout();
  }
  positionViewportAroundWorldPoint(frame.x + frame.width / 2, frame.y + frame.height / 2, els.stageScroll.clientWidth / 2, els.stageScroll.clientHeight / 2);
}

function applyFrame(element, frame) {
  element.style.left = `${STAGE_WIDTH / 2 + frame.x}px`;
  element.style.top = `${STAGE_HEIGHT / 2 + frame.y}px`;
  element.style.width = `${frame.width}px`;
  element.style.height = "auto";
  element.style.minHeight = "0";
}

function getMinZoom() {
  const viewportWidth = Math.max(1, els.stageScroll?.clientWidth ?? 1);
  const viewportHeight = Math.max(1, els.stageScroll?.clientHeight ?? 1);
  const minScrollableZoom = Math.max(
    (viewportWidth + MIN_SCROLLABLE_OVERFLOW) / STAGE_WIDTH,
    (viewportHeight + MIN_SCROLLABLE_OVERFLOW) / STAGE_HEIGHT
  );
  return clamp(minScrollableZoom, MIN_ZOOM, MAX_ZOOM);
}

function enforceZoomBounds() {
  const minZoom = getMinZoom();
  if (state.zoom >= minZoom) return;
  state.zoom = minZoom;
  updateStageScale();
  updateZoomText();
}

function centerOnWorldPoint(worldX, worldY) {
  positionViewportAroundWorldPoint(worldX, worldY, els.stageScroll.clientWidth / 2, els.stageScroll.clientHeight / 2);
}

function positionViewportAroundWorldPoint(worldX, worldY, viewportX, viewportY) {
  positionViewportAroundStagePoint(STAGE_WIDTH / 2 + worldX, STAGE_HEIGHT / 2 + worldY, viewportX, viewportY);
}

function positionViewportAroundStagePoint(stageX, stageY, viewportX, viewportY) {
  const xAxis = solveViewportAxis(stageX * state.zoom, viewportX, STAGE_WIDTH * state.zoom, els.stageScroll.clientWidth);
  const yAxis = solveViewportAxis(stageY * state.zoom, viewportY, STAGE_HEIGHT * state.zoom, els.stageScroll.clientHeight);
  els.stageScroll.scrollLeft = xAxis.scroll;
  els.stageScroll.scrollTop = yAxis.scroll;
  state.viewportOffsetX = xAxis.offset;
  state.viewportOffsetY = yAxis.offset;
  applyViewportOffset();
  scheduleGridRender();
}

function solveViewportAxis(scaledStagePoint, viewportPoint, scaledStageSize, viewportSize) {
  const maxScroll = Math.max(0, scaledStageSize - viewportSize);
  const slack = Math.max(0, viewportSize - scaledStageSize);
  const scroll = clamp(scaledStagePoint - viewportPoint, 0, maxScroll);
  const offset = clamp(viewportPoint - scaledStagePoint + scroll, 0, slack);
  return { scroll, offset };
}

function normalizeViewportPresentation() {
  const scaledWidth = STAGE_WIDTH * state.zoom;
  const scaledHeight = STAGE_HEIGHT * state.zoom;
  const viewportWidth = Math.max(1, els.stageScroll.clientWidth);
  const viewportHeight = Math.max(1, els.stageScroll.clientHeight);
  els.stageScroll.scrollLeft = clamp(els.stageScroll.scrollLeft, 0, Math.max(0, scaledWidth - viewportWidth));
  els.stageScroll.scrollTop = clamp(els.stageScroll.scrollTop, 0, Math.max(0, scaledHeight - viewportHeight));
  state.viewportOffsetX = clamp(state.viewportOffsetX, 0, Math.max(0, viewportWidth - scaledWidth));
  state.viewportOffsetY = clamp(state.viewportOffsetY, 0, Math.max(0, viewportHeight - scaledHeight));
  applyViewportOffset();
}

function applyViewportOffset() {
  els.stageSize.style.left = `${state.viewportOffsetX}px`;
  els.stageSize.style.top = `${state.viewportOffsetY}px`;
}

function scheduleGridRender() {
  if (state.gridFrame !== null) return;
  state.gridFrame = requestAnimationFrame(() => {
    state.gridFrame = null;
    renderGrid();
  });
}

function renderGrid() {
  const canvas = els.gridLayer;
  const host = els.canvasArea;
  if (!canvas || !host) return;
  const width = Math.max(1, Math.floor(host.clientWidth));
  const height = Math.max(1, Math.floor(host.clientHeight));
  const dpr = window.devicePixelRatio || 1;
  const backingWidth = Math.max(1, Math.floor(width * dpr));
  const backingHeight = Math.max(1, Math.floor(height * dpr));
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, backingWidth, backingHeight);
  context.scale(dpr, dpr);
  const dotColor = getComputedStyle(host).getPropertyValue("--grid-dot").trim() || "rgba(128, 128, 128, 0.32)";
  const baseSpacing = GRID_SPACING * state.zoom;
  const spacingMultiplier = Math.max(1, 2 ** Math.ceil(Math.log2(MIN_GRID_SCREEN_SPACING / Math.max(baseSpacing, 1))));
  const spacing = baseSpacing * spacingMultiplier;
  if (!Number.isFinite(spacing) || spacing < 6) return;
  const screenOriginX = (STAGE_WIDTH / 2) * state.zoom - els.stageScroll.scrollLeft + state.viewportOffsetX;
  const screenOriginY = (STAGE_HEIGHT / 2) * state.zoom - els.stageScroll.scrollTop + state.viewportOffsetY;
  const startX = mod(screenOriginX, spacing) - (screenOriginX < 0 ? 0 : spacing);
  const startY = mod(screenOriginY, spacing) - (screenOriginY < 0 ? 0 : spacing);
  context.fillStyle = dotColor;
  for (let y = startY; y <= height + spacing; y += spacing) {
    for (let x = startX; x <= width + spacing; x += spacing) {
      context.beginPath();
      context.arc(x, y, GRID_DOT_RADIUS, 0, Math.PI * 2);
      context.fill();
    }
  }
}

function getItemBounds(itemStates) {
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  for (const item of itemStates) {
    minX = Math.min(minX, item.x);
    minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x + item.width);
    maxY = Math.max(maxY, item.y + item.height);
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2
  };
}

async function loadLayout() {
  const layout = await db.get("layouts", state.documentKey);
  state.itemStates = layout?.itemStates ?? {};
  state.hasSavedLayout = Boolean(layout);
  state.hasSavedViewport = Number.isFinite(layout?.scrollLeft) && Number.isFinite(layout?.scrollTop);
  state.zoom = layout?.zoom ?? 1;
  state.viewportOffsetX = layout?.viewportOffsetX ?? 0;
  state.viewportOffsetY = layout?.viewportOffsetY ?? 0;
  updateStageScale();
  updateZoomText();
  requestAnimationFrame(() => {
    if (!state.hasSavedViewport) return;
    els.stageScroll.scrollLeft = layout.scrollLeft;
    els.stageScroll.scrollTop = layout.scrollTop;
    normalizeViewportPresentation();
  });
}

async function saveLayout() {
  state.hasSavedLayout = true;
  await db.set("layouts", state.documentKey, {
    version: 1,
    documentKey: state.documentKey,
    fileName: state.fileName,
    zoom: state.zoom,
    scrollLeft: els.stageScroll.scrollLeft,
    scrollTop: els.stageScroll.scrollTop,
    viewportOffsetX: state.viewportOffsetX,
    viewportOffsetY: state.viewportOffsetY,
    itemStates: state.itemStates,
    updatedAt: Date.now()
  });
}

function getDocumentIdentity(file) {
  const name = file?.name || state.fileName || "Untitled.md";
  return `doc:${name}`;
}

function updateZoomText() {
  const text = `${Math.round(state.zoom * 100)}%`;
  els.zoomReset.textContent = text;
  els.zoomStatus.textContent = `Zoom ${text}`;
}

function clearLocalImageUrls() {
  for (const url of state.localImageUrls.values()) URL.revokeObjectURL(url);
  state.localImageUrls.clear();
}

function setStatus(text) {
  els.statusText.textContent = text;
}

function isImageTarget(target) {
  const clean = target.split("#")[0].split("?")[0];
  const ext = clean.includes(".") ? clean.split(".").pop().toLowerCase() : "";
  return IMAGE_EXTENSIONS.has(ext) || /^(https?:|data:)/i.test(target);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9가-힣]+/gi, "-").replace(/^-+|-+$/g, "") || "untitled";
}

function cssEscape(value) {
  return window.CSS?.escape ? CSS.escape(value) : value.replace(/"/g, '\\"');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function button(className, text, onClick) {
  const el = document.createElement("button");
  el.className = className;
  el.type = "button";
  el.textContent = text;
  el.addEventListener("click", onClick);
  return el;
}

function span(className, text) {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}


function cardSvg() {
  return '<svg viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" rx="2"/></svg>';
}

function lineSvg() {
  return '<svg viewBox="0 0 12 12"><path d="M2 4h8M2 7h6"/></svg>';
}

function mod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function isTypingTarget(target) {
  return target instanceof HTMLElement && (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

function isInteractiveTarget(target) {
  return target instanceof Element && Boolean(target.closest("a, button, input, textarea, select, summary, [contenteditable='true'], .selectable-embed"));
}

function getEventLink(event) {
  return event.target instanceof Element ? event.target.closest("a[href]") : null;
}

function embedSvg() {
  return '<svg viewBox="0 0 12 12"><path d="M4.5 7.5l3-3M5 3.5l.7-.7a2 2 0 0 1 2.8 2.8l-.7.7M7 8.5l-.7.7a2 2 0 0 1-2.8-2.8l.7-.7"/></svg>';
}

function slugSafe(value) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "untitled";
}

function chevronSvg(expanded = false) {
  return expanded
    ? '<svg viewBox="0 0 12 12"><path d="M3 4.5l3 3 3-3"/></svg>'
    : '<svg viewBox="0 0 12 12"><path d="M4.5 3l3 3-3 3"/></svg>';
}
