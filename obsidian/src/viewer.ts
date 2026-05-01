import { App, TFile, normalizePath, setIcon } from 'obsidian';
import { FlowbridgeOptions, DiagramData } from './types';
import {
  fas,
  IconDefinition,
} from '@fortawesome/free-solid-svg-icons';
import { far } from '@fortawesome/free-regular-svg-icons';
import { fab } from '@fortawesome/free-brands-svg-icons';
import { AWS_ICONS } from './aws-icons.generated';
import {
  buildTooltipEl,
  loadExternalAnnotations,
  mergeAnnotations,
  parseInlineAnnotations,
} from './annotations';

type MermaidApi = {
  render: (id: string, definition: string) => Promise<{ svg: string; bindFunctions?: (el: Element) => void }> | { svg: string; bindFunctions?: (el: Element) => void } | string;
  initialize?: (options: Record<string, unknown>) => void;
  registerIconPacks?: (iconLoaders: Array<Record<string, unknown>>) => void;
};

const BUILTIN_FA_ICON_PACK = {
  prefix: 'fa',
  icons: {
    terminal: {
      width: 640,
      height: 512,
      body: '<path fill="currentColor" d="M64 96C46.3 96 32 110.3 32 128v256c0 17.7 14.3 32 32 32h512c17.7 0 32-14.3 32-32V128c0-17.7-14.3-32-32-32H64zm64 72c9.4-9.4 24.6-9.4 33.9 0l80 80c9.4 9.4 9.4 24.6 0 33.9l-80 80c-9.4 9.4-24.6 9.4-33.9 0s-9.4-24.6 0-33.9l63-63-63-63c-9.4-9.4-9.4-24.6 0-33.9zM288 336h160c13.3 0 24 10.7 24 24s-10.7 24-24 24H288c-13.3 0-24-10.7-24-24s10.7-24 24-24z"/>',
    },
    'fa-terminal': {
      parent: 'terminal',
    },
  },
};

const FONT_AWESOME_PACKS: Record<string, Record<string, IconDefinition>> = {
  fa: fas as Record<string, IconDefinition>,
  fas: fas as Record<string, IconDefinition>,
  far: far as Record<string, IconDefinition>,
  fab: fab as Record<string, IconDefinition>,
};

const AWS_ICON_PACK = AWS_ICONS as {
  icons: Record<string, string>;
  aliases: Record<string, string>;
};

export class FlowbridgeViewer {
  private app: App;
  private container: HTMLElement;
  private options: FlowbridgeOptions;
  private currentPath: string;
  private initialPath: string;
  private initialContent?: string;
  private titleEl!: HTMLElement;
  private svgWrap!: HTMLElement;
  private stageEl!: HTMLElement;
  private modalEl!: HTMLElement;
  private modalDialogEl!: HTMLElement;
  private modalStageEl!: HTMLElement;
  private tooltipEl: HTMLElement | null = null;
  private tooltipNodeId: string | null = null;
  private current: DiagramData | null = null;
  private history: string[] = [];
  private zoom = { scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };
  private modalZoom = { scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };

  constructor(app: App, container: HTMLElement, options: FlowbridgeOptions) {
    this.app = app;
    this.container = container;
    this.options = options;
    this.initialContent = options.content;
    this.currentPath = normalizePath(options.src || options.sourcePath || 'flowbridge-inline.mmd');
    this.initialPath = this.currentPath;
  }

  async start() {
    this.container.empty();
    this.container.addClass('fb-viewer');
    this.buildHeader();
    this.svgWrap = this.container.createDiv({ cls: 'fb-svg-wrap' });
    this.svgWrap.style.height = `${this.options.height ?? 480}px`;
    this.stageEl = this.svgWrap.createDiv({ cls: 'fb-stage' });
    this.buildToolbar();
    this.buildModal();
    this.attachPanZoomHandlers();
    this.attachModalPanZoomHandlers();
    if (this.initialContent) {
      await this.renderInlineDiagram(this.initialContent, this.initialPath, false);
      return;
    }

    await this.renderDiagram(this.currentPath, false);
  }

  private buildHeader() {
    const header = this.container.createDiv({ cls: 'fb-header' });
    this.titleEl = header.createEl('span', { cls: 'fb-toolbar-title', text: '' });
  }

