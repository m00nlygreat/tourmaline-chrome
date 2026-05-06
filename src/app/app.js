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

const state = {
  markdown: SAMPLE_MARKDOWN,
  fileHandle: null,
  directoryHandle: null,
  fileName: "Untitled.md",
  documentKey: "sample:untitled",
  parsed: null,
  selectedId: null,
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
  saveTimer: null
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
  open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("tourmaline-chrome", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("layouts");
        request.result.createObjectStore("documents");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },
  async get(store, key) {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(store, "readonly");
      const request = tx.objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => database.close();
    });
  },
  async set(store, key, value) {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(store, "readwrite");
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => {
        database.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }
};

init();

async function init() {
  bindEvents();
  const loadedFromContentScript = loadMarkdownFromContentScript();
  const loadedFromUrl = loadedFromContentScript ? false : await loadMarkdownFromUrlParam();
  if (!loadedFromContentScript && !loadedFromUrl) {
    await loadPersistedSample();
  }
  await loadLayout();
  await reparseAndRender();
  requestAnimationFrame(() => {
    fitInitialViewport();
    renderGrid();
  });
}

function bindEvents() {
  document.querySelector("#open-file").addEventListener("click", openMarkdownFile);
  document.querySelector("#open-folder").addEventListener("click", openFolder);
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

async function loadPersistedSample() {
  const saved = await db.get("documents", state.documentKey);
  if (saved?.markdown) {
    state.markdown = saved.markdown;
  }
}

function loadMarkdownFromContentScript() {
  const file = window.__TOURMALINE_FILE__;
  if (!file?.fileUrl) return false;

  state.fileHandle = null;
  state.fileName = file.fileName || "Markdown.md";
  state.markdown = file.markdown || "";
  state.documentKey = `url:${file.fileUrl}`;
  state.hasInitialFit = false;
  setStatus(`Opened ${file.fileUrl}`);
  return true;
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
  state.hasInitialFit = false;
  await loadLayout();
  await reparseAndRender();
  setStatus(`Opened ${file.name}`);
}

async function openFolder() {
  if (!window.showDirectoryPicker) {
    setStatus("Folder access is not available in this browser.");
    return;
  }
  state.directoryHandle = await window.showDirectoryPicker();
  clearLocalImageUrls();
  await reparseAndRender();
  setStatus("Folder linked for relative image embeds.");
}

async function saveMarkdownFile() {
  if (!state.fileHandle) {
    await db.set("documents", state.documentKey, { markdown: state.markdown, updatedAt: Date.now() });
    setStatus("Saved sample document in IndexedDB.");
    return;
  }
  const permission = await ensureWritable(state.fileHandle);
  if (!permission) {
    setStatus("Write permission was not granted.");
    return;
  }
  const writable = await state.fileHandle.createWritable();
  await writable.write(state.markdown);
  await writable.close();
  setStatus(`Saved ${state.fileName}`);
}

async function ensureWritable(handle) {
  const options = { mode: "readwrite" };
  if ((await handle.queryPermission(options)) === "granted") return true;
  return (await handle.requestPermission(options)) === "granted";
}

function scheduleDocumentSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    if (!state.fileHandle) {
      db.set("documents", state.documentKey, { markdown: state.markdown, updatedAt: Date.now() });
    }
  }, 300);
}

async function reparseAndRender() {
  const previousItems = state.parsed?.items ?? [];
  const previousFrames = new Map(previousItems.map((item) => [`${item.startLine}:${item.endLine}`, state.itemStates[item.id]]));
  const previousSelectedItem = previousItems.find((item) => item.id === state.selectedId);
  state.parsed = parseMarkdown(state.markdown);
  migrateItemStatesByLineRange(previousFrames);
  const previousSelection = state.selectedId;
  if (previousSelectedItem && !findRenderableById(previousSelection)) {
    const nextSelectedItem = state.parsed.items.find((item) => item.startLine === previousSelectedItem.startLine && item.endLine === previousSelectedItem.endLine);
    if (nextSelectedItem) state.selectedId = nextSelectedItem.id;
  }
  ensureItemStates();
  if (!findRenderableById(state.selectedId)) {
    state.selectedId = state.parsed.items[0]?.id ?? null;
  }
  renderShell();
  await renderCanvas();
  if (!state.hasInitialFit) {
    requestAnimationFrame(fitInitialViewport);
  }
}

