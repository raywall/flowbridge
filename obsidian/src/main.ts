import { Plugin, MarkdownPostProcessorContext } from 'obsidian';
import { FlowbridgeViewer } from './viewer';
import { FlowbridgeOptions } from './types';

export default class FlowbridgePlugin extends Plugin {
  async onload() {
    // Bloco de código: ```flowbridge
    this.registerMarkdownCodeBlockProcessor(
      'flowbridge',
      async (source, el, ctx) => {
        const options = this._parseOptions(source);
        if (!options.src && !options.content) {
          el.setText('flowbridge: informe "src" ou escreva o Mermaid dentro do bloco.');
          return;
        }

        options.sourcePath = ctx.sourcePath;

        // Resolve o caminho relativo ao arquivo atual no vault
        if (options.src) {
          options.src = this._resolvePath(ctx, options.src);
        }
        if (options.annotationsSrc) {
          options.annotationsSrc = this._resolvePath(ctx, options.annotationsSrc);
        }

        const viewer = new FlowbridgeViewer(this.app, el, options);
        await viewer.start();
      }
    );
  }

  // Parseia as opções do bloco:
  //   src: diagrams/vendas.mmd
  //   height: 520
  //   tooltipTrigger: click
  // Ou aceita o Mermaid diretamente no bloco.
  private _parseOptions(source: string): FlowbridgeOptions {
    const opts: FlowbridgeOptions = {};
    const diagramLines: string[] = [];
    const optionKeys = new Set(['src', 'annotationsSrc', 'height', 'theme', 'tooltipTrigger']);

    for (const line of source.split('\n')) {
      const [key, ...rest] = line.split(':');
      const value = rest.join(':').trim();
      const normalizedKey = key.trim();

      if (!optionKeys.has(normalizedKey)) {
        diagramLines.push(line);
        continue;
      }

      if (!value) continue;

      switch (key.trim()) {
        case 'src':              opts.src = value; break;
        case 'annotationsSrc':  opts.annotationsSrc = value; break;
        case 'height': {
          const height = Number.parseInt(value, 10);
          if (!Number.isNaN(height)) opts.height = height;
          break;
        }
        case 'theme':           opts.theme = value; break;
        case 'tooltipTrigger':  opts.tooltipTrigger = value as any; break;
      }
    }

    const content = diagramLines.join('\n').trim();
    if (content) opts.content = content;

    return opts;
  }

  private _resolvePath(ctx: MarkdownPostProcessorContext, relativePath: string): string {
    if (relativePath.startsWith('/') || relativePath.startsWith('http')) return relativePath;
    const notePath = ctx.sourcePath;
    const noteDir  = notePath.substring(0, notePath.lastIndexOf('/'));
    return noteDir ? `${noteDir}/${relativePath}` : relativePath;
  }
}