  private buildToolbar() {
    const bar = this.container.createDiv({ cls: 'fb-toolbar' });
    this.createToolbarButton(bar, 'rotate-ccw', 'Resetar diagrama', () => {
      this.history = [];
      if (this.initialContent) {
        this.renderInlineDiagram(this.initialContent, this.initialPath, false);
        return;
      }
      this.renderDiagram(this.initialPath, false);
    });

    this.createToolbarButton(bar, 'maximize-2', 'Expandir diagrama', () => this.openModal());

    this.createToolbarButton(bar, 'arrow-left', 'Voltar', () => {
      const previous = this.history.pop();
      if (!previous) return;
      if (this.initialContent && previous === this.initialPath) {
        this.renderInlineDiagram(this.initialContent, this.initialPath, false);
        return;
      }
      this.renderDiagram(previous, false);
    });

    this.createToolbarButton(bar, 'download', 'Download .mmd', () => this.download());
  }

  private createToolbarButton(parent: HTMLElement, icon: string, title: string, onClick: () => void) {
    const button = parent.createEl('button', {
      cls: 'fb-btn',
      attr: { title, 'aria-label': title },
    });
    setIcon(button, icon);
    button.addEventListener('click', onClick);
    return button;
  }

  private buildModal() {
    this.modalEl = document.createElement('div');
    this.modalEl.addClass('fb-modal');
    this.modalEl.setAttr('aria-hidden', 'true');
    document.body.appendChild(this.modalEl);

    this.modalDialogEl = this.modalEl.createDiv({
      cls: 'fb-modal-dialog',
      attr: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'Visualizacao ampliada do diagrama',
      },
    });
    const closeBtn = this.modalDialogEl.createEl('button', {
      cls: 'fb-modal-close',
      attr: { title: 'Fechar', 'aria-label': 'Fechar' },
    });
    setIcon(closeBtn, 'x');
    closeBtn.addEventListener('click', () => this.closeModal());
    this.modalStageEl = this.modalDialogEl.createDiv({ cls: 'fb-modal-stage' });

    this.modalEl.addEventListener('click', (event) => {
      if (event.target === this.modalEl) this.closeModal();
    });

