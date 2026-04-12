(function (global) {
  const diagramCache = new Map();
  const EXT_PREFIX = "ext:";

  const DEFAULT_OPTIONS = {
    height: 560,
    showToolbar: true,
    showBackButton: false,
    showDownloadButton: true,
    backLabel: "Voltar",
    downloadLabel: "Baixar diagrama",
    backIcon: '<i class="fa-solid fa-rotate-left"></i>',
    downloadIcon: '<i class="fa-solid fa-cloud-arrow-down"></i>',
    enableZoom: true,
    showViewControls: true,
    showZoomControls: true,
    resetViewLabel: "Resetar visualizacao",
    expandLabel: "Expandir diagrama",
    closeModalLabel: "Fechar",
    resetViewIcon: '<i class="fa-solid fa-arrows-rotate"></i>',
    expandIcon: '<i class="fa-solid fa-expand"></i>',
    closeModalIcon: '<i class="fa-solid fa-xmark"></i>',
    minZoom: 0.25,
    maxZoom: 4,
    zoomStep: 0.2,
    enableCache: true,
    theme: "default",
    fetchOptions: {
      cache: "no-store",
    },
  };

  function ensureMermaid(theme) {
    if (!global.mermaid) {
      throw new Error(
        "Mermaid nao encontrado. Inclua o script do Mermaid antes do plugin."
      );
    }

    if (!global.__distributedMermaidInitialized) {
      global.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "loose",
        theme: theme || "default",
        flowchart: {
          useMaxWidth: true,
          htmlLabels: true,
        },
      });
      global.__distributedMermaidInitialized = true;
    }
  }

  function normalizeUrl(url, base) {
    return new URL(url, base || global.location.href).toString();
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeCssId(value) {
    if (global.CSS && typeof global.CSS.escape === "function") {
      return global.CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9\-_]/g, "\\$&");
  }

  function iconButton({ role, label, icon, disabled = false }) {
    const safeLabel = escapeHtml(label);
    const disabledAttr = disabled ? " disabled" : "";

    return `
      <button type="button" data-role="${role}" title="${safeLabel}" aria-label="${safeLabel}"${disabledAttr}>
        <span class="dm-icon" aria-hidden="true">${icon}</span>
      </button>
    `;
  }

  function getFileName(url) {
    return new URL(url, global.location.href).pathname.split("/").pop() || url;
  }

  function extractTitle(content, url) {
    const title = content.match(/%%\s*title:\s*(.+)/i);
    if (title) return title[1].trim();
    return getFileName(url).replace(/\.(mmd|md|txt)$/i, "") || "Diagrama";
  }

  function parseExternalLinks(content, baseUrl) {
    const links = new Map();
    const pattern =
      /^\s*click\s+([^\s]+)\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))(?:\s+["'][^"']*["'])?/gim;

    let match;
    while ((match = pattern.exec(content)) !== null) {
      const nodeId = match[1];
      const rawUrl = match[2] || match[3] || match[4] || "";

      if (!rawUrl.startsWith(EXT_PREFIX)) continue;

      const targetUrl = rawUrl.slice(EXT_PREFIX.length).trim();
      if (!targetUrl) continue;

      links.set(nodeId, {
        src: normalizeUrl(targetUrl, baseUrl),
        title: getFileName(targetUrl),
      });
    }

    return links;
  }

  async function fetchText(url, options) {
    const fetchOptions = { ...DEFAULT_OPTIONS.fetchOptions, ...(options || {}) };
    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ao buscar "${url}"`);
    }

    return response.text();
  }

  async function loadDiagram(src, options = {}) {
    const normalized = normalizeUrl(src);

    if (options.enableCache !== false && diagramCache.has(normalized)) {
      return diagramCache.get(normalized);
    }

    const content = await fetchText(normalized, options.fetchOptions);
    const diagram = {
      src: normalized,
      title: extractTitle(content, normalized),
      content,
      links: parseExternalLinks(content, normalized),
    };

    if (options.enableCache !== false) {
      diagramCache.set(normalized, diagram);
    }

    return diagram;
  }

  class DistributedMermaidViewer {
    constructor(options) {
      const merged = { ...DEFAULT_OPTIONS, ...(options || {}) };
      ensureMermaid(merged.theme);

      if (!merged.element) {
        throw new Error("Parametro 'element' e obrigatorio.");
      }

      if (!merged.initialSrc) {
        throw new Error("Parametro 'initialSrc' e obrigatorio.");
      }

      this.options = merged;
      this.root = merged.element;
      this.initialSrc = normalizeUrl(merged.initialSrc);
      this.current = null;
      this.history = [];
      this.zoom = {
        scale: 1,
        x: 0,
        y: 0,
        dragging: false,
        lastX: 0,
        lastY: 0,
      };
      this.modalZoom = {
        scale: 1,
        x: 0,
        y: 0,
        dragging: false,
        lastX: 0,
        lastY: 0,
      };

      this.root.classList.add("distributed-mermaid-viewer");
      this.root.innerHTML = this.buildShell();

      this.titleEl = this.root.querySelector("[data-role='title']");
      this.fileEl = this.root.querySelector("[data-role='file']");
      this.backBtn = this.root.querySelector("[data-role='back']");
      this.downloadBtn = this.root.querySelector("[data-role='download']");
      this.resetViewBtn = this.root.querySelector("[data-role='reset-view']");
      this.expandBtn = this.root.querySelector("[data-role='expand']");
      this.closeModalBtn = this.root.querySelector("[data-role='close-modal']");
      this.statusEl = this.root.querySelector("[data-role='status']");
      this.canvasEl = this.root.querySelector("[data-role='canvas']");
      this.stageEl = this.root.querySelector("[data-role='stage']");
      this.modalEl = this.root.querySelector("[data-role='modal']");
      this.modalDialogEl = this.root.querySelector("[data-role='modal-dialog']");
      this.modalStageEl = this.root.querySelector("[data-role='modal-stage']");

      this.canvasEl.style.minHeight = `${merged.height}px`;
      this.backBtn?.addEventListener("click", () => this.goBack());
      this.downloadBtn?.addEventListener("click", () => this.downloadCurrent());
      this.resetViewBtn?.addEventListener("click", () => this.resetView());
      this.expandBtn?.addEventListener("click", () => this.openModal());
      this.closeModalBtn?.addEventListener("click", () => this.closeModal());
      this.modalEl?.addEventListener("click", (event) => {
        if (event.target === this.modalEl) this.closeModal();
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") this.closeModal();
      });
      this.attachPanZoomHandlers();
      this.attachModalPanZoomHandlers();
    }

    buildShell() {
      const viewControls =
        this.options.showViewControls && this.options.showZoomControls
          ? `
            <div class="dm-view-actions" aria-label="Controles de visualizacao">
              ${iconButton({
                role: "reset-view",
                label: this.options.resetViewLabel,
                icon: this.options.resetViewIcon,
              })}
              ${iconButton({
                role: "expand",
                label: this.options.expandLabel,
                icon: this.options.expandIcon,
              })}
            </div>
          `
          : "";

      return `
        <div class="dm-toolbar" ${this.options.showToolbar ? "" : 'style="display:none"'}>
          <div>
            <div class="dm-title" data-role="title">Carregando...</div>
            <div class="dm-file" data-role="file"></div>
          </div>
          <div class="dm-actions">
            ${viewControls}
            ${
              this.options.showBackButton
                ? iconButton({
                    role: "back",
                    label: this.options.backLabel,
                    icon: this.options.backIcon,
                    disabled: true,
                  })
                : ""
            }
            ${
              this.options.showDownloadButton
                ? iconButton({
                    role: "download",
                    label: this.options.downloadLabel,
                    icon: this.options.downloadIcon,
                  })
                : ""
            }
          </div>
        </div>
        <div class="dm-status" data-role="status"></div>
        <div class="dm-canvas" data-role="canvas">
          <div class="dm-stage" data-role="stage"></div>
        </div>
        <div class="dm-modal" data-role="modal" aria-hidden="true">
          <div class="dm-modal-dialog" data-role="modal-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(this.options.expandLabel)}">
            <button class="dm-modal-close" type="button" data-role="close-modal" title="${escapeHtml(this.options.closeModalLabel)}" aria-label="${escapeHtml(this.options.closeModalLabel)}">
              <span class="dm-icon" aria-hidden="true">${this.options.closeModalIcon}</span>
            </button>
            <div class="dm-modal-stage" data-role="modal-stage"></div>
          </div>
        </div>
      `;
    }

    async start() {
      await this.open(this.initialSrc, { pushHistory: false });
    }

    setStatus(message, isError = false) {
      this.statusEl.textContent = message || "";
      this.statusEl.className = isError ? "dm-status dm-status--error" : "dm-status";
    }

    updateToolbar() {
      this.titleEl.textContent = this.current?.title || "Diagrama";
      this.fileEl.textContent = this.current?.src || "";
      if (this.backBtn) this.backBtn.disabled = this.history.length === 0;
      if (this.downloadBtn) this.downloadBtn.disabled = !this.current;
    }

    async open(src, options = {}) {
      const { pushHistory = true, clearHistory = false } = options;

      try {
        this.setStatus("Carregando diagrama...");
        const next = await loadDiagram(src, this.options);

        if (clearHistory) {
          this.history = [];
        }

        if (pushHistory && this.current) {
          this.history.push(this.current.src);
        }

        this.current = next;
        this.updateToolbar();
        await this.renderCurrent();
        this.setStatus("");
      } catch (error) {
        console.error(error);
        this.setStatus(error.message || "Erro ao carregar diagrama.", true);
      }
    }

    async renderCurrent() {
      if (!this.current) return;

      const renderId = `dm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = await global.mermaid.render(renderId, this.current.content);
      const svg = typeof result === "string" ? result : result.svg;

      this.stageEl.innerHTML = svg;
      this.resetZoom();
      this.closeModal();

      if (result.bindFunctions) {
        result.bindFunctions(this.stageEl);
      }

      this.decorateExternalLinks();
    }

    decorateExternalLinks(root = this.stageEl) {
      this.decorateHrefLinks(root);
      this.decorateNodeLinks(root);
    }

    decorateHrefLinks(root = this.stageEl) {
      const anchors = root.querySelectorAll("a[href], a[*|href]");

      anchors.forEach((anchor) => {
        const raw =
          anchor.getAttribute("href") ||
          anchor.getAttributeNS("http://www.w3.org/1999/xlink", "href") ||
          "";
        const linkedSrc = anchor.dataset.dmLinked || "";

        if (!raw.startsWith(EXT_PREFIX) && !linkedSrc) return;

        const targetSrc = raw.startsWith(EXT_PREFIX)
          ? raw.slice(EXT_PREFIX.length).trim()
          : linkedSrc;

        const target = {
          src: normalizeUrl(targetSrc, this.current.src),
          title: getFileName(targetSrc),
        };

        anchor.setAttribute("href", "#");
        anchor.removeAttribute("target");
        delete anchor.dataset.dmLinked;
        this.makeClickable(anchor, target);
      });
    }

    decorateNodeLinks(root = this.stageEl) {
      for (const [nodeId, target] of this.current.links.entries()) {
        const selectors = [
          `#${escapeCssId(nodeId)}`,
          `g[id="${nodeId}"]`,
          `[id="${nodeId}"]`,
          `#flowchart-${escapeCssId(nodeId)}-0`,
          `[id^="flowchart-${nodeId}-"]`,
        ];

        let node = null;
        for (const selector of selectors) {
          node = root.querySelector(selector);
          if (node) break;
        }

        if (node) {
          delete node.dataset.dmLinked;
          this.makeClickable(node, target);
        }
      }
    }

    async resetView() {
      if (!this.current || this.current.src === this.initialSrc) {
        this.history = [];
        this.updateToolbar();
        this.resetZoom();
        this.closeModal();
        return;
      }

      await this.open(this.initialSrc, {
        pushHistory: false,
        clearHistory: true,
      });
    }

    makeClickable(node, target) {
      if (!node || node.dataset.dmLinked === target.src) return;

      node.dataset.dmLinked = target.src;
      node.classList.add("dm-clickable");
      node.setAttribute("tabindex", "0");
      node.setAttribute("role", "button");
      node.setAttribute("aria-label", `Abrir ${target.title || target.src}`);

      const openTarget = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await this.open(target.src, { pushHistory: true });
      };

      node.addEventListener("click", openTarget);
      node.addEventListener("keydown", async (event) => {
        if (event.key === "Enter" || event.key === " ") {
          await openTarget(event);
        }
      });
    }

    async goBack() {
      if (this.history.length === 0) return;

      const previous = this.history.pop();
      await this.open(previous, { pushHistory: false });
    }

    downloadCurrent() {
      if (!this.current) return;

      const blob = new Blob([this.current.content], {
        type: "text/plain;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = getFileName(this.current.src) || "diagrama.mmd";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }

    attachPanZoomHandlers() {
      if (!this.options.enableZoom) return;

      this.canvasEl.addEventListener(
        "wheel",
        (event) => {
          event.preventDefault();
          this.zoomAt(event.deltaY < 0 ? 1 : -1, event.clientX, event.clientY);
        },
        { passive: false }
      );

      this.canvasEl.addEventListener("pointerdown", (event) => {
        const target = event.target;
        const isClickable =
          target instanceof Element && target.closest(".dm-clickable");

        if (event.button !== 0 || isClickable) return;

        this.zoom.dragging = true;
        this.zoom.lastX = event.clientX;
        this.zoom.lastY = event.clientY;
        this.canvasEl.classList.add("dm-canvas--dragging");
        this.canvasEl.setPointerCapture(event.pointerId);
      });

      this.canvasEl.addEventListener("pointermove", (event) => {
        if (!this.zoom.dragging) return;

        this.zoom.x += event.clientX - this.zoom.lastX;
        this.zoom.y += event.clientY - this.zoom.lastY;
        this.zoom.lastX = event.clientX;
        this.zoom.lastY = event.clientY;
        this.applyZoom();
      });

      this.canvasEl.addEventListener("pointerup", (event) => {
        this.stopDragging(event);
      });

      this.canvasEl.addEventListener("pointercancel", (event) => {
        this.stopDragging(event);
      });
    }

    attachModalPanZoomHandlers() {
      if (!this.options.enableZoom || !this.modalDialogEl) return;

      this.modalDialogEl.addEventListener(
        "wheel",
        (event) => {
          event.preventDefault();
          this.modalZoomAt(
            event.deltaY < 0 ? 1 : -1,
            event.clientX,
            event.clientY
          );
        },
        { passive: false }
      );

      this.modalDialogEl.addEventListener("pointerdown", (event) => {
        const target = event.target;
        const isBlocked =
          target instanceof Element &&
          (target.closest(".dm-clickable") ||
            target.closest("[data-role='close-modal']"));

        if (event.button !== 0 || isBlocked) return;

        this.modalZoom.dragging = true;
        this.modalZoom.lastX = event.clientX;
        this.modalZoom.lastY = event.clientY;
        this.modalDialogEl.classList.add("dm-modal-dialog--dragging");
        this.modalDialogEl.setPointerCapture(event.pointerId);
      });

      this.modalDialogEl.addEventListener("pointermove", (event) => {
        if (!this.modalZoom.dragging) return;

        this.modalZoom.x += event.clientX - this.modalZoom.lastX;
        this.modalZoom.y += event.clientY - this.modalZoom.lastY;
        this.modalZoom.lastX = event.clientX;
        this.modalZoom.lastY = event.clientY;
        this.applyModalZoom();
      });

      this.modalDialogEl.addEventListener("pointerup", (event) => {
        this.stopModalDragging(event);
      });

      this.modalDialogEl.addEventListener("pointercancel", (event) => {
        this.stopModalDragging(event);
      });
    }

    stopDragging(event) {
      if (!this.zoom.dragging) return;

      this.zoom.dragging = false;
      this.canvasEl.classList.remove("dm-canvas--dragging");

      if (this.canvasEl.hasPointerCapture(event.pointerId)) {
        this.canvasEl.releasePointerCapture(event.pointerId);
      }
    }

    zoomBy(direction) {
      const rect = this.canvasEl.getBoundingClientRect();
      this.zoomAt(
        direction,
        rect.left + rect.width / 2,
        rect.top + rect.height / 2
      );
    }

    zoomAt(direction, clientX, clientY) {
      const rect = this.canvasEl.getBoundingClientRect();
      const previousScale = this.zoom.scale;
      const nextScale = this.clampZoom(
        previousScale + direction * this.options.zoomStep
      );

      if (nextScale === previousScale) return;

      const pointX = clientX - rect.left;
      const pointY = clientY - rect.top;
      const contentX = (pointX - this.zoom.x) / previousScale;
      const contentY = (pointY - this.zoom.y) / previousScale;

      this.zoom.scale = nextScale;
      this.zoom.x = pointX - contentX * nextScale;
      this.zoom.y = pointY - contentY * nextScale;
      this.applyZoom();
    }

    stopModalDragging(event) {
      if (!this.modalZoom.dragging || !this.modalDialogEl) return;

      this.modalZoom.dragging = false;
      this.modalDialogEl.classList.remove("dm-modal-dialog--dragging");

      if (this.modalDialogEl.hasPointerCapture(event.pointerId)) {
        this.modalDialogEl.releasePointerCapture(event.pointerId);
      }
    }

    modalZoomAt(direction, clientX, clientY) {
      if (!this.modalDialogEl) return;

      const rect = this.modalDialogEl.getBoundingClientRect();
      const previousScale = this.modalZoom.scale;
      const nextScale = this.clampZoom(
        previousScale + direction * this.options.zoomStep
      );

      if (nextScale === previousScale) return;

      const pointX = clientX - rect.left;
      const pointY = clientY - rect.top;
      const contentX = (pointX - this.modalZoom.x) / previousScale;
      const contentY = (pointY - this.modalZoom.y) / previousScale;

      this.modalZoom.scale = nextScale;
      this.modalZoom.x = pointX - contentX * nextScale;
      this.modalZoom.y = pointY - contentY * nextScale;
      this.applyModalZoom();
    }

    clampZoom(value) {
      return Math.min(
        this.options.maxZoom,
        Math.max(this.options.minZoom, Number(value.toFixed(2)))
      );
    }

    resetZoom() {
      this.zoom.scale = 1;
      this.zoom.x = 0;
      this.zoom.y = 0;
      this.applyZoom();
    }

    applyZoom() {
      if (!this.stageEl) return;

      this.stageEl.style.transform = `translate(${this.zoom.x}px, ${this.zoom.y}px) scale(${this.zoom.scale})`;
    }

    resetModalZoom() {
      this.modalZoom.scale = 1;
      this.modalZoom.x = 0;
      this.modalZoom.y = 0;
      this.applyModalZoom();
    }

    applyModalZoom() {
      if (!this.modalStageEl) return;

      this.modalStageEl.style.transform = `translate(${this.modalZoom.x}px, ${this.modalZoom.y}px) scale(${this.modalZoom.scale})`;
    }

    openModal() {
      if (!this.modalEl || !this.modalStageEl || !this.stageEl.innerHTML) return;

      this.modalStageEl.innerHTML = this.stageEl.innerHTML;
      this.resetModalZoom();
      this.decorateExternalLinks(this.modalStageEl);
      this.modalEl.classList.add("dm-modal--open");
      this.modalEl.setAttribute("aria-hidden", "false");
      document.body.classList.add("dm-modal-open");
      this.closeModalBtn?.focus();
    }

    closeModal() {
      if (!this.modalEl || !this.modalEl.classList.contains("dm-modal--open")) {
        return;
      }

      this.modalZoom.dragging = false;
      this.modalDialogEl?.classList.remove("dm-modal-dialog--dragging");
      this.modalEl.classList.remove("dm-modal--open");
      this.modalEl.setAttribute("aria-hidden", "true");
      document.body.classList.remove("dm-modal-open");
      if (this.modalStageEl) this.modalStageEl.innerHTML = "";
      this.resetModalZoom();
      this.expandBtn?.focus();
    }
  }

  function injectDefaultStyles() {
    if (document.getElementById("distributed-mermaid-styles")) {
      return;
    }

    const style = document.createElement("style");
    style.id = "distributed-mermaid-styles";
    style.textContent = `
      .distributed-mermaid-viewer {
        border: 1px solid #d0d7de;
        border-radius: 8px;
        padding: 16px;
        background: #fff;
      }

      .dm-toolbar {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
        margin-bottom: 12px;
      }

      .dm-title {
        font-weight: 700;
        font-size: 16px;
      }

      .dm-file {
        margin-top: 4px;
        color: #57606a;
        font-size: 12px;
        word-break: break-all;
      }

      .dm-actions,
      .dm-view-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .dm-actions {
        flex-shrink: 0;
      }

      .dm-actions button {
        border: 1px solid #d0d7de;
        background: #f6f8fa;
        color: #24292f;
        border-radius: 8px;
        width: 36px;
        height: 36px;
        padding: 0;
        text-decoration: none;
        font-size: 14px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .dm-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
      }

      .dm-actions button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .dm-status {
        min-height: 24px;
        margin-bottom: 8px;
        color: #57606a;
      }

      .dm-status--error {
        color: #cf222e;
      }

      .dm-canvas {
        overflow: hidden;
        position: relative;
        cursor: grab;
        touch-action: none;
        border: 1px solid #d8dee4;
        border-radius: 8px;
      }

      .dm-canvas--dragging {
        cursor: grabbing;
      }

      .dm-stage {
        min-width: 100%;
        min-height: inherit;
        transform-origin: 0 0;
        transition: transform 120ms ease;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .dm-canvas--dragging .dm-stage {
        transition: none;
      }

      .dm-stage svg {
        display: block;
        max-width: none;
        height: auto;
        margin: 0;
      }

      body.dm-modal-open {
        overflow: hidden;
      }

      .dm-modal {
        display: none;
        position: fixed;
        inset: 0;
        z-index: 9999;
        background: rgba(31, 35, 40, 0.65);
        padding: 32px;
      }

      .dm-modal--open {
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .dm-modal-dialog {
        position: relative;
        width: min(1200px, 96vw);
        height: min(820px, 90vh);
        overflow: hidden;
        cursor: grab;
        touch-action: none;
        border: 1px solid #d0d7de;
        border-radius: 8px;
        background: #fff;
        padding: 48px 24px 24px;
      }

      .dm-modal-dialog--dragging {
        cursor: grabbing;
      }

      .dm-modal-dialog--dragging .dm-modal-stage {
        transition: none;
      }

      .dm-modal-close {
        position: absolute;
        top: 12px;
        right: 12px;
        z-index: 1;
        border: 1px solid #d0d7de;
        background: #f6f8fa;
        color: #24292f;
        border-radius: 8px;
        width: 36px;
        height: 36px;
        padding: 0;
        font-size: 14px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .dm-modal-stage {
        min-width: 100%;
        min-height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        transform-origin: 0 0;
        transition: transform 120ms ease;
      }

      .dm-modal-stage svg {
        display: block;
        max-width: none;
        height: auto;
      }

      @media (max-width: 640px) {
        .dm-modal {
          padding: 12px;
        }

        .dm-modal-dialog {
          width: 100%;
          height: 92vh;
          padding: 56px 12px 16px;
        }
      }

      .dm-clickable,
      .dm-clickable * {
        cursor: pointer;
      }

      .dm-clickable rect,
      .dm-clickable polygon,
      .dm-clickable path {
        stroke-width: 2px !important;
      }
    `;
    document.head.appendChild(style);
  }

  injectDefaultStyles();

  global.Flowbridge = {
    Viewer: DistributedMermaidViewer,
    loadDiagram,
  };
  global.DistributedMermaid = global.Flowbridge;
})(window);