function migrateItemStatesByLineRange(previousFrames) {
  if (!previousFrames.size) return;
  state.parsed.items.forEach((item) => {
    if (state.itemStates[item.id]) return;
    const frame = previousFrames.get(`${item.startLine}:${item.endLine}`);
    if (frame) state.itemStates[item.id] = frame;
  });
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
      scopes[scopeId] = { id: scopeId, title, startLine, endLine, headingLevel: openingHeading?.level ?? 0, items, tree: [] };
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
      headingLevel: openingHeading?.level ?? 0,
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
  state.scopeStack.forEach((scopeId, index) => {
    const scope = state.parsed.scopes[scopeId];
    const label = index === 0 ? state.fileName : scope?.title ?? "Scope";
    els.breadcrumbs.append(button(`breadcrumb ${index === state.scopeStack.length - 1 ? "current" : ""}`, label, () => enterScope(scopeId, index)));
    if (index < state.scopeStack.length - 1) els.breadcrumbs.append(span("breadcrumb-sep", "/"));
  });
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
  clearLocalImageUrls();
  els.stage.replaceChildren();
  for (const item of state.parsed.items) {
    const el = document.createElement("article");
    el.className = `${item.kind === "orphan" ? "orphan" : "card"} ${item.id === state.selectedId ? "selected" : ""}`;
    el.dataset.itemId = item.id;
    if (item.childScopeId) el.dataset.childScopeId = item.childScopeId;
    applyFrame(el, state.itemStates[item.id]);
    const body = document.createElement("div");
    body.className = item.kind === "orphan" ? "orphan-body" : "card-body";
    const editor = document.createElement("div");
    editor.className = "editable-card-body";
    editor.contentEditable = "true";
    editor.spellcheck = true;
    editor.dataset.itemId = item.id;
    editor.setAttribute("aria-label", `Edit ${item.title}`);
    const content = await renderMarkdownFragment(item.content, item);
    editor.append(...content.childNodes);
    bindCardEditor(editor, item);
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
      if ((event.ctrlKey || event.metaKey) && item.childScopeId) {
        event.preventDefault();
        enterScope(item.childScopeId);
        return;
      }
      selectItem(item.id);
    });
    el.addEventListener("dblclick", (event) => {
      if (isInteractiveTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      focusEditorLine(item.startLine);
    });
    els.stage.append(el);
  }
  decorateEmbeds();
}

