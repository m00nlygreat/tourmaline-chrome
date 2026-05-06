(() => {
  const fileUrl = location.href;
  const fileName = decodeURIComponent(
    new URL(fileUrl).pathname.split(/[\\/]/).filter(Boolean).pop() || "Markdown.md"
  );
  const markdown = document.body?.innerText || document.documentElement.textContent || "";

  window.__TOURMALINE_FILE__ = {
    markdown,
    fileName,
    fileUrl
  };

  document.documentElement.lang = "ko";
  document.title = `Tourmaline - ${fileName}`;
  document.body.replaceChildren();
  document.body.insertAdjacentHTML(
    "afterbegin",
    `
    <div class="app">
      <header class="toolbar">
        <div class="toolbar-logo" aria-hidden="true">
          <svg viewBox="0 0 14 14"><polygon points="7,1 13,4.5 13,9.5 7,13 1,9.5 1,4.5"/></svg>
        </div>
        <nav class="breadcrumbs" id="breadcrumbs"></nav>
        <div class="toolbar-actions">
          <button class="toolbar-btn icon-only" id="zoom-out" title="Zoom out" aria-label="Zoom out">
            <svg viewBox="0 0 16 16"><path d="M3 8h10"/></svg>
          </button>
          <button class="zoom-display" id="zoom-reset" title="Reset zoom">100%</button>
          <button class="toolbar-btn icon-only" id="zoom-in" title="Zoom in" aria-label="Zoom in">
            <svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>
          </button>
          <button class="toolbar-btn" id="open-folder">
            <svg viewBox="0 0 16 16"><path d="M2 5h5l1.5 2H14v6H2z"/><path d="M2 5V3h4l1.5 2"/></svg>
            Folder
          </button>
          <button class="toolbar-btn" id="open-file">
            <svg viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v4h3"/></svg>
            Open .md
          </button>
          <button class="toolbar-btn primary" id="save-file">Save</button>
        </div>
      </header>

      <main class="workspace">
        <aside class="layer-panel" id="layer-panel">
          <div class="layer-panel-header">
            <span class="layer-eyebrow">LAYERS</span>
            <div class="layer-header-actions">
              <button class="icon-btn" id="fit-view" title="Fit view" aria-label="Fit view">
                <svg viewBox="0 0 16 16"><path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3"/></svg>
              </button>
            </div>
          </div>
          <div class="layer-scope-header">
            <span class="layer-scope-title" id="scope-title">Document</span>
            <span class="layer-scope-meta" id="scope-meta">0 items</span>
          </div>
          <div class="layer-tree" id="layer-tree"></div>
          <div class="layer-resize-handle" id="layer-resize"></div>
        </aside>

        <section class="editor-panel">
          <div class="editor-header">
            <span>MARKDOWN</span>
            <span id="editor-meta">file</span>
          </div>
          <textarea id="markdown-editor" spellcheck="false"></textarea>
        </section>

        <section class="canvas-area" id="canvas-area">
          <div class="stage-scroll" id="stage-scroll">
            <div class="stage" id="stage"></div>
          </div>
        </section>
      </main>

      <footer class="statusbar">
        <div class="status-dot"></div>
        <span id="status-text">Ready</span>
        <span>*</span>
        <span id="file-label">Untitled.md</span>
        <span>*</span>
        <span id="item-count">0 items</span>
        <span class="spacer"></span>
        <span id="zoom-status">Zoom 100%</span>
      </footer>
    </div>
    `
  );
})();
