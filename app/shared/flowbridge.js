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
    minZoom: 0.1,
    maxZoom: 8,
    zoomStep: 0.25,
    enableCache: true,
    baseUrl: "",
    theme: "default",
    fetchOptions: {
      cache: "no-store",
    },
  };

  const BUILTIN_FA_ICON_PACK = {
    prefix: "fa",
    icons: {
      terminal: {
        width: 640,
        height: 512,
        body: '<path fill="currentColor" d="M64 96C46.3 96 32 110.3 32 128v256c0 17.7 14.3 32 32 32h512c17.7 0 32-14.3 32-32V128c0-17.7-14.3-32-32-32H64zm64 72c9.4-9.4 24.6-9.4 33.9 0l80 80c9.4 9.4 9.4 24.6 0 33.9l-80 80c-9.4 9.4-24.6 9.4-33.9 0s-9.4-24.6 0-33.9l63-63-63-63c-9.4-9.4-9.4-24.6 0-33.9zM288 336h160c13.3 0 24 10.7 24 24s-10.7 24-24 24H288c-13.3 0-24-10.7-24-24s10.7-24 24-24z"/>',
      },
      "fa-terminal": {
        parent: "terminal",
      },
    },
  };

  function ensureMermaid(theme) {
    if (!global.mermaid) {
      throw new Error(
        "Mermaid nao encontrado. Inclua o script do Mermaid antes do plugin."
      );
    }

    if (!global.__flowbridgeMermaidIconsRegistered) {
      global.mermaid.registerIconPacks?.([
        { name: "fa", icons: BUILTIN_FA_ICON_PACK },
        { name: "fas", icons: BUILTIN_FA_ICON_PACK },
      ]);
      global.__flowbridgeMermaidIconsRegistered = true;
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

  function normalizeBasePath(baseUrl) {
    if (!baseUrl) return "/";

    const pathname = new URL(baseUrl, global.location.origin).pathname || "/";
    return `/${pathname.replace(/^\/+|\/+$/g, "")}/`.replace(/\/{2,}/g, "/");
  }

  function resolveFlowbridgeUrl(url, base, siteBaseUrl) {
    const value = String(url || "").trim();
    if (!value) return normalizeUrl(value, base);

    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) {
      return normalizeUrl(value, base);
    }

    if (!value.startsWith("/")) {
      return normalizeUrl(value, base);
    }

    const basePath = normalizeBasePath(siteBaseUrl);
    if (basePath === "/" || value === basePath || value.startsWith(basePath)) {
      return normalizeUrl(value, global.location.origin);
    }

    return normalizeUrl(`${basePath.replace(/\/$/, "")}${value}`, global.location.origin);
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

  function parseExternalLinks(content, baseUrl, siteBaseUrl) {
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
        src: resolveFlowbridgeUrl(targetUrl, baseUrl, siteBaseUrl),
        title: getFileName(targetUrl),
      });
    }

    return links;
  }

  function stripMermaidComment(line) {
    return String(line || "").replace(/^\s*%%\s?/, "");
  }

  function parseAnnotationText(text) {
    const raw = String(text || "").trim();
    if (!raw) {
      return { title: "Detalhes", body: "", fields: [], links: [] };
    }

    const parts = raw.split(/\s+\|\s+/);
    if (parts.length > 1) {
      return {
        title: parts.shift().trim() || "Detalhes",
        body: parts.join(" | ").trim(),
        fields: [],
        links: [],
      };
    }

    return { title: "Detalhes", body: raw, fields: [], links: [] };
  }

  function normalizeAnnotationKey(key) {
    return String(key || "").trim().toLowerCase();
  }

  function humanizeAnnotationKey(key) {
    const labels = {
      owner: "Owner",
      sla: "SLA",
      since: "Desde",
      tags: "Tags",
      alert: "Alerta",
      description: "Descricao",
    };
    const normalized = normalizeAnnotationKey(key);
    return labels[normalized] || String(key || "").trim();
  }

  function parseAnnotationLink(value) {
    const parts = String(value || "").split(/\s+\|\s+/);
    if (parts.length > 1) {
      return {
        label: parts.shift().trim() || parts.join(" | ").trim(),
        href: parts.join(" | ").trim(),
      };
    }

    return {
      label: String(value || "").trim(),
      href: String(value || "").trim(),
    };
  }

  function parseAnnotationBlock(lines) {
    const cleanLines = lines.map(stripMermaidComment);
    let title = "";
    const body = [];
    const fields = [];
    const links = [];
    let readingBody = false;

    cleanLines.forEach((line) => {
      const titleMatch = line.match(/^\s*title\s*:\s*(.+)$/i);
      const bodyMatch = line.match(/^\s*body\s*:\s*$/i);
      const keyValueMatch = line.match(/^\s*([a-zA-Z][\w-]*)\s*:\s*(.*)$/);
      const headingMatch = line.match(/^\s*#\s+(.+)$/);

      if (!readingBody && titleMatch) {
        title = titleMatch[1].trim();
        return;
      }

      if (!readingBody && headingMatch && !title) {
        title = headingMatch[1].trim();
        return;
      }

      if (bodyMatch) {
        readingBody = true;
        return;
      }

      if (!readingBody && keyValueMatch) {
        const key = normalizeAnnotationKey(keyValueMatch[1]);
        const value = keyValueMatch[2].trim();

        if (key === "description") {
          body.push(value);
          return;
        }

        if (key === "link") {
          links.push(parseAnnotationLink(value));
          return;
        }

        fields.push({
          key,
          label: humanizeAnnotationKey(key),
          value,
        });
        return;
      }

      body.push(line);
    });

    if (!title) {
      const firstTextLine = body.find((line) => line.trim());
      title = firstTextLine ? firstTextLine.trim() : "Detalhes";
      if (firstTextLine) {
        body.splice(body.indexOf(firstTextLine), 1);
      }
    }

    return {
      title,
      body: body.join("\n").trim(),
      fields,
      links,
    };
  }

  function parseNodeAnnotations(content) {
    const annotations = new Map();
    const lines = String(content || "").split(/\r?\n/);
    const inlinePattern =
      /^\s*%%\s*(?:flowbridge:)?(?:tooltip|annotation)\s+([^\s:|]+)\s*(?::|\|)\s*(.+)$/i;
    const blockStartPattern =
      /^\s*%%\s*@?(?:flowbridge:)?(?:tooltip|annotation)\s+([^\s:|]+)\s*$/i;
    const blockEndPattern =
      /^\s*%%\s*@?(?:end(?:tooltip|annotation)?|endflowbridge)\s*$/i;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const inline = line.match(inlinePattern);
      if (inline) {
        annotations.set(inline[1], parseAnnotationText(inline[2]));
        continue;
      }

      const block = line.match(blockStartPattern);
      if (!block) continue;

      const nodeId = block[1];
      const blockLines = [];
      index += 1;

      while (index < lines.length && !blockEndPattern.test(lines[index])) {
        blockLines.push(lines[index]);
        index += 1;
      }

      annotations.set(nodeId, parseAnnotationBlock(blockLines));
    }

    return annotations;
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function cleanNodeLabel(value) {
    return String(value || "")
      .replace(/^["']|["']$/g, "")
      .replace(/^\s*fa[a-z]*:fa-[\w-]+\s+/i, "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, "")
      .trim();
  }

  function parseClassIconDirectives(content) {
    const icons = new Map();
    const pattern =
      /^\s*%%\s*(?:(?:flowbridge)\s*:?\s*)?(?:classIcon|class-icon)\s+([A-Za-z][\w-]*)\s+(\S+)\s*$/i;

    String(content || "")
      .split(/\r?\n/)
      .forEach((line) => {
        const match = line.match(pattern);
        if (!match) return;

        icons.set(match[1], match[2]);
      });

    return icons;
  }

  function parseClassStyles(content) {
    const styles = new Map();
    const pattern = /^\s*classDef\s+(.+?)\s+(.+?)\s*;?\s*$/i;

    String(content || "")
      .split(/\r?\n/)
      .forEach((line) => {
        const match = line.match(pattern);
        if (!match) return;

        const color = match[2].match(/(?:^|[,;])\s*color\s*:\s*([^,;]+)/i)?.[1]?.trim();
        if (!color) return;

        match[1]
          .split(",")
          .map((className) => className.trim())
          .filter(Boolean)
          .forEach((className) => styles.set(className, { color }));
      });

    return styles;
  }

  function addNodeClass(nodeClasses, nodeId, className) {
    if (!nodeClasses.has(nodeId)) {
      nodeClasses.set(nodeId, new Set());
    }

    nodeClasses.get(nodeId).add(className);
  }

  function parseNodeClasses(content) {
    const nodeClasses = new Map();
    const inlineClassPattern =
      /^\s*([A-Za-z][\w-]*)\s*(?:\(\[|\[\(|\[\[|\(\(|\[|\(|\{).+?(?:\]\)|\]\]|\)\]|\)\)|\]|\)|\})\s*:::\s*([A-Za-z][\w-]*(?:[,\s]+[A-Za-z][\w-]*)*)/;
    const classStatementPattern = /^\s*class\s+(.+?)\s+(.+?)\s*;?\s*$/i;

    String(content || "")
      .split(/\r?\n/)
      .forEach((line) => {
        if (/^\s*%%/.test(line)) return;

        const inline = line.match(inlineClassPattern);
        if (inline) {
          inline[2]
            .split(/[,\s]+/)
            .filter(Boolean)
            .forEach((className) => addNodeClass(nodeClasses, inline[1], className));
        }

        const statement = line.match(classStatementPattern);
        if (!statement) return;

        const nodeIds = statement[1].split(",").map((nodeId) => nodeId.trim()).filter(Boolean);
        const classNames = statement[2].split(/[,\s]+/).map((className) => className.trim()).filter(Boolean);

        nodeIds.forEach((nodeId) => {
          classNames.forEach((className) => addNodeClass(nodeClasses, nodeId, className));
        });
      });

    return nodeClasses;
  }

  function hasMermaidIcon(label) {
    return /^\s*fa[a-z]*:fa-[\w-]+(?:\s|$)/i.test(String(label || ""));
  }

  function findColorForClasses(classes, classStyles) {
    if (!classes) return "";

    for (const className of classes) {
      const color = classStyles.get(className)?.color;
      if (color) return color;
    }

    return "";
  }

  function findIconForClasses(classes, classIcons, classStyles) {
    if (!classes) return null;

    for (const className of classes) {
      const icon = classIcons.get(className);
      if (icon) {
        return {
          icon,
          color: classStyles.get(className)?.color || findColorForClasses(classes, classStyles),
        };
      }
    }

    return null;
  }

  function parseNodeLabels(content) {
    const labels = new Map();
    const lines = String(content || "").split(/\r?\n/);
    const nodePattern =
      /^\s*([A-Za-z][\w-]*)\s*(?:\(\[|\[\(|\[\[|\(\(|\[|\(|\{)(.+?)(?:\]\)|\]\]|\)\]|\)\)|\]|\)|\})/;

    lines.forEach((line) => {
      if (/^\s*%%/.test(line) || /^\s*(click|classDef|class|style|linkStyle)\b/i.test(line)) {
        return;
      }

      const match = line.match(nodePattern);
      if (!match) return;

      labels.set(match[1], cleanNodeLabel(match[2]));
    });

    return labels;
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
    const normalized = resolveFlowbridgeUrl(src, global.location.href, options.baseUrl);

    if (options.enableCache !== false && diagramCache.has(normalized)) {
      return diagramCache.get(normalized);
    }

    const content = await fetchText(normalized, options.fetchOptions);
    const diagram = {
      src: normalized,
      title: extractTitle(content, normalized),
      content,
      links: parseExternalLinks(content, normalized, options.baseUrl),
      annotations: parseNodeAnnotations(content),
      labels: parseNodeLabels(content),
      classIcons: parseClassIconDirectives(content),
      classStyles: parseClassStyles(content),
      nodeClasses: parseNodeClasses(content),
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
      this.initialSrc = resolveFlowbridgeUrl(merged.initialSrc, global.location.href, merged.baseUrl);
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
      this.tooltipHideTimer = null;

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
      this.tooltipEl = this.root.querySelector("[data-role='tooltip']");
      this.annotationNodes = new WeakMap();

      this.canvasEl.style.minHeight = `${merged.height}px`;
      this.backBtn?.addEventListener("click", () => this.goBack());
      this.downloadBtn?.addEventListener("click", () => this.downloadCurrent());
      this.resetViewBtn?.addEventListener("click", () => this.resetView());
      this.expandBtn?.addEventListener("click", () => this.openModal());
      this.closeModalBtn?.addEventListener("click", () => this.closeModal());
      this.tooltipEl?.addEventListener("pointerenter", () => this.cancelTooltipHide());
      this.tooltipEl?.addEventListener("pointerleave", () => this.scheduleTooltipHide());
      this.modalEl?.addEventListener("click", (event) => {
        if (event.target === this.modalEl) this.closeModal();
      });
      this.stageEl?.addEventListener("mousemove", (event) =>
        this.handleDelegatedAnnotationHover(event)
      );
      this.stageEl?.addEventListener("mouseleave", () => this.scheduleTooltipHide());
      this.stageEl?.addEventListener("focusin", (event) =>
        this.handleDelegatedAnnotationHover(event)
      );
      this.stageEl?.addEventListener("focusout", () => this.scheduleTooltipHide());
      this.modalStageEl?.addEventListener("mousemove", (event) =>
        this.handleDelegatedAnnotationHover(event)
      );
      this.modalStageEl?.addEventListener("mouseleave", () => this.scheduleTooltipHide());
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
        <div class="dm-tooltip" data-role="tooltip" role="tooltip" hidden></div>
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
      this.hideTooltip();

      if (result.bindFunctions) {
        result.bindFunctions(this.stageEl);
      }

      this.decorateExternalLinks();
    }

    decorateExternalLinks(root = this.stageEl) {
      this.removeMermaidTooltips(root);
      this.decorateClassIcons(root);
      this.decorateHrefLinks(root);
      this.decorateNodeLinks(root);
      this.decorateNodeAnnotations(root);
    }

    decorateClassIcons(root = this.stageEl) {
      if (!this.current?.classIcons?.size || !this.current?.nodeClasses?.size) return;

      for (const [nodeId, classes] of this.current.nodeClasses.entries()) {
        const iconConfig = findIconForClasses(classes, this.current.classIcons, this.current.classStyles);
        if (!iconConfig) continue;

        const node = this.findRenderedNode(root, nodeId);
        if (!node) continue;

        this.decorateRenderedNodeIcon(node, iconConfig.icon, this.current.labels?.get(nodeId), iconConfig.color);
      }
    }

    decorateRenderedNodeIcon(node, icon, label = "", iconColor = "") {
      const renderedIcon = this.resolveRenderedIcon(icon);
      if (!renderedIcon || node.querySelector('[data-flowbridge-icon="true"]')) return;
      const displayLabel = label || this.extractRenderedNodeLabel(node);

      node.classList.add("dm-icon-node");
      this.expandRenderedNodeForIcon(node);

      const htmlLabel = this.findNodeHtmlLabelElement(node, displayLabel);
      if (htmlLabel instanceof HTMLElement) {
        htmlLabel.dataset.flowbridgeIcon = "true";
        htmlLabel.classList.add("dm-node-icon");
        this.setHtmlLabelWithIcon(
          htmlLabel,
          renderedIcon,
          this.cleanRenderedLabel(htmlLabel.textContent || displayLabel),
          iconColor
        );
        return;
      }

      const textEl = this.findNodeTextElement(node, displayLabel);
      if (!textEl) return;

      textEl.setAttribute("data-flowbridge-icon", "true");
      if (iconColor && textEl instanceof SVGElement) {
        textEl.style.fill = iconColor;
      }
      textEl.textContent = `${renderedIcon.fallback} ${this.cleanRenderedLabel(textEl.textContent || displayLabel)}`;
    }

    setHtmlLabelWithIcon(labelEl, icon, label, iconColor = "") {
      labelEl.textContent = "";

      if (icon.svg) {
        const iconEl = document.createElement("span");
        iconEl.className = "dm-node-icon-svg";
        iconEl.setAttribute("aria-hidden", "true");
        iconEl.innerHTML = icon.svg;
        this.applyInlineIconColor(iconEl, iconColor);
        labelEl.appendChild(iconEl);
      } else {
        labelEl.appendChild(document.createTextNode(icon.fallback));
      }

      labelEl.appendChild(document.createTextNode(` ${label}`));
    }

    applyInlineIconColor(iconEl, iconColor = "") {
      if (!iconColor) return;

      iconEl.style.color = iconColor;
      iconEl.querySelectorAll("svg, g, path, polygon, circle, rect, line, polyline, ellipse").forEach((element) => {
        if (!(element instanceof SVGElement)) return;

        element.style.color = iconColor;

        const fill = element.getAttribute("fill");
        if (!fill || !/^(none|transparent)$/i.test(fill)) {
          element.setAttribute("fill", iconColor);
          element.style.setProperty("fill", iconColor, "important");
        }

        const stroke = element.getAttribute("stroke");
        if (!stroke || !/^(none|transparent)$/i.test(stroke)) {
          element.setAttribute("stroke", iconColor);
          element.style.setProperty("stroke", iconColor, "important");
        }
      });
    }

    findNodeHtmlLabelElement(node, label = "") {
      const expected = normalizeText(label);
      const candidates = Array.from(node.querySelectorAll("foreignObject p, foreignObject span, foreignObject div"))
        .filter((candidate) => candidate instanceof HTMLElement);

      if (expected) {
        const exact = candidates.find((candidate) => normalizeText(candidate.textContent) === expected);
        if (exact) return exact;
      }

      const leaf = candidates.find((candidate) =>
        normalizeText(candidate.textContent) &&
        !Array.from(candidate.children).some((child) => normalizeText(child.textContent))
      );
      if (leaf) return leaf;

      return candidates.find((candidate) => normalizeText(candidate.textContent)) || null;
    }

    findNodeTextElement(node, label = "") {
      const expected = normalizeText(label);
      const candidates = Array.from(node.querySelectorAll("tspan, text"));

      if (expected) {
        const exact = candidates.find((candidate) => normalizeText(candidate.textContent) === expected);
        if (exact) return exact;
      }

      return candidates.find((candidate) => normalizeText(candidate.textContent)) || null;
    }

    extractRenderedNodeLabel(node) {
      const text = Array.from(node.querySelectorAll("foreignObject p, foreignObject span, foreignObject div, tspan, text"))
        .map((candidate) => this.cleanRenderedLabel(candidate.textContent || ""))
        .find(Boolean);

      return text || "";
    }

    expandRenderedNodeForIcon(node) {
      const extraWidth = 36;
      const offset = extraWidth / 2;

      node.querySelectorAll("foreignObject").forEach((element) => {
        this.expandSvgNumericAttr(element, "width", extraWidth);
        this.expandSvgNumericAttr(element, "x", -offset);
      });

      node.querySelectorAll("rect").forEach((element) => {
        this.expandSvgNumericAttr(element, "width", extraWidth);
        this.expandSvgNumericAttr(element, "x", -offset);
      });
    }

    expandSvgNumericAttr(element, attr, delta) {
      const value = Number(element.getAttribute(attr));
      if (!Number.isFinite(value)) return;

      element.setAttribute(attr, String(value + delta));
    }

    cleanRenderedLabel(value) {
      return String(value || "")
        .replace(/^\s*>_\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
    }

    resolveRenderedIcon(icon) {
      const normalized = String(icon || "").trim().toLowerCase();

      const directAwsSvg = this.resolveAwsIcon(normalized, true);
      if (directAwsSvg) {
        return {
          svg: directAwsSvg,
          fallback: "",
        };
      }

      const match = normalized.match(/^(fa[a-z]*):fa-([\w-]+)$/);
      if (!match) return null;

      const prefix = match[1] === "fa" ? "fas" : match[1];
      const iconName = match[2];
      const faSvg = this.resolveFontAwesomeGlobalSvg(prefix, iconName);
      if (faSvg) {
        return {
          svg: faSvg,
          fallback: iconName === "terminal" ? ">_" : "",
        };
      }

      const awsSvg = this.resolveAwsIcon(iconName);
      if (awsSvg) {
        return {
          svg: awsSvg,
          fallback: "",
        };
      }

      if (iconName === "terminal") return { fallback: ">_" };

      return null;
    }

    resolveAwsIcon(icon, requireAwsPrefix = false) {
      const registry = global.FlowbridgeAwsIcons || null;
      if (!registry?.icons || !registry?.aliases) return "";

      const iconName = this.extractAwsIconName(icon, requireAwsPrefix);
      if (!iconName) return "";

      const slug = registry.aliases[iconName] || (registry.icons[iconName] ? iconName : "");
      if (!slug) return "";

      return registry.icons[slug] || "";
    }

    extractAwsIconName(icon, requireAwsPrefix = false) {
      const normalized = String(icon || "").trim().toLowerCase();
      const awsMatch = normalized.match(/^aws(?::|-)(?:fa-)?([\w-]+)$/);
      if (awsMatch) return awsMatch[1];

      if (requireAwsPrefix) return "";

      return normalized.replace(/^fa-/, "");
    }

    resolveFontAwesomeGlobalSvg(prefix, iconName) {
      const fa = global.FontAwesome || global.fontawesome || null;
      const icon = fa?.icon;
      if (typeof icon !== "function") return "";

      const result = icon({ prefix, iconName });
      return result?.html?.join?.("") || "";
    }

    removeMermaidTooltips(root = this.stageEl) {
      root.querySelectorAll("title").forEach((title) => title.remove());
      root.querySelectorAll("[title]").forEach((element) => element.removeAttribute("title"));
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
          src: resolveFlowbridgeUrl(targetSrc, this.current.src, this.options.baseUrl),
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
        const node = this.findRenderedNode(root, nodeId);

        if (node) {
          delete node.dataset.dmLinked;
          this.makeClickable(node, target);
        }
      }
    }

    decorateNodeAnnotations(root = this.stageEl) {
      if (!this.current?.annotations?.size) return;

      for (const [nodeId, annotation] of this.current.annotations.entries()) {
        const node = this.findRenderedNode(root, nodeId);
        if (!node || node.dataset.dmAnnotationBound === "true") continue;

        node.dataset.dmAnnotationBound = "true";
        node.classList.add("dm-annotated");
        this.annotationNodes.set(node, annotation);

        if (!node.hasAttribute("tabindex")) {
          node.setAttribute("tabindex", "0");
        }

        const show = (event) => this.showTooltip(annotation, event, node);
        const move = (event) => this.moveTooltip(event);
        const hide = (event) => {
          if (event?.relatedTarget && node.contains(event.relatedTarget)) return;
          this.scheduleTooltipHide();
        };

        node.addEventListener("pointerenter", show);
        node.addEventListener("pointermove", move);
        node.addEventListener("pointerleave", hide);
        node.addEventListener("mouseover", show);
        node.addEventListener("mousemove", move);
        node.addEventListener("mouseout", hide);
        node.addEventListener("focus", show);
        node.addEventListener("blur", hide);
      }
    }

    findRenderedNode(root, nodeId) {
      const selectors = [
        `#${escapeCssId(nodeId)}`,
        `g[id="${nodeId}"]`,
        `[id="${nodeId}"]`,
        `#flowchart-${escapeCssId(nodeId)}-0`,
        `[id^="flowchart-${nodeId}-"]`,
        `[data-id="${nodeId}"]`,
        `[data-node-id="${nodeId}"]`,
      ];

      for (const selector of selectors) {
        const node = root.querySelector(selector);
        if (node) return node;
      }

      const candidates = root.querySelectorAll("[id], [data-id], [data-node-id]");
      for (const candidate of candidates) {
        const id = candidate.getAttribute("id") || "";
        const dataId = candidate.getAttribute("data-id") || "";
        const dataNodeId = candidate.getAttribute("data-node-id") || "";

        if (
          id === nodeId ||
          dataId === nodeId ||
          dataNodeId === nodeId ||
          id.startsWith(`flowchart-${nodeId}-`)
        ) {
          return candidate;
        }
      }

      const label = this.current?.labels?.get(nodeId);
      if (label) {
        return this.findRenderedNodeByLabel(root, label);
      }

      return null;
    }

    findRenderedNodeByLabel(root, label) {
      const expected = normalizeText(label);
      if (!expected) return null;

      const candidates = root.querySelectorAll("g, text, tspan, span, div");
      for (const candidate of candidates) {
        if (normalizeText(candidate.textContent) !== expected) continue;

        return candidate.closest?.("g[id], g.node, g") || candidate;
      }

      return null;
    }

    handleDelegatedAnnotationHover(event) {
      const match = this.findAnnotationFromEvent(event);
      if (!match) {
        this.scheduleTooltipHide();
        return;
      }

      this.showTooltip(match.annotation, event, match.node);
    }

    findAnnotationFromEvent(event) {
      if (!this.current?.annotations?.size) return null;

      const path = typeof event.composedPath === "function"
        ? event.composedPath()
        : this.buildEventPath(event.target);

      for (const item of path) {
        if (!(item instanceof Element)) continue;

        const annotation = this.findAnnotationForElement(item);
        if (annotation) {
          return { annotation, node: item };
        }
      }

      return null;
    }

    buildEventPath(target) {
      const path = [];
      let current = target;

      while (current) {
        path.push(current);
        current = current.parentNode;
      }

      return path;
    }

    findAnnotationForElement(element) {
      const ids = [
        element.getAttribute("data-id"),
        element.getAttribute("data-node-id"),
        element.getAttribute("id"),
      ].filter(Boolean);

      for (const id of ids) {
        const exact = this.current.annotations.get(id);
        if (exact) return exact;

        const flowchartMatch = id.match(/^flowchart-(.+)-\d+$/);
        if (flowchartMatch && this.current.annotations.has(flowchartMatch[1])) {
          return this.current.annotations.get(flowchartMatch[1]);
        }

        for (const [nodeId, annotation] of this.current.annotations.entries()) {
          if (id.startsWith(`flowchart-${nodeId}-`)) {
            return annotation;
          }
        }
      }

      const text = normalizeText(element.textContent);
      if (text) {
        for (const [nodeId, label] of this.current.labels || []) {
          if (normalizeText(label) === text && this.current.annotations.has(nodeId)) {
            return this.current.annotations.get(nodeId);
          }
        }
      }

      return null;
    }

    showTooltip(annotation, event, node) {
      if (!this.tooltipEl || !annotation) return;

      this.cancelTooltipHide();
      this.tooltipEl.innerHTML = this.renderTooltip(annotation);
      this.bindTooltipLinks(annotation);
      this.tooltipEl.hidden = false;
      this.tooltipEl.classList.add("dm-tooltip--visible");
      this.moveTooltip(event, node);
    }

    moveTooltip(event, node) {
      if (!this.tooltipEl || this.tooltipEl.hidden) return;

      const offset = 18;
      const rect = this.tooltipEl.getBoundingClientRect();
      const sourceRect = node?.getBoundingClientRect?.();
      const clientX = Number.isFinite(event?.clientX)
        ? event.clientX
        : (sourceRect ? sourceRect.right : 24);
      const clientY = Number.isFinite(event?.clientY)
        ? event.clientY
        : (sourceRect ? sourceRect.top : 24);
      const maxLeft = global.innerWidth - rect.width - 12;
      const maxTop = global.innerHeight - rect.height - 12;
      const left = Math.max(12, Math.min(clientX + offset, maxLeft));
      const top = Math.max(12, Math.min(clientY + offset, maxTop));

      this.tooltipEl.style.left = `${left}px`;
      this.tooltipEl.style.top = `${top}px`;
    }

    hideTooltip() {
      if (!this.tooltipEl) return;

      this.cancelTooltipHide();
      this.tooltipEl.hidden = true;
      this.tooltipEl.classList.remove("dm-tooltip--visible");
      this.tooltipEl.innerHTML = "";
    }

    scheduleTooltipHide() {
      this.cancelTooltipHide();
      this.tooltipHideTimer = global.setTimeout(() => this.hideTooltip(), 160);
    }

    cancelTooltipHide() {
      if (!this.tooltipHideTimer) return;

      global.clearTimeout(this.tooltipHideTimer);
      this.tooltipHideTimer = null;
    }

    renderTooltip(annotation) {
      const title = annotation.title ? `<div class="dm-tooltip-title">${escapeHtml(annotation.title)}</div>` : "";
      const body = annotation.body ? `<div class="dm-tooltip-body">${this.renderRichText(annotation.body)}</div>` : "";
      const fields = annotation.fields?.length
        ? `
          <dl class="dm-tooltip-fields">
            ${annotation.fields.map((field) => `
              <div class="dm-tooltip-field">
                <dt>${escapeHtml(field.label)}</dt>
                <dd>${this.renderRichText(field.value)}</dd>
              </div>
            `).join("")}
          </dl>
        `
        : "";
      const links = annotation.links?.length
        ? `
          <div class="dm-tooltip-links">
            ${annotation.links.map((link, index) => `
              <a href="${escapeHtml(link.href)}" data-dm-tooltip-link="${index}">${escapeHtml(link.label || link.href)}</a>
            `).join("")}
          </div>
        `
        : "";
      return `${title}${body}${fields}${links}`;
    }

    renderRichText(value) {
      const escaped = escapeHtml(value || "");
      return escaped
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\n/g, "<br>");
    }

    bindTooltipLinks(annotation) {
      if (!this.tooltipEl || !annotation.links?.length) return;

      this.tooltipEl.querySelectorAll("[data-dm-tooltip-link]").forEach((anchor) => {
        const index = Number(anchor.dataset.dmTooltipLink);
        const link = annotation.links[index];
        if (!link?.href) return;

        if (link.href.startsWith(EXT_PREFIX)) {
          anchor.setAttribute("href", "#");
          anchor.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.hideTooltip();
            await this.open(resolveFlowbridgeUrl(link.href.slice(EXT_PREFIX.length).trim(), this.current.src, this.options.baseUrl), {
              pushHistory: true,
            });
          });
          return;
        }

        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noopener noreferrer");
      });
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
      this.hideTooltip();
      this.resetModalZoom();
      this.expandBtn?.focus();
    }
  }


  global.Flowbridge = {
    Viewer: DistributedMermaidViewer,
    loadDiagram,
  };

  global.DistributedMermaid = global.Flowbridge;
})(window);