async function renderMarkdownFragment(markdown, item) {
  const container = document.createElement("div");
  const withoutEmbeds = await replaceEmbeds(markdown, item);
  const blocks = withoutEmbeds.split(/\n{2,}/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("<div class=\"embed-pill\"") || trimmed.startsWith("<img ")) {
      container.insertAdjacentHTML("beforeend", trimmed);
    } else if (/^#{1,6}\s+/.test(trimmed)) {
      const match = /^(#{1,6})\s+(.+)$/.exec(trimmed);
      const heading = document.createElement(`h${Math.min(4, match[1].length)}`);
      heading.dataset.markdownLevel = String(match[1].length);
      heading.textContent = match[2].replace(/\s+#*$/, "");
      container.append(heading);
    } else if (/^[-*+]\s+/m.test(trimmed)) {
      const ul = document.createElement("ul");
      trimmed.split(/\r?\n/).filter(Boolean).forEach((line) => {
        const li = document.createElement("li");
        li.innerHTML = inlineMarkdown(escapeHtml(line.replace(/^[-*+]\s+/, "")));
        ul.append(li);
      });
      container.append(ul);
    } else if (/^>\s+/m.test(trimmed)) {
      const quote = document.createElement("blockquote");
      quote.innerHTML = inlineMarkdown(escapeHtml(trimmed.replace(/^>\s?/gm, "")));
      container.append(quote);
    } else if (/^```/.test(trimmed)) {
      const pre = document.createElement("pre");
      pre.textContent = trimmed.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "");
      container.append(pre);
    } else {
      const p = document.createElement("p");
      p.innerHTML = inlineMarkdown(escapeHtml(trimmed));
      container.append(p);
    }
  }
  return container;
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
  return `<div class="embed-pill ${className}" ${attrs}>File embed: ${escapeHtml(embed.target)}</div>`;
}

async function resolveImageSource(target) {
  if (/^(https?:|data:|blob:)/i.test(target)) return target;
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
      const line = Number(element.dataset.line || 0);
      focusEditorLine(line);
    }, true);
  });
  els.stage.querySelectorAll("img").forEach((image) => {
    image.draggable = false;
  });
}

function bindCardEditor(editor, item) {
  editor.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    selectItem(item.id);
  });
  editor.addEventListener("click", (event) => {
    event.stopPropagation();
    selectItem(item.id);
  });
  editor.addEventListener("input", () => {
    updateItemMarkdownFromEditor(editor, item, { reparse: false });
  });
  editor.addEventListener("blur", () => {
    updateItemMarkdownFromEditor(editor, item, { reparse: true });
  });
  editor.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    document.execCommand("insertText", false, text);
  });
}

function updateItemMarkdownFromEditor(editor, item, options = {}) {
  const nextMarkdown = serializeEditableMarkdown(editor, item).trim();
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

function serializeEditableMarkdown(editor, item) {
  const blocks = [];
  editor.childNodes.forEach((node) => {
    const markdown = serializeBlock(node, item);
    if (markdown) blocks.push(markdown);
  });
  return blocks.join("\n\n");
}

function serializeBlock(node, item) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent.trim();
  if (!(node instanceof HTMLElement)) return "";
  if (node.matches("[data-markdown]")) return node.dataset.markdown;
  if (node.matches("h1, h2, h3, h4, h5, h6")) {
    const level = clamp(Number(node.dataset.markdownLevel || item.level || 1), 1, 6);
    return `${"#".repeat(level)} ${node.textContent.trim()}`;
  }
  if (node.matches("ul, ol")) {
    return [...node.children]
      .filter((child) => child.matches("li"))
      .map((child, index) => node.matches("ol") ? `${index + 1}. ${serializeInlineMarkdown(child)}` : `- ${serializeInlineMarkdown(child)}`)
      .join("\n");
  }
  if (node.matches("blockquote")) {
    return serializeInlineMarkdown(node).split(/\r?\n/).map((line) => `> ${line}`).join("\n");
  }
  if (node.matches("pre")) {
    return `\`\`\`\n${node.textContent.replace(/\n$/, "")}\n\`\`\``;
  }
  if (node.matches("img")) {
    return node.dataset.markdown || `![${node.alt || ""}](${node.getAttribute("src") || ""})`;
  }
  if (node.matches(".embed-pill")) {
    return node.dataset.markdown || node.textContent.trim();
  }
  if (node.matches("div") && [...node.children].some((child) => child.matches("div, p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, img, .embed-pill"))) {
    return [...node.childNodes].map((child) => serializeBlock(child, item)).filter(Boolean).join("\n\n");
  }
  return serializeInlineMarkdown(node);
}

function serializeInlineMarkdown(node) {
  let output = "";
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      output += child.textContent;
      return;
    }
    if (!(child instanceof HTMLElement)) return;
    if (child.matches("[data-markdown]")) {
      output += child.dataset.markdown;
    } else if (child.matches("strong, b")) {
      output += `**${serializeInlineMarkdown(child)}**`;
    } else if (child.matches("em, i")) {
      output += `*${serializeInlineMarkdown(child)}*`;
    } else if (child.matches("code")) {
      output += `\`${child.textContent}\``;
    } else if (child.matches("a")) {
      output += `[${serializeInlineMarkdown(child)}](${child.getAttribute("href") || ""})`;
    } else if (child.matches("br")) {
      output += "\n";
    } else {
      output += serializeInlineMarkdown(child);
    }
  });
  return output.trim();
}

function focusCardEditor(itemId) {
  const editor = els.stage.querySelector(`.editable-card-body[data-item-id="${cssEscape(itemId)}"]`);
  if (!(editor instanceof HTMLElement)) return;
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
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
  if (/^https?:/i.test(embed.target)) {
    window.open(embed.target, "_blank", "noopener,noreferrer");
    return;
  }
  setStatus(`Embed target: ${embed.target}`);
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
    if (state.isSpacePressed || event.button !== 0) return;
    if (event.target.closest(".card-resize-handle")) return;
    if (isInteractiveTarget(event.target)) return;
    event.preventDefault();
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
    clearSelection();
    const shouldPan = (state.isSpacePressed && event.button === 0) || event.button === 1;
    if (!shouldPan) return;
    event.preventDefault();
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
    event.preventDefault();
    const zoomDelta = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    setZoom(state.zoom * zoomDelta, { clientX: event.clientX, clientY: event.clientY });
  }, { passive: false });
}

function bindKeyboardShortcuts() {
  window.addEventListener("keydown", (event) => {
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
  const sectionLevels = (scope?.items ?? state.parsed?.items ?? [])
    .filter((item) => item.kind === "section")
    .map((item) => item.level);
  if (sectionLevels.length) return clamp(Math.min(...sectionLevels), 1, 6);
  return clamp((scope?.headingLevel ?? 0) + 1, 1, 6);
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
  if (element.classList.contains("orphan")) {
    element.style.height = "auto";
    element.style.minHeight = "0";
  } else {
    element.style.minHeight = `${frame.height}px`;
  }
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
  const f = file ?? { name: state.fileName, size: state.markdown.length, lastModified: 0 };
  return `doc:${f.name}:${f.size}:${f.lastModified}`;
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

function inlineMarkdown(html) {
  return html
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\n/g, "<br>");
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
