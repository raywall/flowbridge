import { App, TFile, normalizePath } from 'obsidian';
import { AnnotationsMap, NodeAnnotation } from './types';

function stripMermaidComment(line: string): string {
  return String(line || '').replace(/^\s*%%\s?/, '');
}

function normalizeKey(key: string): string {
  return String(key || '').trim().toLowerCase();
}

function parseLink(value: string) {
  const parts = String(value || '').split(/\s+\|\s+/);
  if (parts.length > 1) {
    return {
      label: parts.shift()?.trim() || parts.join(' | ').trim(),
      href: parts.join(' | ').trim(),
    };
  }

  return {
    label: String(value || '').trim(),
    href: String(value || '').trim(),
  };
}

function parseTooltipBlock(lines: string[]): NodeAnnotation {
  const annotation: NodeAnnotation = {};

  lines.map(stripMermaidComment).forEach((line) => {
    const match = line.match(/^\s*([a-zA-Z][\w-]*)\s*:\s*(.*)$/);
    if (!match) return;

    const key = normalizeKey(match[1]);
    const value = match[2].trim();
    if (!value) return;

    if (key === 'title') annotation.title = value;
    if (key === 'description' || key === 'desc') annotation.description = value;
    if (key === 'owner') annotation.owner = value;
    if (key === 'sla') annotation.sla = value;
    if (key === 'since') annotation.since = value;
    if (key === 'alert') annotation.alert = value;
    if (key === 'tags') {
      annotation.tags = value.split(',').map((tag) => tag.trim()).filter(Boolean);
    }
    if (key === 'link') {
      annotation.links = [...(annotation.links || []), parseLink(value)];
    }
  });

  return annotation;
}

export function parseInlineAnnotations(content: string): AnnotationsMap {
  const annotations: AnnotationsMap = {};
  const lines = String(content || '').split(/\r?\n/);
  const blockStartPattern = /^\s*%%\s*@tooltip\s+([^\s:|]+)\s*$/i;
  const blockEndPattern = /^\s*%%\s*@end\s*$/i;

  for (let index = 0; index < lines.length; index += 1) {
    const block = lines[index].match(blockStartPattern);
    if (!block) continue;

    const nodeId = block[1];
    const blockLines: string[] = [];
    index += 1;

    while (index < lines.length && !blockEndPattern.test(lines[index])) {
      blockLines.push(lines[index]);
      index += 1;
    }

    annotations[nodeId] = parseTooltipBlock(blockLines);
  }

  return annotations;
}

export async function loadExternalAnnotations(
  app: App,
  mmdPath: string,
  overridePath?: string
): Promise<AnnotationsMap> {
  const annotPath = normalizePath(overridePath ?? mmdPath.replace(/\.mmd$/i, '.annotations.json'));
  const file = app.vault.getAbstractFileByPath(annotPath);
  if (!(file instanceof TFile)) return {};

  try {
    const raw = await app.vault.read(file);
    return JSON.parse(raw) as AnnotationsMap;
  } catch {
    return {};
  }
}

export function mergeAnnotations(...items: AnnotationsMap[]): AnnotationsMap {
  return Object.assign({}, ...items);
}

export function buildTooltipEl(data: NodeAnnotation, onExtClick: (path: string) => void): HTMLElement {
  const tip = document.createElement('div');
  tip.className = 'fb-tooltip';

  if (data.title) {
    tip.createEl('div', { cls: 'fb-tooltip-title', text: data.title });
  }
  if (data.description) {
    tip.createEl('div', { cls: 'fb-tooltip-desc', text: data.description });
  }
  if (data.alert) {
    const alertEl = tip.createEl('div', { cls: 'fb-tooltip-alert' });
    alertEl.setText('⚠ ' + data.alert);
  }

  if (data.tags?.length) {
    const tagWrap = tip.createEl('div', { cls: 'fb-tooltip-tags' });
    data.tags.forEach((tag) => tagWrap.createEl('span', { cls: 'fb-tooltip-tag', text: tag }));
  }

  const meta: [string, string | undefined][] = [
    ['Owner', data.owner],
    ['SLA', data.sla],
    ['Desde', data.since],
  ];

  meta.forEach(([label, value]) => {
    if (!value) return;
    const row = tip.createEl('div', { cls: 'fb-tooltip-meta' });
    row.createEl('span', { cls: 'fb-tooltip-meta-label', text: `${label}: ` });
    row.createSpan({ text: value });
  });

  if (data.links?.length) {
    const linksWrap = tip.createEl('div', { cls: 'fb-tooltip-links' });
    data.links.forEach((link) => {
      const anchor = linksWrap.createEl('a', {
        cls: 'fb-tooltip-link',
        text: '↗ ' + (link.label || link.href),
      });

      if (link.href.startsWith('ext:')) {
        anchor.href = '#';
        anchor.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          onExtClick(link.href.replace(/^ext:/, '').trim());
        });
        return;
      }

      anchor.href = link.href;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    });
  }

  return tip;
}
