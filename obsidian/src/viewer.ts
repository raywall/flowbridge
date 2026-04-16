import { App, TFile, normalizePath } from 'obsidian';
import { FlowbridgeOptions, DiagramData } from './types';
import {
  buildTooltipEl,
  loadExternalAnnotations,
  mergeAnnotations,
  parseInlineAnnotations,
} from './annotations';

type MermaidApi = {
  render: (id: string, definition: string) => Promise<{ svg: string; bindFunctions?: (el: Element) => void }> | { svg: string; bindFunctions?: (el: Element) => void } | string;
  initialize?: (options: Record<string, unknown>) => void;
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
  private tooltipEl: HTMLElement | null = null;
  private current: DiagramData | null = null;
  private history: string[] = [];
  private zoom = { scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };

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
    this.buildToolbar();
    this.svgWrap = this.container.createDiv({ cls: 'fb-svg-wrap' });
    this.svgWrap.style.height = `${this.options.height ?? 480}px`;
    this.stageEl = this.svgWrap.createDiv({ cls: 'fb-stage' });
    this.attachPanZoomHandlers();
    if (this.initialContent) {
      await this.renderInlineDiagram(this.initialContent, this.initialPath, false);
      return;
    }

    await this.renderDiagram(this.currentPath, false);
  }

  private buildToolbar() {
    const bar = this.container.createDiv({ cls: 'fb-toolbar' });
    this.titleEl = bar.createEl('span', { cls: 'fb-toolbar-title', text: '' });

    const resetBtn = bar.createEl('button', { cls: 'fb-btn', attr: { title: 'Resetar diagrama' } });
    resetBtn.setText('↺');
    resetBtn.addEventListener('click', () => {
      this.history = [];
      if (this.initialContent) {
        this.renderInlineDiagram(this.initialContent, this.initialPath, false);
        return;
      }
      this.renderDiagram(this.initialPath, false);
    });

    const backBtn = bar.createEl('button', { cls: 'fb-btn', attr: { title: 'Voltar' } });
    backBtn.setText('←');
    backBtn.addEventListener('click', () => {
      const previous = this.history.pop();
      if (!previous) return;
      if (this.initialContent && previous === this.initialPath) {
        this.renderInlineDiagram(this.initialContent, this.initialPath, false);
        return;
      }
      this.renderDiagram(previous, false);
    });

    const downloadBtn = bar.createEl('button', { cls: 'fb-btn', attr: { title: 'Download .mmd' } });
    downloadBtn.setText('↓');
    downloadBtn.addEventListener('click', () => this.download());
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
    };
    this.titleEl.setText(this.current.title);

    const mermaid = this.getMermaid();
    if (!mermaid) {
      this.stageEl.setText('Mermaid não disponível no Obsidian.');
      return;
    }

    try {
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
      this.decorateSvg();
    } catch (error) {
      this.stageEl.setText('Erro ao renderizar: ' + String(error));
    }
  }

  private getMermaid(): MermaidApi | null {
    return (window as unknown as { mermaid?: MermaidApi }).mermaid ?? null;
  }

  private decorateSvg() {
    if (!this.current) return;
    const svgEl = this.stageEl.querySelector('svg');
    if (!svgEl) return;

    svgEl.querySelectorAll('title').forEach((title) => title.remove());
    svgEl.querySelectorAll('[title]').forEach((el) => el.removeAttribute('title'));

    for (const [nodeId, targetPath] of this.current.links.entries()) {
      const node = this.findRenderedNode(nodeId);
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
      const node = this.findRenderedNode(nodeId);
      if (!node) continue;
      node.addClass('fb-annotated-node');
      node.setAttr('tabindex', node.getAttr('tabindex') || '0');
    }

    this.stageEl.addEventListener('mousemove', (event) => this.handleAnnotationHover(event));
    this.stageEl.addEventListener('mouseleave', () => this.hideTooltip());
    this.stageEl.addEventListener('focusin', (event) => this.handleAnnotationHover(event as FocusEvent));
    this.stageEl.addEventListener('focusout', () => this.hideTooltip());
  }

  private openExternalPath(path: string) {
    const resolved = this.resolvePath(path);
    if (/^https?:\/\//i.test(resolved)) {
      window.open(resolved, '_blank', 'noopener');
      return;
    }

    this.renderDiagram(resolved, true);
  }

  private handleAnnotationHover(event: MouseEvent | FocusEvent) {
    const match = this.findAnnotationFromEvent(event);
    if (!match) {
      if (event.type !== 'mousemove') this.hideTooltip();
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

  private findRenderedNode(nodeId: string): Element | null {
    const escapedNodeId = this.escapeCss(nodeId);
    const selectors = [
      `#${escapedNodeId}`,
      `#flowchart-${escapedNodeId}-0`,
      `[id^="flowchart-${nodeId}-"]`,
      `[data-id="${nodeId}"]`,
      `[data-node-id="${nodeId}"]`,
    ];

    for (const selector of selectors) {
      const node = this.stageEl.querySelector(selector);
      if (node) return node;
    }

    const label = this.current?.labels.get(nodeId);
    if (label) {
      return this.findRenderedNodeByLabel(label);
    }

    return null;
  }

  private findRenderedNodeByLabel(label: string): Element | null {
    const expected = this.normalizeText(label);
    const candidates = this.stageEl.querySelectorAll('g, text, tspan, span, div');
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

    this.hideTooltip();
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

  private resetZoom() {
    this.zoom = { scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };
    this.applyZoom();
  }

  private applyZoom() {
    if (!this.stageEl) return;
    this.stageEl.style.transform = `translate(${this.zoom.x}px, ${this.zoom.y}px) scale(${this.zoom.scale})`;
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

  private parseNodeLabels(content: string): Map<string, string> {
    const labels = new Map<string, string>();
    const nodePattern =
      /^\s*([A-Za-z][\w-]*)\s*(?:\(\[|\[\(|\[\[|\(\(|\[|\(|\{)(.+?)(?:\]\)|\]\]|\)\]|\)\)|\]|\)|\})/;

    content.split(/\r?\n/).forEach((line) => {
      if (/^\s*%%/.test(line) || /^\s*(click|classDef|class|style|linkStyle)\b/i.test(line)) return;
      const match = line.match(nodePattern);
      if (!match) return;
      labels.set(match[1], match[2].replace(/<[^>]+>/g, '').trim());
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
