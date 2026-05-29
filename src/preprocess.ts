import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import potrace from 'potrace';

interface Args {
  input: string;
  threshold: number;
  blur: number;
  turdSize: number;
  outDir: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { input: 'demo_img.jpeg', threshold: 140, blur: 0.5, turdSize: 4, outDir: 'public' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--threshold') args.threshold = Number(argv[++i]);
    else if (a === '--blur') args.blur = Number(argv[++i]);
    else if (a === '--turd-size') args.turdSize = Number(argv[++i]);
    else if (a === '--out-dir') args.outDir = argv[++i];
    else if (!a.startsWith('--')) args.input = a;
  }
  return args;
}

async function sampleBackgroundColor(input: string): Promise<string> {
  // Resize to a small thumb so local texture averages out, then median-sample
  // four corner patches — corners are most likely to be paper (not subject).
  const thumbSize = 64;
  const patchSize = 8;
  const { data, info } = await sharp(input)
    .resize(thumbSize, thumbSize, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const corners = [
    [0, 0],
    [width - patchSize, 0],
    [0, height - patchSize],
    [width - patchSize, height - patchSize],
  ];
  const samples: Array<[number, number, number]> = [];
  for (const [cx, cy] of corners) {
    for (let dy = 0; dy < patchSize; dy++) {
      for (let dx = 0; dx < patchSize; dx++) {
        const idx = ((cy + dy) * width + (cx + dx)) * channels;
        samples.push([data[idx], data[idx + 1], data[idx + 2]]);
      }
    }
  }
  const median = (ch: 0 | 1 | 2) => {
    const sorted = samples.map((s) => s[ch]).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const r = median(0);
  const g = median(1);
  const b = median(2);
  const hex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

async function makeLineBitmap(input: string, out: string, threshold: number, blur: number) {
  let pipeline = sharp(input).grayscale();
  if (blur > 0) pipeline = pipeline.blur(blur);
  await pipeline.threshold(threshold).toFile(out);
}

function tracePotrace(bitmapPath: string, turdSize: number, threshold: number): Promise<string> {
  return new Promise((resolve, reject) => {
    potrace.trace(
      bitmapPath,
      {
        threshold,
        turdSize,
        optTolerance: 0.4,
        color: '#3a2a20',
        background: 'transparent',
        turnPolicy: potrace.Potrace.TURNPOLICY_MINORITY,
      },
      (err: Error | null, svg: string) => (err ? reject(err) : resolve(svg)),
    );
  });
}

interface SplitResult {
  width: number;
  height: number;
  viewBox: string;
  paths: string[];
}

function splitSvgPaths(svg: string): SplitResult {
  const widthMatch = svg.match(/<svg[^>]*\swidth="([^"]+)"/);
  const heightMatch = svg.match(/<svg[^>]*\sheight="([^"]+)"/);
  const viewBoxMatch = svg.match(/<svg[^>]*\sviewBox="([^"]+)"/);
  const pathMatch = svg.match(/<path[^>]*\sd="([^"]+)"/);
  if (!widthMatch || !heightMatch || !pathMatch) {
    throw new Error('Could not parse potrace SVG output');
  }
  const width = parseFloat(widthMatch[1]);
  const height = parseFloat(heightMatch[1]);
  const viewBox = viewBoxMatch ? viewBoxMatch[1] : `0 0 ${width} ${height}`;
  const d = pathMatch[1];

  // Split on each absolute Moveto. potrace uses uppercase M to start subpaths.
  const subpaths = d
    .split(/(?=M\s)/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return { width, height, viewBox, paths: subpaths };
}

function buildAnimatedSvg(split: SplitResult): string {
  const pathEls = split.paths
    .map(
      (d, i) =>
        `  <path data-idx="${i}" d="${d}" fill="none" stroke="#3a2a20" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />`,
    )
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${split.width}" height="${split.height}" viewBox="${split.viewBox}">
${pathEls}
</svg>
`;
}

async function main() {
  const args = parseArgs();
  if (!fs.existsSync(args.input)) {
    console.error(`Input not found: ${args.input}`);
    process.exit(1);
  }
  const outDir = args.outDir;
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[preprocess] input=${args.input} threshold=${args.threshold} blur=${args.blur} turdSize=${args.turdSize}`);

  const meta = await sharp(args.input).metadata();
  if (!meta.width || !meta.height) throw new Error('Could not read image dimensions');

  const linesBitmap = path.join(outDir, '_lines_bitmap.png');
  await makeLineBitmap(args.input, linesBitmap, args.threshold, args.blur);
  console.log(`[preprocess] wrote ${linesBitmap}`);

  const svgRaw = await tracePotrace(linesBitmap, args.turdSize, 128);
  const split = splitSvgPaths(svgRaw);
  const animSvg = buildAnimatedSvg(split);
  const linesSvgPath = path.join(outDir, 'lines.svg');
  fs.writeFileSync(linesSvgPath, animSvg);
  console.log(`[preprocess] wrote ${linesSvgPath} (${split.paths.length} paths)`);

  const colorPng = path.join(outDir, 'color.png');
  await sharp(args.input).png().toFile(colorPng);
  console.log(`[preprocess] wrote ${colorPng}`);

  const bgColor = await sampleBackgroundColor(args.input);
  console.log(`[preprocess] sampled bgColor=${bgColor}`);

  const metaJson = {
    width: meta.width,
    height: meta.height,
    pathCount: split.paths.length,
    bgColor,
  };
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(metaJson, null, 2));
  console.log(`[preprocess] done. ${meta.width}x${meta.height}, ${split.paths.length} paths, bg ${bgColor}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
