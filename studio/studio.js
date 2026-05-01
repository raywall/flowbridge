(function () {
  const STORAGE_KEYS = {
    source: "flowbridge-studio:source",
    width: "flowbridge-studio:sidebar-width",
    collapsed: "flowbridge-studio:sidebar-collapsed",
  };

  const DEFAULT_SOURCE = `%% title: Flowbridge Studio
flowchart LR
  start([Inicio]):::start
  receive[Receber pedido]:::lambda
  stock[Consultar estoque]:::external
  payment[Autorizar pagamento]
  finish([Fim]):::success

  start --> receive --> stock --> payment --> finish

  click stock "ext:https://raw.githubusercontent.com/raywall/flowbridge/main/app/estoque/diagrams/estoque.mmd" "Abrir fluxo de estoque"

  %% @tooltip receive
  %%   title: Receber Pedido
  %%   description: Edite este script para visualizar seu fluxo online.
  %%   owner: flowbridge-studio
  %%   tags: exemplo, editor
  %% @end

  %% @tooltip stock
  %%   title: Consultar Estoque
  %%   description: Exemplo de navegacao para outro arquivo .mmd usando ext:.
  %%   link: Diagrama remoto | ext:https://raw.githubusercontent.com/raywall/flowbridge/main/app/estoque/diagrams/estoque.mmd
  %% @end

  classDef start fill:#dbeafe,stroke:#2563eb,color:#1e40af,font-weight:bold
  classDef success fill:#dcfce7,stroke:#16a34a,color:#166534,font-weight:bold
  classDef external fill:#f5f3ff,stroke:#7c3aed,color:#5b21b6,stroke-dasharray:6 3,stroke-width:2px
  classDef lambda fill:#ED7100,stroke:#BD5A00,color:#fff,font-weight:bold

  %% flowbridge:classIcon lambda aws:lambda
`;

  const els = {};
  let viewer = null;
  let currentObjectUrl = "";
  let renderTimer = 0;
  let lintTimer = 0;
  let lintVersion = 0;
  let lintErrorLine = 0;
  let renderVersion = 0;
  let isDraggingSidebar = false;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindElements();
    restoreLayout();
    bindEvents();
    setEditorValue(localStorage.getItem(STORAGE_KEYS.source) || DEFAULT_SOURCE);
    updateStats();
    updateTitle();
    updateLineNumbers();
    updateSyntaxHighlight();

    try {
      await loadRuntime();
      els.loadingOverlay.hidden = true;
      runMermaidLint();
      renderNow();
    } catch (error) {
      els.loadingOverlay.innerHTML = `<span>${escapeHtml(error.message || "Falha ao carregar Flowbridge.")}</span>`;
      setLintStatus("error", error.message || "Falha ao carregar Mermaid.");
    }
  }

  function bindElements() {
    els.sidebar = document.getElementById("studioSidebar");
    els.resizer = document.getElementById("sidebarResizer");
    els.collapseSidebar = document.getElementById("collapseSidebar");
    els.editor = document.getElementById("diagramSource");
    els.highlight = document.getElementById("editorHighlight");
    els.lineNumbers = document.getElementById("editorLineNumbers");
    els.lint = document.getElementById("editorLint");
    els.editorStats = document.getElementById("editorStats");
    els.restoreExample = document.getElementById("formatExample");
    els.viewer = document.getElementById("viewer");
    els.title = document.getElementById("diagramTitle");
    els.resetView = document.getElementById("resetView");
    els.exportSvg = document.getElementById("exportSvg");
    els.exportPng = document.getElementById("exportPng");
    els.loadingOverlay = document.getElementById("loadingOverlay");
  }

  function restoreLayout() {
    const savedWidth = parseFloat(localStorage.getItem(STORAGE_KEYS.width));
    if (Number.isFinite(savedWidth)) {
      setSidebarWidth(savedWidth);
    }

    if (localStorage.getItem(STORAGE_KEYS.collapsed) === "true") {
      document.body.classList.add("sidebar-collapsed");
    }

    syncSidebarToggle();
  }

  function bindEvents() {
    els.editor.addEventListener("input", () => {
      localStorage.setItem(STORAGE_KEYS.source, els.editor.value);
      updateStats();
      updateTitle();
      updateLineNumbers();
      updateSyntaxHighlight();
      scheduleMermaidLint();
      scheduleRender();
    });

    els.editor.addEventListener("scroll", syncEditorScroll);

    els.editor.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      event.preventDefault();

      const start = els.editor.selectionStart;
      const end = els.editor.selectionEnd;
      els.editor.value = `${els.editor.value.slice(0, start)}  ${els.editor.value.slice(end)}`;
      els.editor.selectionStart = els.editor.selectionEnd = start + 2;
      els.editor.dispatchEvent(new Event("input"));
    });

    els.restoreExample.addEventListener("click", () => {
      setEditorValue(DEFAULT_SOURCE);
      localStorage.setItem(STORAGE_KEYS.source, DEFAULT_SOURCE);
      updateStats();
      updateTitle();
      updateLineNumbers();
      updateSyntaxHighlight();
      scheduleMermaidLint(0);
      renderNow();
    });

    els.collapseSidebar.addEventListener("click", () => setSidebarCollapsed(!isSidebarCollapsed()));
    els.resetView.addEventListener("click", () => viewer?.resetView?.());
    els.exportSvg.addEventListener("click", () => exportSvg());
    els.exportPng.addEventListener("click", () => exportPng());

    els.resizer.addEventListener("pointerdown", (event) => {
      if (isSidebarCollapsed()) return;
      isDraggingSidebar = true;
      document.body.classList.add("is-resizing");
      els.resizer.setPointerCapture(event.pointerId);
    });

    window.addEventListener("pointermove", (event) => {
      if (!isDraggingSidebar) return;
      setSidebarWidth(event.clientX);
    });

    window.addEventListener("pointerup", () => {
      if (!isDraggingSidebar) return;
      isDraggingSidebar = false;
      document.body.classList.remove("is-resizing");
      localStorage.setItem(STORAGE_KEYS.width, String(getSidebarWidth()));
    });

    window.addEventListener("resize", () => {
      setSidebarWidth(getSidebarWidth());
      scheduleRender(100);
    });
  }

  async function loadRuntime() {
    await waitForMermaid();

    if (window.Flowbridge && window.FlowbridgeAwsIcons) return;

    const assetBase = await getFlowbridgeAssetBase();
    await loadStylesheet(`${assetBase}/flowbridge.css`);
    await loadScript(`${assetBase}/aws-icons.js`);
    await loadScript(`${assetBase}/flowbridge.js`);
  }

  async function getFlowbridgeAssetBase() {
    const params = new URLSearchParams(window.location.search);
    const explicitBase = params.get("flowbridgeBase");
    const requestedRef = params.get("flowbridgeRef");
    const repo = params.get("flowbridgeRepo") || "raywall/flowbridge";

    if (explicitBase) {
      return explicitBase.replace(/\/+$/, "");
    }

    if (requestedRef) {
      return `https://cdn.jsdelivr.net/gh/${repo}@${requestedRef}/app/shared`;
    }

    const localBase = await getLocalFlowbridgeAssetBase();
    if (localBase) return localBase;

    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json" },
      });

      if (!response.ok) {
        throw new Error(`GitHub API ${response.status}`);
      }

      const release = await response.json();
      if (release?.tag_name) {
        return `https://cdn.jsdelivr.net/gh/${repo}@${release.tag_name}/app/shared`;
      }
    } catch (error) {
      console.warn("Nao foi possivel descobrir a ultima release do Flowbridge.", error);
    }

    return `https://cdn.jsdelivr.net/gh/${repo}@latest/app/shared`;
  }

  async function getLocalFlowbridgeAssetBase() {
    const isLocalhost = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
    if (!isLocalhost) return "";

    const localBase = "http://127.0.0.1:4200";
    try {
      await fetch(`${localBase}/flowbridge.js`, { method: "HEAD", cache: "no-store" });
      return localBase;
    } catch (error) {
      console.warn("Flowbridge shared local nao esta disponivel em http://127.0.0.1:4200.", error);
      return "";
    }
  }

  function waitForMermaid() {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = window.setInterval(() => {
        if (window.mermaid) {
          window.clearInterval(timer);
          resolve();
          return;
        }

        if (Date.now() - startedAt > 10000) {
          window.clearInterval(timer);
          reject(new Error("Mermaid nao carregou a tempo."));
        }
      }, 40);
    });
  }

  function loadStylesheet(href) {
    return new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.onload = resolve;
      link.onerror = () => reject(new Error(`Falha ao carregar ${href}`));
      document.head.appendChild(link);
    });
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Falha ao carregar ${src}`));
      document.head.appendChild(script);
    });
  }

  function scheduleRender(delay = 320) {
    window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(renderNow, delay);
  }

  function scheduleMermaidLint(delay = 260) {
    window.clearTimeout(lintTimer);
    lintTimer = window.setTimeout(runMermaidLint, delay);
  }

  async function runMermaidLint() {
    if (!window.mermaid?.parse || !els.editor) return;

    const source = els.editor.value.trim();
    const version = ++lintVersion;
    lintErrorLine = 0;
    updateLineNumbers();

    if (!source) {
      setLintStatus("idle", "Digite um script Mermaid para validar.");
      return;
    }

    setLintStatus("idle", "Validando Mermaid...");

    try {
      await window.mermaid.parse(source);
      if (version !== lintVersion) return;
      setLintStatus("valid", "Mermaid valido.");
    } catch (error) {
      if (version !== lintVersion) return;
      lintErrorLine = getMermaidErrorLine(error);
      updateLineNumbers();
      setLintStatus("error", formatMermaidError(error, lintErrorLine));
    }
  }

  async function renderNow() {
    if (!window.Flowbridge || !els.viewer) return;

    const source = els.editor.value.trim();
    const version = ++renderVersion;
    const objectUrl = URL.createObjectURL(new Blob([source || "\n"], { type: "text/plain" }));
    const oldObjectUrl = currentObjectUrl;
    currentObjectUrl = objectUrl;
    els.viewer.innerHTML = "";

    try {
      viewer = new window.Flowbridge.Viewer({
        element: els.viewer,
        initialSrc: objectUrl,
        baseUrl: getStudioBaseUrl(),
        height: getViewerHeight(),
        showToolbar: false,
        showDownloadButton: false,
        enableZoom: true,
        showViewControls: false,
      });

      await viewer.start();
      if (version === renderVersion) {
        applyStudioIconColors(source);
        window.setTimeout(() => {
          applyStudioIconColors(source);
          updateExportAvailability();
        }, 80);
        window.setTimeout(() => applyStudioIconColors(source), 250);
      }
    } finally {
      if (oldObjectUrl) {
        window.setTimeout(() => URL.revokeObjectURL(oldObjectUrl), 1000);
      }
    }
  }

  function getStudioBaseUrl() {
    const pathname = window.location.pathname;
    const studioIndex = pathname.indexOf("/studio/");
    if (studioIndex === -1) return "/";
    return `${pathname.slice(0, studioIndex)}/`;
  }

  function getViewerHeight() {
    return Math.max(420, window.innerHeight - 112);
  }

  function updateStats() {
    const lines = els.editor.value.split(/\r?\n/).length;
    const chars = els.editor.value.length;
    els.editorStats.textContent = `${lines} linhas · ${chars} caracteres`;
  }

  function updateLineNumbers() {
    if (!els.lineNumbers || !els.editor) return;

    const lineCount = Math.max(1, els.editor.value.split(/\r?\n/).length);
    const lines = [];
    for (let index = 1; index <= lineCount; index += 1) {
      const className = index === lintErrorLine ? " class=\"is-error\"" : "";
      lines.push(`<span${className}>${index}</span>`);
    }

    els.lineNumbers.innerHTML = lines.join("");
    syncEditorScroll();
  }

  function syncEditorScroll() {
    if (!els.lineNumbers || !els.editor) return;
    els.lineNumbers.scrollTop = els.editor.scrollTop;
    if (els.highlight) {
      els.highlight.scrollTop = els.editor.scrollTop;
      els.highlight.scrollLeft = els.editor.scrollLeft;
    }
  }

  function updateSyntaxHighlight() {
    if (!els.highlight || !els.editor) return;
    els.highlight.innerHTML = highlightMermaidSource(els.editor.value);
    syncEditorScroll();
  }

  function updateTitle() {
    const title = els.editor.value.match(/%%\s*title:\s*(.+)/i)?.[1]?.trim() || "Diagrama";
    els.title.textContent = title;
  }

  function updateExportAvailability() {
    const hasSvg = Boolean(getRenderedSvg());
    els.exportSvg.disabled = !hasSvg;
    els.exportPng.disabled = !hasSvg;
  }

  function getRenderedSvg() {
    return els.viewer.querySelector(".dm-stage svg") || els.viewer.querySelector("svg");
  }

  function exportSvg() {
    const svg = getRenderedSvg();
    if (!svg) return;

    const content = serializeSvg(svg);
    downloadBlob(content, `${getExportName()}.svg`, "image/svg+xml;charset=utf-8");
  }

  function exportPng() {
    const svg = getRenderedSvg();
    if (!svg) return;

    const content = serializeSvg(svg);
    const blob = new Blob([content], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.decoding = "async";

    image.onload = () => {
      const size = getSvgSize(svg);
      const canvas = document.createElement("canvas");
      const scale = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      canvas.width = Math.ceil(size.width * scale);
      canvas.height = Math.ceil(size.height * scale);

      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      canvas.toBlob((pngBlob) => {
        URL.revokeObjectURL(url);
        if (!pngBlob) return;
        downloadBlob(pngBlob, `${getExportName()}.png`, "image/png");
      }, "image/png");
    };

    image.onerror = () => URL.revokeObjectURL(url);
    image.src = url;
  }

  function serializeSvg(svg) {
    const clone = svg.cloneNode(true);
    const size = getSvgSize(svg);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(Math.ceil(size.width)));
    clone.setAttribute("height", String(Math.ceil(size.height)));

    if (!clone.getAttribute("viewBox")) {
      clone.setAttribute("viewBox", `0 0 ${Math.ceil(size.width)} ${Math.ceil(size.height)}`);
    }

    return new XMLSerializer().serializeToString(clone);
  }

  function getSvgSize(svg) {
    const box = svg.getBBox?.();
    const rect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox?.baseVal;

    return {
      width: Math.max(1, rect.width || viewBox?.width || box?.width || 1200),
      height: Math.max(1, rect.height || viewBox?.height || box?.height || 800),
    };
  }

  function downloadBlob(content, filename, type) {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function getExportName() {
    return (els.title.textContent || "flowbridge-diagram")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "flowbridge-diagram";
  }

  function setEditorValue(value) {
    els.editor.value = value;
  }

  function highlightMermaidSource(source) {
    const lines = source.split(/\r?\n/);
    const highlighted = lines.map(highlightMermaidLine).join("\n");
    return highlighted || " ";
  }

  function highlightMermaidLine(line) {
    if (/^\s*%%/.test(line)) {
      return `<span class="editor-token--comment">${escapeHtml(line)}</span>`;
    }

    const parts = [];
    let index = 0;

    while (index < line.length) {
      const char = line[index];
      if (char !== '"' && char !== "'") {
        const nextQuote = findNextQuote(line, index);
        const end = nextQuote === -1 ? line.length : nextQuote;
        parts.push(highlightMermaidPlainText(line.slice(index, end)));
        index = end;
        continue;
      }

      const end = findStringEnd(line, index, char);
      parts.push(`<span class="editor-token--string">${escapeHtml(line.slice(index, end))}</span>`);
      index = end;
    }

    return parts.join("");
  }

  function highlightMermaidPlainText(text) {
    const tokenPattern = /\b(sequenceDiagram|flowchart|graph|participant|actor|rect|end|classDef|class|click|linkStyle|style|subgraph|direction|autonumber|loop|alt|else|opt|par|and|critical|break|Note|over)\b|(-{1,2}>>|-->|--x|-\.?->|---|--|==>|=>|->)|\b(fill|stroke|color|font-weight|stroke-dasharray|stroke-width|link|title|description|owner|tags)\b(?=:)|(#[0-9a-fA-F]{3,8}|\b\d+(?:\.\d+)?\b)/g;
    const parts = [];
    let index = 0;

    for (const match of text.matchAll(tokenPattern)) {
      const matchIndex = match.index || 0;
      if (matchIndex > index) {
        parts.push(escapeHtml(text.slice(index, matchIndex)));
      }

      const className = match[1]
        ? "editor-token--keyword"
        : match[2]
          ? "editor-token--arrow"
          : match[3]
            ? "editor-token--property"
            : "editor-token--number";

      parts.push(`<span class="${className}">${escapeHtml(match[0])}</span>`);
      index = matchIndex + match[0].length;
    }

    if (index < text.length) {
      parts.push(escapeHtml(text.slice(index)));
    }

    return parts.join("");
  }

  function findNextQuote(value, start) {
    const doubleQuote = value.indexOf('"', start);
    const singleQuote = value.indexOf("'", start);
    if (doubleQuote === -1) return singleQuote;
    if (singleQuote === -1) return doubleQuote;
    return Math.min(doubleQuote, singleQuote);
  }

  function findStringEnd(value, start, quote) {
    let index = start + 1;
    while (index < value.length) {
      if (value[index] === "\\" && index + 1 < value.length) {
        index += 2;
        continue;
      }

      if (value[index] === quote) {
        return index + 1;
      }

      index += 1;
    }

    return value.length;
  }

  function setLintStatus(state, message) {
    if (!els.lint) return;
    els.lint.classList.toggle("is-valid", state === "valid");
    els.lint.classList.toggle("is-error", state === "error");
    els.lint.textContent = message;
  }

  function applyStudioIconColors(source) {
    const iconColors = getClassIconColors(source);
    if (!iconColors.size) return;

    const renderedIcons = findRenderedIconElements();
    const uniqueColors = [...new Set(iconColors.values())];

    if (uniqueColors.length === 1) {
      renderedIcons.forEach((iconEl) => forceInlineIconColor(iconEl, uniqueColors[0]));
      return;
    }

    const nodeClasses = parseNodeClasses(source);
    for (const [nodeId, classes] of nodeClasses.entries()) {
      const color = findIconColorForClasses(classes, iconColors);
      if (!color) continue;

      const node = findRenderedNode(nodeId);
      const iconEl = node ? findRenderedIconElements(node)[0] : null;
      if (iconEl) {
        forceInlineIconColor(iconEl, color);
      }
    }
  }

  function findRenderedIconElements(root = els.viewer) {
    const icons = new Set();
    const selectors = [
      ".dm-node-icon-svg",
      ".fb-node-icon-svg",
      "svg[viewBox='0 0 80 80']",
      "svg[viewBox='0 0 80 80'] *[id*='aws-']",
      "*[id*='aws-']",
      "foreignObject svg[viewBox='0 0 80 80']",
      "foreignObject svg[viewBox='0 0 80 80'] *[id*='aws-']",
      "foreignObject *[id*='aws-']",
    ];

    root.querySelectorAll(selectors.join(",")).forEach((element) => {
      const iconRoot = element.closest?.(".dm-node-icon-svg, .fb-node-icon-svg, svg") || element;
      if (iconRoot instanceof Element) {
        icons.add(iconRoot);
      }
    });

    return [...icons];
  }

  function getClassIconColors(source) {
    const classIcons = parseClassIconDirectives(source);
    const classStyles = parseClassStyles(source);
    const iconColors = new Map();

    for (const className of classIcons.keys()) {
      const color = classStyles.get(className) || findColorForClasses([className], classStyles);
      if (color) {
        iconColors.set(className, color);
      }
    }

    return iconColors;
  }

  function parseClassIconDirectives(source) {
    const icons = new Map();
    const pattern = /^\s*%%\s*(?:(?:flowbridge)\s*:?\s*)?(?:classIcon|class-icon)\s+([A-Za-z][\w-]*)\s+(\S+)\s*$/i;

    String(source || "").split(/\r?\n/).forEach((line) => {
      const match = line.match(pattern);
      if (match) {
        icons.set(match[1], match[2]);
      }
    });

    return icons;
  }

  function parseClassStyles(source) {
    const styles = new Map();
    const pattern = /^\s*classDef\s+(.+?)\s+(.+?)\s*;?\s*$/i;

    String(source || "").split(/\r?\n/).forEach((line) => {
      const match = line.match(pattern);
      if (!match) return;

      const color = match[2].match(/(?:^|[,;])\s*color\s*:\s*([^,;]+)/i)?.[1]?.trim();
      if (!color) return;

      match[1]
        .split(",")
        .map((className) => className.trim())
        .filter(Boolean)
        .forEach((className) => styles.set(className, color));
    });

    return styles;
  }

  function parseNodeClasses(source) {
    const nodeClasses = new Map();
    const inlineClassPattern = /^\s*([A-Za-z][\w-]*)\s*(?:\(\[|\[\(|\[\[|\(\(|\[|\(|\{).+?(?:\]\)|\]\]|\)\]|\)\)|\]|\)|\})\s*:::\s*([A-Za-z][\w-]*(?:[,\s]+[A-Za-z][\w-]*)*)/;
    const classStatementPattern = /^\s*class\s+(.+?)\s+(.+?)\s*;?\s*$/i;

    String(source || "").split(/\r?\n/).forEach((line) => {
      if (/^\s*%%/.test(line)) return;

      const inline = line.match(inlineClassPattern);
      if (inline) {
        inline[2].split(/[,\s]+/).filter(Boolean).forEach((className) => {
          addNodeClass(nodeClasses, inline[1], className);
        });
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

  function addNodeClass(nodeClasses, nodeId, className) {
    if (!nodeClasses.has(nodeId)) {
      nodeClasses.set(nodeId, new Set());
    }

    nodeClasses.get(nodeId).add(className);
  }

  function findIconColorForClasses(classes, iconColors) {
    for (const className of classes || []) {
      const color = iconColors.get(className);
      if (color) return color;
    }

    return "";
  }

  function findColorForClasses(classes, classStyles) {
    for (const className of classes || []) {
      const color = classStyles.get(className);
      if (color) return color;
    }

    return "";
  }

  function findRenderedNode(nodeId) {
    const safeId = escapeCss(nodeId);
    const selectors = [
      `#${safeId}`,
      `#flowchart-${safeId}-0`,
      `[id^="flowchart-${nodeId}-"]`,
      `[data-id="${nodeId}"]`,
      `[data-node-id="${nodeId}"]`,
    ];

    for (const selector of selectors) {
      const node = els.viewer.querySelector(selector);
      if (node) return node;
    }

    return null;
  }

  function forceInlineIconColor(iconEl, color) {
    iconEl.style.setProperty("color", color, "important");
    [iconEl, ...iconEl.querySelectorAll("svg, svg *")].forEach((element) => {
      if (!(element instanceof SVGElement)) return;

      element.style.setProperty("color", color, "important");

      const fill = element.getAttribute("fill");
      if (!fill || !/^(none|transparent)$/i.test(fill)) {
        element.setAttribute("fill", color);
        element.style.setProperty("fill", color, "important");
      }

      const stroke = element.getAttribute("stroke");
      if (!stroke || !/^(none|transparent)$/i.test(stroke)) {
        element.setAttribute("stroke", color);
        element.style.setProperty("stroke", color, "important");
      }
    });
  }

  function escapeCss(value) {
    if (window.CSS?.escape) return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9\-_]/g, "\\$&");
  }

  function getMermaidErrorLine(error) {
    const hashLine = Number(error?.hash?.loc?.first_line || error?.hash?.line);
    if (Number.isFinite(hashLine) && hashLine > 0) return hashLine;

    const message = String(error?.str || error?.message || "");
    const lineMatch = message.match(/\bline\s+(\d+)\b/i);
    if (lineMatch) return Number(lineMatch[1]);

    const locationMatch = message.match(/\((\d+):\d+\)/);
    if (locationMatch) return Number(locationMatch[1]);

    return 0;
  }

  function formatMermaidError(error, line) {
    const message = String(error?.str || error?.message || "Erro de sintaxe Mermaid.")
      .replace(/\s+/g, " ")
      .trim();
    const prefix = line ? `Linha ${line}: ` : "";
    return `${prefix}${message}`;
  }

  function setSidebarCollapsed(collapsed) {
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    localStorage.setItem(STORAGE_KEYS.collapsed, String(collapsed));
    syncSidebarToggle();
    scheduleRender(120);
  }

  function setSidebarWidth(width) {
    const min = 300;
    const max = Math.min(760, Math.floor(window.innerWidth * 0.82));
    const next = Math.min(max, Math.max(min, Math.floor(width)));
    document.documentElement.style.setProperty("--sidebar-width", `${next}px`);
  }

  function getSidebarWidth() {
    return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width"));
  }

  function isSidebarCollapsed() {
    return document.body.classList.contains("sidebar-collapsed");
  }

  function syncSidebarToggle() {
    const collapsed = isSidebarCollapsed();
    const label = collapsed ? "Abrir editor" : "Fechar editor";
    els.collapseSidebar.title = label;
    els.collapseSidebar.setAttribute("aria-label", label);
    els.collapseSidebar.setAttribute("aria-expanded", String(!collapsed));
    els.collapseSidebar.querySelector("i")?.classList.toggle("fa-chevron-left", !collapsed);
    els.collapseSidebar.querySelector("i")?.classList.toggle("fa-chevron-right", collapsed);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
})();