    this.modalStageEl.addEventListener('mousemove', (event) => this.handleAnnotationHover(event));
    this.modalStageEl.addEventListener('mouseleave', () => this.hideTooltip());
    this.modalStageEl.addEventListener('focusin', (event) => this.handleAnnotationHover(event as FocusEvent));
    this.modalStageEl.addEventListener('focusout', () => this.hideTooltip());
  }

  private async renderDiagram(vaultPath: string, pushHistory = true) {
    const nextPath = normalizePath(vaultPath);
    if (pushHistory && this.currentPath && this.currentPath !== nextPath) {
      this.history.push(this.currentPath);
    }

    this.currentPath = nextPath;
    this.hideTooltip();
    this.resetZoom();

    const file = this.app.vault.getAbstractFileByPath(nextPath);
    if (!(file instanceof TFile)) {
      this.stageEl.setText(`Arquivo não encontrado: ${nextPath}`);
      return;
    }

    const raw = await this.app.vault.read(file);
    const externalAnnotations = await loadExternalAnnotations(this.app, nextPath, this.options.annotationsSrc);
    await this.renderContent(raw, nextPath, file.basename, externalAnnotations);
  }

  private async renderInlineDiagram(content: string, basePath: string, pushHistory = true) {
    const nextPath = normalizePath(basePath);
    if (pushHistory && this.currentPath && this.currentPath !== nextPath) {
      this.history.push(this.currentPath);
    }

    this.currentPath = nextPath;
    this.hideTooltip();
    this.resetZoom();
    await this.renderContent(content, nextPath, 'Flowbridge');
  }

  private async renderContent(
    raw: string,
    basePath: string,
    fallbackTitle: string,
    externalAnnotations = {}
  ) {
    const inlineAnnotations = parseInlineAnnotations(raw);
    this.current = {
      path: basePath,
      title: this.extractTitle(raw, fallbackTitle),
      content: raw,
      annotations: mergeAnnotations(inlineAnnotations, externalAnnotations),
      labels: this.parseNodeLabels(raw),
      links: this.parseExternalLinks(raw, basePath),
      classIcons: this.parseClassIconDirectives(raw),
      classStyles: this.parseClassStyles(raw),
      nodeClasses: this.parseNodeClasses(raw),
    };
    this.titleEl.setText(this.current.title);

    const mermaid = this.getMermaid();
    if (!mermaid) {
      this.stageEl.setText('Mermaid não disponível no Obsidian.');
      return;
    }

    try {
      this.registerBuiltinIconPacks(mermaid);
      mermaid.initialize?.({
        startOnLoad: false,
        securityLevel: 'loose',
        theme: this.options.theme || 'default',
        flowchart: { htmlLabels: true, useMaxWidth: true },
      });

      const renderId = `fb-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = await mermaid.render(renderId, raw);
      const svg = typeof result === 'string' ? result : result.svg;
      this.stageEl.empty();
      this.stageEl.innerHTML = svg;
      if (typeof result !== 'string') result.bindFunctions?.(this.stageEl);
      this.decorateSvg(this.stageEl);
    } catch (error) {
      this.stageEl.setText('Erro ao renderizar: ' + String(error));
    }
  }

  private getMermaid(): MermaidApi | null {
    return (window as unknown as { mermaid?: MermaidApi }).mermaid ?? null;
  }

  private registerBuiltinIconPacks(mermaid: MermaidApi) {
    const win = window as Window & { __flowbridgeMermaidIconsRegistered?: boolean };
    if (win.__flowbridgeMermaidIconsRegistered || typeof mermaid.registerIconPacks !== 'function') return;

    mermaid.registerIconPacks([
      { name: 'fa', icons: BUILTIN_FA_ICON_PACK },
      { name: 'fas', icons: BUILTIN_FA_ICON_PACK },
    ]);
    win.__flowbridgeMermaidIconsRegistered = true;
  }

  private decorateSvg(root: HTMLElement = this.stageEl) {
    if (!this.current) return;
    const svgEl = root.querySelector('svg');
    if (!svgEl) return;

    svgEl.querySelectorAll('title').forEach((title) => title.remove());
    svgEl.querySelectorAll('[title]').forEach((el) => el.removeAttribute('title'));

    this.decorateClassIcons(root);

    for (const [nodeId, targetPath] of this.current.links.entries()) {
      const node = this.findRenderedNode(nodeId, root);
      if (!node) continue;
      node.addClass('fb-clickable-node');
      node.setAttr('tabindex', '0');
      node.setAttr('role', 'button');
      node.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openExternalPath(targetPath);
      });
      node.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.openExternalPath(targetPath);
        }
      });
    }

    for (const nodeId of Object.keys(this.current.annotations)) {
      const node = this.findRenderedNode(nodeId, root);
      if (!node) continue;
      node.addClass('fb-annotated-node');
      node.setAttr('tabindex', node.getAttr('tabindex') || '0');
    }

    if (root === this.stageEl) {
      this.stageEl.addEventListener('mousemove', (event) => this.handleAnnotationHover(event));
      this.stageEl.addEventListener('mouseleave', () => this.hideTooltip());
      this.stageEl.addEventListener('focusin', (event) => this.handleAnnotationHover(event as FocusEvent));
      this.stageEl.addEventListener('focusout', () => this.hideTooltip());
    }
  }

  private openExternalPath(path: string) {
    const resolved = this.resolvePath(path);
    if (/^https?:\/\//i.test(resolved)) {
      window.open(resolved, '_blank', 'noopener');
      return;
    }

    this.closeModal();
    this.renderDiagram(resolved, true);
  }

  private handleAnnotationHover(event: MouseEvent | FocusEvent) {
    const match = this.findAnnotationFromEvent(event);
    if (!match) {
      this.hideTooltip();
      return;
    }

    this.showTooltip(match.nodeId, event, match.element);
  }

  private findAnnotationFromEvent(event: Event): { nodeId: string; element: Element } | null {
    if (!this.current) return null;

    const path = typeof event.composedPath === 'function'
      ? event.composedPath()
      : this.buildEventPath(event.target as Node | null);

    for (const item of path) {
      if (!(item instanceof Element)) continue;
      const nodeId = this.resolveNodeIdFromElement(item);
      if (nodeId && this.current.annotations[nodeId]) {
        return { nodeId, element: item };
      }
    }

    return null;
  }

  private buildEventPath(target: Node | null): EventTarget[] {
    const path: EventTarget[] = [];
    let current: Node | null = target;
    while (current) {
      path.push(current);
      current = current.parentNode;
    }
    return path;
  }

  private resolveNodeIdFromElement(element: Element): string | null {
    if (!this.current) return null;

    const ids = [
      element.getAttribute('data-id'),
      element.getAttribute('data-node-id'),
      element.getAttribute('id'),
    ].filter(Boolean) as string[];

    for (const id of ids) {
      if (this.current.annotations[id]) return id;
      const match = id.match(/^flowchart-(.+)-\d+$/);
      if (match && this.current.annotations[match[1]]) return match[1];
      for (const nodeId of Object.keys(this.current.annotations)) {
        if (id.startsWith(`flowchart-${nodeId}-`)) return nodeId;
      }
    }

    const text = this.normalizeText(element.textContent || '');
    if (text) {
      for (const [nodeId, label] of this.current.labels.entries()) {
        if (this.normalizeText(label) === text && this.current.annotations[nodeId]) return nodeId;
      }
    }

    return null;
  }

  private findRenderedNode(nodeId: string, root: HTMLElement = this.stageEl): Element | null {
    const escapedNodeId = this.escapeCss(nodeId);
    const selectors = [
      `#${escapedNodeId}`,
      `#flowchart-${escapedNodeId}-0`,
      `[id^="flowchart-${nodeId}-"]`,
      `[data-id="${nodeId}"]`,
      `[data-node-id="${nodeId}"]`,
    ];

    for (const selector of selectors) {
      const node = root.querySelector(selector);
      if (node) return node;
    }

    const label = this.current?.labels.get(nodeId);
    if (label) {
      return this.findRenderedNodeByLabel(label, root);
    }

    return null;
  }

  private findRenderedNodeByLabel(label: string, root: HTMLElement = this.stageEl): Element | null {
    const expected = this.normalizeText(label);
    const candidates = root.querySelectorAll('g, text, tspan, span, div');
    for (const candidate of Array.from(candidates)) {
      if (this.normalizeText(candidate.textContent || '') !== expected) continue;
      return candidate.closest('g[id], g.node, g') || candidate;
    }
    return null;
  }

  private showTooltip(nodeId: string, event: MouseEvent | FocusEvent, element: Element) {
    if (!this.current) return;
    const data = this.current.annotations[nodeId];
    if (!data) return;

    if (this.tooltipEl && this.tooltipNodeId === nodeId) {
      this.positionTooltip(event, element);
      return;
    }

    this.hideTooltip();
    this.tooltipNodeId = nodeId;
    this.tooltipEl = buildTooltipEl(data, (path) => {
      this.hideTooltip();
      this.openExternalPath(path);
    });
    document.body.appendChild(this.tooltipEl);
    this.positionTooltip(event, element);

    const onMove = (moveEvent: MouseEvent) => this.positionTooltip(moveEvent, element);
    document.addEventListener('mousemove', onMove);
    (this.tooltipEl as HTMLElement & { _removeMove?: () => void })._removeMove = () =>
      document.removeEventListener('mousemove', onMove);
  }

  private positionTooltip(event: MouseEvent | FocusEvent, element: Element) {
    if (!this.tooltipEl) return;

    const margin = 14;
    const rect = this.tooltipEl.getBoundingClientRect();
    const sourceRect = element.getBoundingClientRect();
    const clientX = 'clientX' in event ? event.clientX : sourceRect.right;
    const clientY = 'clientY' in event ? event.clientY : sourceRect.top;
    let top = clientY + margin;
    let left = clientX + margin;
    if (left + rect.width > window.innerWidth) left = clientX - rect.width - margin;
    if (top + rect.height > window.innerHeight) top = clientY - rect.height - margin;
    this.tooltipEl.style.top = `${Math.max(8, top)}px`;
    this.tooltipEl.style.left = `${Math.max(8, left)}px`;
  }

  private hideTooltip() {
    if (!this.tooltipEl) return;
    (this.tooltipEl as HTMLElement & { _removeMove?: () => void })._removeMove?.();
    this.tooltipEl.remove();
    this.tooltipEl = null;
    this.tooltipNodeId = null;
  }

  private attachPanZoomHandlers() {
    this.svgWrap.addEventListener('wheel', (event) => {
      event.preventDefault();
      const delta = event.deltaY < 0 ? 0.1 : -0.1;
      this.zoom.scale = Math.min(3, Math.max(0.35, this.zoom.scale + delta));
      this.applyZoom();
    }, { passive: false });

    this.svgWrap.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || (event.target as Element).closest('.fb-clickable-node')) return;
      this.zoom.dragging = true;
      this.zoom.lastX = event.clientX;
      this.zoom.lastY = event.clientY;
      this.svgWrap.addClass('fb-svg-wrap--dragging');
    });

    window.addEventListener('mousemove', (event) => {
      if (!this.zoom.dragging) return;
      this.zoom.x += event.clientX - this.zoom.lastX;
      this.zoom.y += event.clientY - this.zoom.lastY;
      this.zoom.lastX = event.clientX;
      this.zoom.lastY = event.clientY;
      this.applyZoom();
    });

    window.addEventListener('mouseup', () => {
      this.zoom.dragging = false;
      this.svgWrap.removeClass('fb-svg-wrap--dragging');
    });
  }

  private attachModalPanZoomHandlers() {
    this.modalDialogEl.addEventListener('wheel', (event) => {
      event.preventDefault();
      const delta = event.deltaY < 0 ? 0.1 : -0.1;
      this.modalZoom.scale = Math.min(4, Math.max(0.35, this.modalZoom.scale + delta));
      this.applyModalZoom();
    }, { passive: false });

    this.modalDialogEl.addEventListener('mousedown', (event) => {
      const target = event.target as Element;
      const isBlocked = target.closest('.fb-clickable-node') || target.closest('.fb-modal-close');
      if (event.button !== 0 || isBlocked) return;
      this.modalZoom.dragging = true;
      this.modalZoom.lastX = event.clientX;
      this.modalZoom.lastY = event.clientY;
      this.modalDialogEl.addClass('fb-modal-dialog--dragging');
    });

    window.addEventListener('mousemove', (event) => {
      if (!this.modalZoom.dragging) return;
      this.modalZoom.x += event.clientX - this.modalZoom.lastX;
      this.modalZoom.y += event.clientY - this.modalZoom.lastY;
      this.modalZoom.lastX = event.clientX;
      this.modalZoom.lastY = event.clientY;
      this.applyModalZoom();
    });

    window.addEventListener('mouseup', () => {
      this.modalZoom.dragging = false;
      this.modalDialogEl.removeClass('fb-modal-dialog--dragging');
    });
  }

  private resetZoom() {
    this.zoom = { scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };
    this.applyZoom();
  }

  private applyZoom() {
    if (!this.stageEl) return;
    this.stageEl.style.transform = `translate(${this.zoom.x}px, ${this.zoom.y}px) scale(${this.zoom.scale})`;
  }

  private resetModalZoom() {
    this.modalZoom = { scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };
    this.applyModalZoom();
  }

  private applyModalZoom() {
    if (!this.modalStageEl) return;
    this.modalStageEl.style.transform = `translate(${this.modalZoom.x}px, ${this.modalZoom.y}px) scale(${this.modalZoom.scale})`;
  }

  private openModal() {
    if (!this.stageEl.innerHTML) return;

    this.modalStageEl.empty();
    this.modalStageEl.innerHTML = this.stageEl.innerHTML;
    this.resetModalZoom();
    this.decorateSvg(this.modalStageEl);
    this.modalEl.addClass('fb-modal--open');
    this.modalEl.setAttr('aria-hidden', 'false');
    document.body.addClass('fb-modal-open');
  }

  private closeModal() {
    if (!this.modalEl || !this.modalEl.hasClass('fb-modal--open')) return;

    this.modalZoom.dragging = false;
    this.modalDialogEl?.removeClass('fb-modal-dialog--dragging');
    this.modalEl.removeClass('fb-modal--open');
    this.modalEl.setAttr('aria-hidden', 'true');
    document.body.removeClass('fb-modal-open');
    this.hideTooltip();
    this.modalStageEl?.empty();
    this.resetModalZoom();
  }

  private async download() {
    const file = this.app.vault.getAbstractFileByPath(this.currentPath);
    const raw = file instanceof TFile ? await this.app.vault.read(file) : this.current?.content;
    if (!raw) return;
    const blob = new Blob([raw], { type: 'text/plain;charset=utf-8' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = file instanceof TFile ? file.name : `${this.current?.title || 'flowbridge'}.mmd`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  private extractTitle(content: string, fallback: string): string {
    return content.match(/^%%\s*title:\s*(.+)$/m)?.[1]?.trim() || fallback;
  }

  private parseExternalLinks(content: string, basePath: string): Map<string, string> {
    const links = new Map<string, string>();
    const pattern = /^\s*click\s+([^\s]+)\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/gim;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null) {
      const raw = match[2] || match[3] || match[4] || '';
      if (!raw.startsWith('ext:')) continue;
      links.set(match[1], this.resolvePath(raw.replace(/^ext:/, '').trim(), basePath));
    }

    return links;
  }

  private parseClassIconDirectives(content: string): Map<string, string> {
    const icons = new Map<string, string>();
    const pattern =
      /^\s*%%\s*(?:(?:flowbridge)\s*:?\s*)?(?:classIcon|class-icon)\s+([A-Za-z][\w-]*)\s+(\S+)\s*$/i;

    String(content || '').split(/\r?\n/).forEach((line) => {
      const match = line.match(pattern);
      if (!match) return;

      icons.set(match[1], match[2]);
    });

    return icons;
  }

  private parseClassStyles(content: string): Map<string, { color?: string }> {
    const styles = new Map<string, { color?: string }>();
    const pattern = /^\s*classDef\s+(.+?)\s+(.+?)\s*;?\s*$/i;

    String(content || '').split(/\r?\n/).forEach((line) => {
      const match = line.match(pattern);
      if (!match) return;

      const color = match[2].match(/(?:^|[,;])\s*color\s*:\s*([^,;]+)/i)?.[1]?.trim();
      if (!color) return;

      match[1]
        .split(',')
        .map((className) => className.trim())
        .filter(Boolean)
        .forEach((className) => styles.set(className, { color }));
    });

    return styles;
  }

  private addNodeClass(nodeClasses: Map<string, Set<string>>, nodeId: string, className: string) {
    if (!nodeClasses.has(nodeId)) {
      nodeClasses.set(nodeId, new Set<string>());
    }

    nodeClasses.get(nodeId)?.add(className);
  }

  private parseNodeClasses(content: string): Map<string, Set<string>> {
    const nodeClasses = new Map<string, Set<string>>();
    const inlineClassPattern =
      /^\s*([A-Za-z][\w-]*)\s*(?:\(\[|\[\(|\[\[|\(\(|\[|\(|\{).+?(?:\]\)|\]\]|\)\]|\)\)|\]|\)|\})\s*:::\s*([A-Za-z][\w-]*(?:[,\s]+[A-Za-z][\w-]*)*)/;
    const classStatementPattern = /^\s*class\s+(.+?)\s+(.+?)\s*;?\s*$/i;

    String(content || '').split(/\r?\n/).forEach((line) => {
      if (/^\s*%%/.test(line)) return;

      const inline = line.match(inlineClassPattern);
      if (inline) {
        inline[2]
          .split(/[,\s]+/)
          .filter(Boolean)
          .forEach((className) => this.addNodeClass(nodeClasses, inline[1], className));
      }

      const statement = line.match(classStatementPattern);
      if (!statement) return;

      const nodeIds = statement[1].split(',').map((nodeId) => nodeId.trim()).filter(Boolean);
      const classNames = statement[2].split(/[,\s]+/).map((className) => className.trim()).filter(Boolean);

      nodeIds.forEach((nodeId) => {
        classNames.forEach((className) => this.addNodeClass(nodeClasses, nodeId, className));
      });
    });

    return nodeClasses;
  }

  private findIconForClasses(
    classes: Set<string> | undefined,
    classIcons: Map<string, string>,
    classStyles: Map<string, { color?: string }>
  ): { icon: string; color?: string } | null {
    if (!classes) return null;

    for (const className of classes) {
      const icon = classIcons.get(className);
      if (icon) {
        return {
          icon,
          color: classStyles.get(className)?.color || this.findColorForClasses(classes, classStyles),
        };
      }
    }

    return null;
  }

  private findColorForClasses(
    classes: Set<string> | undefined,
    classStyles: Map<string, { color?: string }>
  ): string | undefined {
    if (!classes) return undefined;

    for (const className of classes) {
      const color = classStyles.get(className)?.color;
      if (color) return color;
    }

    return undefined;
  }

  private decorateClassIcons(root: HTMLElement = this.stageEl) {
    if (!this.current?.classIcons.size || !this.current.nodeClasses.size) return;

    for (const [nodeId, classes] of this.current.nodeClasses.entries()) {
      const iconConfig = this.findIconForClasses(classes, this.current.classIcons, this.current.classStyles);
      if (!iconConfig) continue;

      const node = this.findRenderedNode(nodeId, root);
      if (!node) continue;

      this.decorateRenderedNodeIcon(node, iconConfig.icon, this.current.labels.get(nodeId), iconConfig.color);
    }
  }

  private decorateRenderedNodeIcon(node: Element, icon: string, label = '', iconColor?: string) {
    const renderedIcon = this.resolveRenderedIcon(icon);
    if (!renderedIcon || node.querySelector('[data-flowbridge-icon="true"]')) return;
    const displayLabel = label || this.extractRenderedNodeLabel(node);

    node.addClass('fb-icon-node');
    this.expandRenderedNodeForIcon(node);

    const htmlLabel = this.findNodeHtmlLabelElement(node, displayLabel);
    if (htmlLabel instanceof HTMLElement) {
      htmlLabel.dataset.flowbridgeIcon = 'true';
      htmlLabel.classList.add('fb-node-icon');
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

    textEl.setAttr('data-flowbridge-icon', 'true');
    if (iconColor && textEl instanceof SVGElement) {
      textEl.style.fill = iconColor;
    }
    textEl.textContent = `${renderedIcon.fallback} ${this.cleanRenderedLabel(textEl.textContent || displayLabel)}`;
  }

  private setHtmlLabelWithIcon(
    labelEl: HTMLElement,
    icon: { svg?: string; fallback: string },
    label: string,
    iconColor?: string
  ) {
    labelEl.empty();

    if (icon.svg) {
      const iconEl = document.createElement('span');
      iconEl.className = 'fb-node-icon-svg';
      iconEl.setAttr('aria-hidden', 'true');
      iconEl.innerHTML = icon.svg;
      this.applyInlineIconColor(iconEl, iconColor);
      labelEl.appendChild(iconEl);
    } else {
      labelEl.appendText(icon.fallback);
    }

    labelEl.appendText(` ${label}`);
  }

  private applyInlineIconColor(iconEl: HTMLElement, iconColor?: string) {
    if (!iconColor) return;

    iconEl.style.color = iconColor;
    iconEl.querySelectorAll('svg, g, path, polygon, circle, rect, line, polyline, ellipse').forEach((element) => {
      if (!(element instanceof SVGElement)) return;

      element.style.color = iconColor;

      const fill = element.getAttribute('fill');
      if (!fill || !/^(none|transparent)$/i.test(fill)) {
        element.setAttribute('fill', iconColor);
        element.style.setProperty('fill', iconColor, 'important');
      }

      const stroke = element.getAttribute('stroke');
      if (stroke && !/^(none|transparent)$/i.test(stroke)) {
        element.setAttribute('stroke', iconColor);
        element.style.setProperty('stroke', iconColor, 'important');
      }
    });
  }

  private findNodeHtmlLabelElement(node: Element, label = ''): HTMLElement | null {
    const expected = this.normalizeText(label);
    const candidates = Array.from(node.querySelectorAll('foreignObject p, foreignObject span, foreignObject div'))
      .filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement);

    if (expected) {
      const exact = candidates.find((candidate) => this.normalizeText(candidate.textContent || '') === expected);
      if (exact) return exact;
    }

    const leaf = candidates.find((candidate) =>
      this.normalizeText(candidate.textContent || '') &&
      !Array.from(candidate.children).some((child) => this.normalizeText(child.textContent || ''))
    );
    if (leaf) return leaf;

    return candidates.find((candidate) => this.normalizeText(candidate.textContent || '')) || null;
  }

  private findNodeTextElement(node: Element, label = ''): Element | null {
    const expected = this.normalizeText(label);
    const candidates = Array.from(node.querySelectorAll('tspan, text'));

    if (expected) {
      const exact = candidates.find((candidate) => this.normalizeText(candidate.textContent || '') === expected);
      if (exact) return exact;
    }

    return candidates.find((candidate) => this.normalizeText(candidate.textContent || '')) || null;
  }

  private extractRenderedNodeLabel(node: Element): string {
    const text = Array.from(node.querySelectorAll('foreignObject p, foreignObject span, foreignObject div, tspan, text'))
      .map((candidate) => this.cleanRenderedLabel(candidate.textContent || ''))
      .find(Boolean);

    return text || '';
  }

  private expandRenderedNodeForIcon(node: Element) {
    const extraWidth = 36;
    const offset = extraWidth / 2;

    node.querySelectorAll('foreignObject').forEach((element) => {
      this.expandSvgNumericAttr(element, 'width', extraWidth);
      this.expandSvgNumericAttr(element, 'x', -offset);
    });

    node.querySelectorAll('rect').forEach((element) => {
      this.expandSvgNumericAttr(element, 'width', extraWidth);
      this.expandSvgNumericAttr(element, 'x', -offset);
    });
  }

  private expandSvgNumericAttr(element: Element, attr: string, delta: number) {
    const value = Number(element.getAttribute(attr));
    if (!Number.isFinite(value)) return;

    element.setAttribute(attr, String(value + delta));
  }

  private cleanRenderedLabel(value: string): string {
    return String(value || '')
      .replace(/^\s*>_\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private resolveRenderedIcon(icon: string): { svg?: string; fallback: string } | null {
    const normalized = String(icon || '').trim().toLowerCase();

    const directAwsSvg = this.resolveAwsIcon(normalized, true);
    if (directAwsSvg) {
      return {
        svg: directAwsSvg,
        fallback: '',
      };
    }

    const match = normalized.match(/^(fa[a-z]*):fa-([\w-]+)$/);
    if (!match) return null;

    const prefix = match[1];
    const iconName = match[2];
    const definition = this.findFontAwesomeIcon(prefix, iconName);
    if (definition) {
      return {
        svg: this.renderFontAwesomeSvg(definition),
        fallback: iconName === 'terminal' ? '>_' : '',
      };
    }

    const awsSvg = this.resolveAwsIcon(iconName);
    if (awsSvg) {
      return {
        svg: awsSvg,
        fallback: '',
      };
    }

    if (iconName === 'terminal') return { fallback: '>_' };

    return null;
  }

  private resolveAwsIcon(icon: string, requireAwsPrefix = false): string {
    const iconName = this.extractAwsIconName(icon, requireAwsPrefix);
    if (!iconName) return '';

    const slug = AWS_ICON_PACK.aliases[iconName] || (AWS_ICON_PACK.icons[iconName] ? iconName : '');
    if (!slug) return '';

    return AWS_ICON_PACK.icons[slug] || '';
  }

  private extractAwsIconName(icon: string, requireAwsPrefix = false): string {
    const normalized = String(icon || '')
      .trim()
      .toLowerCase();

    const awsMatch = normalized.match(/^aws(?::|-)(?:fa-)?([\w-]+)$/);
    if (awsMatch) return awsMatch[1];

    if (requireAwsPrefix) return '';

    return normalized.replace(/^fa-/, '');
  }

  private findFontAwesomeIcon(prefix: string, iconName: string): IconDefinition | null {
    const pack = FONT_AWESOME_PACKS[prefix];
    if (!pack) return null;

    const exportName = `fa${this.toPascalCase(iconName)}`;
    const exported = pack[exportName];
    if (exported) return exported;

    for (const definition of Object.values(pack)) {
      if (!definition?.icon) continue;
      if (definition.iconName === iconName) return definition;

      const aliases = definition.icon[2] || [];
      if (aliases.some((alias) => String(alias).toLowerCase() === iconName)) {
        return definition;
      }
    }

    return null;
  }

  private toPascalCase(value: string): string {
    return String(value || '')
      .split('-')
      .filter(Boolean)
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join('');
  }

  private renderFontAwesomeSvg(definition: IconDefinition): string {
    const [width, height, , , pathData] = definition.icon;
    const paths = Array.isArray(pathData) ? pathData : [pathData];

    return `
      <svg viewBox="0 0 ${width} ${height}" focusable="false">
        ${paths.map((path) => `<path fill="currentColor" d="${path}"></path>`).join('')}
      </svg>
    `;
  }

  private hasMermaidIcon(label: string): boolean {
    return /^\s*fa[a-z]*:fa-[\w-]+(?:\s|$)/i.test(String(label || ''));
  }

  private parseNodeLabels(content: string): Map<string, string> {
    const labels = new Map<string, string>();
    const nodePattern =
      /^\s*([A-Za-z][\w-]*)\s*(?:\(\[|\[\(|\[\[|\(\(|\[|\(|\{)(.+?)(?:\]\)|\]\]|\)\]|\)\)|\]|\)|\})/;

    content.split(/\r?\n/).forEach((line) => {
      if (/^\s*%%/.test(line) || /^\s*(click|classDef|class|style|linkStyle)\b/i.test(line)) return;
      const match = line.match(nodePattern);
      if (!match) return;
      labels.set(
        match[1],
        match[2]
          .replace(/^\s*fa[a-z]*:fa-[\w-]+\s+/i, '')
          .replace(/<[^>]+>/g, '')
          .trim()
      );
    });

    return labels;
  }

  private resolvePath(path: string, basePath = this.currentPath): string {
    const trimmed = path.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (trimmed.startsWith('/')) return normalizePath(trimmed.slice(1));
    const baseDir = basePath.includes('/') ? basePath.slice(0, basePath.lastIndexOf('/')) : '';
    return normalizePath(baseDir ? `${baseDir}/${trimmed}` : trimmed);
  }

  private normalizeText(value: string): string {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  private escapeCss(value: string): string {
    const css = (window as Window & { CSS?: { escape?: (input: string) => string } }).CSS;
    if (typeof css?.escape === 'function') return css.escape(value);
    return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }
}
