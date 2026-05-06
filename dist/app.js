const STAGE_WIDTH = 3200;
const STAGE_HEIGHT = 2200;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"]);
const SAMPLE_MARKDOWN = `# Tourmaline Chrome

Tourmaline turns a Markdown document into movable cards on a browser canvas.

## Background

The Chrome version keeps the editor and canvas preview together. Edits in this source pane are reflected immediately in the visual workspace.

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
  zoom: 1,
  itemStates: {},
  localImageUrls: new Map(),
  saveTimer: null
};

const els = {
  editor: document.querySelector("#markdown-editor"),
  stage: document.querySelector("#stage"),
  stageScroll: document.querySelector("#stage-scroll"),
  layerPanel: document.querySelector("#layer-panel"),
  layerTree: document.querySelector("#layer-tree"),
  layerResize: document.querySelector("#layer-resize"),
  breadcrumbs: document.querySelector("#breadcrumbs"),
  scopeTitle: document.querySelector("#scope-title"),
  scopeMeta: document.querySelector("#scope-meta"),
  editorMeta: document.querySelector("#editor-meta"),
  fileLabel: document.querySelector("#file-label"),
  itemCount: document.querySelector("#item-count"),
  statusText: document.querySelector("#status-text"),
  zoomStatus: document.querySelector("#zoom-status"),
  zoomReset: document.querySelector("#zoom-reset")
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
  els.editor.value = state.markdown;
  bindEvents();
  const loadedFromContentScript = loadMarkdownFromContentScript();
  const loadedFromUrl = loadedFromContentScript ? false : await loadMarkdownFromUrlParam();
  if (!loadedFromContentScript && !loadedFromUrl) {
    await loadPersistedSample();
  }
  await loadLayout();
  await reparseAndRender();
  centerStage();
}

function bindEvents() {
  document.querySelector("#open-file").addEventListener("click", openMarkdownFile);
  document.querySelector("#open-folder").addEventListener("click", openFolder);
  document.querySelector("#save-file").addEventListener("click", saveMarkdownFile);
  document.querySelector("#zoom-in").addEventListener("click", () => setZoom(state.zoom + 0.1));
  document.querySelector("#zoom-out").addEventListener("click", () => setZoom(state.zoom - 0.1));
  document.querySelector("#zoom-reset").addEventListener("click", () => setZoom(1));
  document.querySelector("#fit-view").addEventListener("click", fitView);
  els.editor.addEventListener("input", () => {
    state.markdown = els.editor.value;
    scheduleDocumentSave();
    reparseAndRender();
  });
  bindCanvasPan();
  bindLayerResize();
}

async function loadPersistedSample() {
  const saved = await db.get("documents", state.documentKey);
  if (saved?.markdown) {
    state.markdown = saved.markdown;
    els.editor.value = saved.markdown;
  }
}

function loadMarkdownFromContentScript() {
  const file = window.__TOURMALINE_FILE__;
  if (!file?.fileUrl) return false;

  state.fileHandle = null;
  state.fileName = file.fileName || "Markdown.md";
  state.markdown = file.markdown || "";
  state.documentKey = `url:${file.fileUrl}`;
  els.editor.value = state.markdown;
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
    els.editor.value = state.markdown;
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
  els.editor.value = state.markdown;
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
  state.parsed = parseMarkdown(state.markdown);
  const previousSelection = state.selectedId;
  ensureItemStates();
  if (!state.parsed.items.some((item) => item.id === previousSelection)) {
    state.selectedId = state.parsed.items[0]?.id ?? null;
  }
  renderShell();
  await renderCanvas();
  await saveLayout();
}

function parseMarkdown(markdown) {
  const body = stripFrontmatter(markdown);
  const lines = body.split(/\r?\n/);
  const headings = [];
  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) headings.push({ line: index, level: match[1].length, title: match[2].trim() });
  });

  const items = [];
  if (!headings.length) {
    const content = body.trim() || "# Untitled\n\nStart writing Markdown.";
    items.push(createItem("orphan:root", "orphan", "Document", 0, lines.length - 1, content, 1));
    return { title: "Document", items, tree: items };
  }

  const firstHeading = headings[0];
  if (firstHeading.line > 0) {
    const prefix = lines.slice(0, firstHeading.line).join("\n").trim();
    if (prefix) items.push(createItem("orphan:prefix", "orphan", "Intro", 0, firstHeading.line - 1, prefix, 1));
  }

  headings.forEach((heading, index) => {
    const next = findNextBoundary(headings, index);
    const endLine = next ? next.line - 1 : lines.length - 1;
    const content = lines.slice(heading.line, endLine + 1).join("\n").trim();
    const id = `section:${slugPath(headings, index)}`;
    items.push(createItem(id, "section", heading.title, heading.line, endLine, content, heading.level));
  });

  const title = headings[0]?.title ?? "Document";
  return { title, items, tree: buildLayerTree(items) };
}

function stripFrontmatter(markdown) {
  if (!markdown.startsWith("---")) return markdown;
  const end = markdown.indexOf("\n---", 3);
  return end === -1 ? markdown : markdown.slice(markdown.indexOf("\n", end + 4) + 1);
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
  return ancestors.map((heading) => slug(heading.title)).join("/");
}

function createItem(id, kind, title, startLine, endLine, content, level) {
  return { id, kind, title, startLine, endLine, content, level, embeds: extractEmbeds(content, startLine) };
}

function buildLayerTree(items) {
  const root = [];
  const stack = [];
  for (const item of items) {
    const node = { ...item, children: [] };
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

function extractEmbeds(markdown, lineOffset) {
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
      embeds.push({ original: match[0], target, label: match[1] || target, line, isImage: isImageTarget(target) });
    }
  }
  return embeds;
}

function ensureItemStates() {
  state.parsed.items.forEach((item, index) => {
    if (state.itemStates[item.id]) return;
    const col = index % 3;
    const row = Math.floor(index / 3);
    state.itemStates[item.id] = {
      x: 60 + col * 350,
      y: 55 + row * 210,
      width: item.kind === "orphan" ? 280 : 310,
      height: item.kind === "orphan" ? 90 : 130
    };
  });
}

function renderShell() {
  els.scopeTitle.textContent = state.parsed.title;
  els.scopeMeta.textContent = `${state.parsed.items.length} items`;
  els.editorMeta.textContent = `${state.markdown.split(/\r?\n/).length} lines`;
  els.fileLabel.textContent = state.fileName;
  els.itemCount.textContent = `${state.parsed.items.length} items`;
  renderBreadcrumbs();
  renderLayers();
  updateZoomText();
}

function renderBreadcrumbs() {
  const selected = state.parsed.items.find((item) => item.id === state.selectedId);
  els.breadcrumbs.replaceChildren();
  const file = button("breadcrumb", state.fileName, () => selectItem(state.parsed.items[0]?.id));
  els.breadcrumbs.append(file, span("breadcrumb-sep", "/"));
  els.breadcrumbs.append(button("breadcrumb current", selected?.title ?? "Document", () => {}));
}

function renderLayers() {
  els.layerTree.replaceChildren(...state.parsed.tree.map((node) => renderLayerNode(node)));
}

function renderLayerNode(node) {
  const wrapper = document.createElement("div");
  const row = button(`layer-row ${node.children?.length ? "drillable" : ""} ${node.id === state.selectedId ? "selected" : ""}`, "", () => selectItem(node.id));
  row.innerHTML = `
    <span class="layer-toggle">${node.children?.length ? chevronSvg() : ""}</span>
    <span class="layer-glyph">${node.kind === "orphan" ? lineSvg() : cardSvg()}</span>
    <span class="layer-label"></span>
    <span class="layer-count">${node.embeds?.length ? node.embeds.length : ""}</span>
  `;
  row.querySelector(".layer-label").textContent = node.title;
  wrapper.append(row);
  if (node.children?.length) {
    const children = document.createElement("div");
    children.className = "layer-children";
    children.append(...node.children.map((child) => renderLayerNode(child)));
    wrapper.append(children);
  }
  return wrapper;
}

async function renderCanvas() {
  clearLocalImageUrls();
  els.stage.replaceChildren();
  for (const item of state.parsed.items) {
    const el = document.createElement("article");
    el.className = `${item.kind === "orphan" ? "orphan" : "card"} ${item.id === state.selectedId ? "selected" : ""}`;
    el.dataset.itemId = item.id;
    applyFrame(el, state.itemStates[item.id]);
    const body = document.createElement("div");
    body.className = item.kind === "orphan" ? "orphan-body" : "card-body";
    if (item.kind === "orphan") {
      body.append(span("orphan-label", item.title), await renderMarkdownFragment(item.content, item));
    } else {
      body.append(await renderMarkdownFragment(item.content, item));
      el.append(createResizeHandle(item.id));
    }
    el.append(body);
    bindCardDrag(el, item.id);
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      selectItem(item.id);
    });
    els.stage.append(el);
  }
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
  if (embed.isImage) {
    const src = await resolveImageSource(embed.target);
    if (src) return `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(embed.label)}">`;
    return `<div class="embed-pill">Image unavailable: ${escapeHtml(embed.target)}</div>`;
  }
  return `<div class="embed-pill">File embed: ${escapeHtml(embed.target)}</div>`;
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

