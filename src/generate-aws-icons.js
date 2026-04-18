#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const sourceDir = path.join(root, "aws-icons");
const webOut = path.join(root, "app", "shared", "aws-icons.js");
const obsidianOut = path.join(root, "obsidian", "src", "aws-icons.generated.ts");

function slugify(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/&/g, " and ")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function pascalAlias(slug) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");
}

function readSvgFiles(dir) {
  const entries = [];

  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      entries.push(...readSvgFiles(fullPath));
      continue;
    }

    if (item.isFile() && item.name.toLowerCase().endsWith(".svg")) {
      entries.push(fullPath);
    }
  }

  return entries.sort();
}

function uniquifySvgIds(svg, prefix) {
  const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  let next = svg;

  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const replacement = `${prefix}-${slugify(id)}`;
    next = next
      .replace(new RegExp(`id="${escaped}"`, "g"), `id="${replacement}"`)
      .replace(new RegExp(`url\\(#${escaped}\\)`, "g"), `url(#${replacement})`)
      .replace(new RegExp(`href="#${escaped}"`, "g"), `href="#${replacement}"`)
      .replace(new RegExp(`xlink:href="#${escaped}"`, "g"), `xlink:href="#${replacement}"`);
  }

  return next;
}

function cleanSvg(raw, slug) {
  const withoutPreamble = raw
    .replace(/<\?xml[^>]*>\s*/i, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<title>[\s\S]*?<\/title>/gi, "")
    .replace(/<desc>[\s\S]*?<\/desc>/gi, "")
    .trim();

  return uniquifySvgIds(toInlineMonochromeSvg(withoutPreamble), `aws-${slug}`);
}

function toInlineMonochromeSvg(svg) {
  const withoutClipMasks = inlineClipPathIcons(svg)
    .replace(/<defs>[\s\S]*?<\/defs>/gi, "")
    .replace(
      /<g\b(?=[^>]*\bid=["'][^"']*(?:BG|Background|Resource-Icon)[^"']*["'])[^>]*>[\s\S]*?<\/g>/gi,
      ""
    )
    .replace(
      /<g\b[^>]*clip-path=["']url\(#i?0\)["'][^>]*>\s*<polygon\b(?=[^>]*points=["']0,0 80,0 80,80 0,80 0,0["'])[^>]*(?:\/>|>\s*<\/polygon>)\s*<\/g>/gi,
      ""
    )
    .replace(
      /<g\b[^>]*>\s*<rect\b(?=[^>]*\bx=["']?0["']?)(?=[^>]*\by=["']?0["']?)(?=[^>]*\bwidth=["']?80(?:px)?["']?)(?=[^>]*\bheight=["']?80(?:px)?["']?)[^>]*(?:\/>|>\s*<\/rect>)\s*<\/g>/gi,
      ""
    )
    .replace(/<rect\b(?=[^>]*\bx=["']?0["']?)(?=[^>]*\by=["']?0["']?)(?=[^>]*\bwidth=["']?80(?:px)?["']?)(?=[^>]*\bheight=["']?80(?:px)?["']?)[^>]*(?:\/>|>\s*<\/rect>)/gi, "")
    .replace(/\sfill=["'](?!none\b|transparent\b)[^"']*["']/gi, ' fill="currentColor"')
    .replace(/\sstroke=["'](?!none\b|transparent\b)[^"']*["']/gi, ' stroke="currentColor"')
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .trim();

  return withoutClipMasks;
}

function inlineClipPathIcons(svg) {
  const clipPaths = new Map();

  svg.replace(
    /<clipPath\b[^>]*\bid=["']([^"']+)["'][^>]*>\s*<path\b[^>]*\bd=["']([^"']+)["'][^>]*>\s*<\/path>\s*<\/clipPath>/gi,
    (_, id, d) => {
      clipPaths.set(id, d);
      return "";
    }
  );

  return svg.replace(
    /<g\b[^>]*clip-path=["']url\(#([^"')]+)\)["'][^>]*>\s*<polygon\b[^>]*(?:\/>|>\s*<\/polygon>)\s*<\/g>/gi,
    (match, id) => {
      const d = clipPaths.get(id);
      if (!d || /^M\s*80\s*,?\s*0\b/i.test(d)) return match;
      return `<path d="${d}" fill="currentColor"></path>`;
    }
  );
}

function addAlias(aliases, alias, slug) {
  const normalized = slugify(alias);
  if (!normalized || aliases[normalized]) return;
  aliases[normalized] = slug;
}

function buildAliases(fileSlug, categorySlug) {
  const aliases = {};
  const lower = fileSlug.toLowerCase();
  const withoutAmazon = lower.replace(/^amazon-/, "");
  const withoutAws = withoutAmazon.replace(/^aws-/, "");

  [
    lower,
    withoutAmazon,
    withoutAws,
    `${categorySlug}-${withoutAws}`,
    pascalAlias(withoutAws),
  ].forEach((alias) => addAlias(aliases, alias, fileSlug));

  const acronym = withoutAws
    .split("-")
    .filter((part) => part && !["and", "for", "of", "on", "the", "to"].includes(part))
    .map((part) => part.charAt(0))
    .join("");
  if (acronym.length > 1) addAlias(aliases, acronym, fileSlug);

  const manualAliases = {
    "api-gateway": ["apigateway"],
    "cloud-development-kit": ["cdk"],
    "cloud-front": ["cloudfront"],
    "cloud-watch": ["cloudwatch"],
    "dynamo-db": ["dynamodb", "ddb"],
    "elastic-container-registry": ["ecr"],
    "elastic-container-service": ["ecs"],
    "elastic-kubernetes-service": ["eks"],
    "elastic-compute-cloud": ["ec2"],
    "lambda": ["aws-lambda"],
    "simple-notification-service": ["sns"],
    "simple-queue-service": ["sqs"],
    "simple-storage-service": ["s3"],
    "step-functions": ["sfn"],
  };

  for (const [source, values] of Object.entries(manualAliases)) {
    if (withoutAws === source || lower === source) {
      values.forEach((alias) => addAlias(aliases, alias, fileSlug));
    }
  }

  return aliases;
}

function buildIconMap() {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Diretorio nao encontrado: ${sourceDir}`);
  }

  const icons = {};
  const aliases = {};

  for (const svgPath of readSvgFiles(sourceDir)) {
    const relative = path.relative(sourceDir, svgPath);
    const category = path.dirname(relative);
    const basename = path.basename(svgPath, ".svg");
    const fileSlug = slugify(basename);
    const categorySlug = slugify(category);

    icons[fileSlug] = cleanSvg(fs.readFileSync(svgPath, "utf8"), fileSlug);
    for (const [alias, slug] of Object.entries(buildAliases(fileSlug, categorySlug))) {
      addAlias(aliases, alias, slug);
    }
  }

  return { icons, aliases };
}

function banner() {
  return [
    "/*",
    " * Generated by src/generate-aws-icons.js.",
    " * Source SVGs: aws-icons/",
    " * Do not edit manually.",
    " */",
    "",
  ].join("\n");
}

function writeOutputs() {
  const data = buildIconMap();
  const json = JSON.stringify(data, null, 2);

  fs.writeFileSync(
    webOut,
    `${banner()}(function (global) {\n  global.FlowbridgeAwsIcons = ${json};\n})(window);\n`
  );

  fs.writeFileSync(
    obsidianOut,
    `${banner()}export const AWS_ICONS = ${json} as const;\n`
  );

  console.log(`Generated ${Object.keys(data.icons).length} AWS icons.`);
  console.log(`Generated ${Object.keys(data.aliases).length} AWS aliases.`);
}

writeOutputs();