function selectItem(id) {
  if (!id) return;
  state.selectedId = id;
  renderShell();
  renderCanvas();
  const node = els.stage.querySelector(`[data-item-id="${cssEscape(id)}"]`);
  node?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function bindCardDrag(element, id) {
  element.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".card-resize-handle")) return;
    event.preventDefault();
    selectItem(id);
    const start = { clientX: event.clientX, clientY: event.clientY, ...state.itemStates[id] };
    element.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      state.itemStates[id].x = start.x + (moveEvent.clientX - start.clientX) / state.zoom;
      state.itemStates[id].y = start.y + (moveEvent.clientY - start.clientY) / state.zoom;
      applyFrame(element, state.itemStates[id]);
    };
    const up = () => {
      element.removeEventListener("pointermove", move);
      saveLayout();
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up, { once: true });
    element.addEventListener("pointercancel", up, { once: true });
  });
}

function createResizeHandle(id) {
  const handle = document.createElement("div");
  handle.className = "card-resize-handle";
  handle.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    event.preventDefault();
    const card = event.currentTarget.closest(".card");
    const startX = event.clientX;
    const startWidth = state.itemStates[id].width;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      state.itemStates[id].width = clamp(startWidth + (moveEvent.clientX - startX) / state.zoom, 220, 620);
      applyFrame(card, state.itemStates[id]);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      saveLayout();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
  });
  return handle;
}

function bindCanvasPan() {
  els.stageScroll.addEventListener("pointerdown", (event) => {
    if (event.target !== els.stageScroll && event.target !== els.stage) return;
    const start = { x: event.clientX, y: event.clientY, left: els.stageScroll.scrollLeft, top: els.stageScroll.scrollTop };
    els.stageScroll.classList.add("panning");
    els.stageScroll.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      els.stageScroll.scrollLeft = start.left - (moveEvent.clientX - start.x);
      els.stageScroll.scrollTop = start.top - (moveEvent.clientY - start.y);
    };
    const up = () => {
      els.stageScroll.classList.remove("panning");
      els.stageScroll.removeEventListener("pointermove", move);
    };
    els.stageScroll.addEventListener("pointermove", move);
    els.stageScroll.addEventListener("pointerup", up, { once: true });
    els.stageScroll.addEventListener("pointercancel", up, { once: true });
  });
  els.stageScroll.addEventListener("wheel", (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    setZoom(state.zoom + (event.deltaY < 0 ? 0.08 : -0.08));
  }, { passive: false });
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

function setZoom(value) {
  state.zoom = clamp(Math.round(value * 100) / 100, 0.35, 1.8);
  els.stage.style.transform = `scale(${state.zoom})`;
  updateZoomText();
  saveLayout();
}

function fitView() {
  const states = Object.values(state.itemStates);
  if (!states.length) return;
  const maxX = Math.max(...states.map((item) => item.x + item.width));
  const maxY = Math.max(...states.map((item) => item.y + item.height));
  const minX = Math.min(...states.map((item) => item.x));
  const minY = Math.min(...states.map((item) => item.y));
  const width = maxX - minX + 140;
  const height = maxY - minY + 140;
  const rect = els.stageScroll.getBoundingClientRect();
  setZoom(clamp(Math.min(rect.width / width, rect.height / height), 0.35, 1));
  els.stageScroll.scrollLeft = Math.max(0, (minX - 70) * state.zoom);
  els.stageScroll.scrollTop = Math.max(0, (minY - 70) * state.zoom);
}

function centerStage() {
  els.stageScroll.scrollLeft = 24;
  els.stageScroll.scrollTop = 24;
}

function applyFrame(element, frame) {
  element.style.left = `${frame.x}px`;
  element.style.top = `${frame.y}px`;
  element.style.width = `${frame.width}px`;
  if (!element.classList.contains("orphan")) element.style.minHeight = `${frame.height}px`;
}

async function loadLayout() {
  const layout = await db.get("layouts", state.documentKey);
  state.itemStates = layout?.itemStates ?? {};
  state.zoom = layout?.zoom ?? 1;
  setZoom(state.zoom);
}

async function saveLayout() {
  await db.set("layouts", state.documentKey, {
    version: 1,
    documentKey: state.documentKey,
    fileName: state.fileName,
    zoom: state.zoom,
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

function chevronSvg() {
  return '<svg viewBox="0 0 12 12"><path d="M3 4.5l3 3 3-3"/></svg>';
}

function cardSvg() {
  return '<svg viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" rx="2"/></svg>';
}

function lineSvg() {
  return '<svg viewBox="0 0 12 12"><path d="M2 4h8M2 7h6"/></svg>';
}
