import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const text = (path) => readFileSync(resolve(root, path), 'utf8');
const bytes = (path) => readFileSync(resolve(root, path));
const encode = (data) => data?.toString('base64') ?? null;
const sha = (chunks) => {
  const hash = createHash('sha256');
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest('hex').slice(0, 20);
};
const literal = (data) => JSON.stringify(data).replace(/</g, '\\u003c');

const worker = text('src/worker.js');
const runtime = text('src/runtime.js');
const antialiasing = text('src/antialiasing.js');
const frameTiming = text('src/frame-timing.js');
const styles = text('src/styles.css');
let template = text('src/index.html');
const { fleet, props } = JSON.parse(text('src/asset-catalog.json'));

const assets = Object.fromEntries(Object.entries(fleet).map(([key, input]) => {
  const body = input.body ? bytes(input.body) : null;
  const wheel = input.wheel ? bytes(input.wheel) : null;
  const sources = [worker, JSON.stringify(input.profile)];
  for (const data of [body, wheel].filter(Boolean)) sources.push(data);
  const parts = input.parts ? Object.fromEntries(Object.entries(input.parts).map(([partName, part]) => {
    const source = bytes(part.source);
    sources.push(source);
    return [partName, { ...part, source: encode(source) }];
  })) : undefined;
  const { icon, ...fields } = input;
  if (icon) {
    const src = 'src="../' + icon + '"';
    if (!template.includes(src)) throw new Error('Missing template icon: ' + icon);
    template = template.replace(src, () => 'src="data:image/png;base64,' + encode(bytes(icon)) + '"');
  }
  const asset = { ...fields, body: encode(body), wheel: encode(wheel), version: sha(sources) };
  if (parts) asset.parts = parts;
  return [key, asset];
}));

const canisters = props.map(({ id, source }) => {
  const png = bytes(source);
  return { id, encoded: encode(png), version: sha([png, worker]) };
});

const configuration = [
  'const CANISTER_ASSETS=' + literal(canisters) + ';',
  'const WORKER_SOURCE=' + literal(worker) + ';',
  'const ASSETS=' + literal(assets) + ';',
].join('\n');

// Keep strict mode at the start of the inline script, before the generated data.
const strict = '"use strict";\n';
if (!runtime.startsWith(strict) || /<\/script[\s>]/i.test(runtime)) {
  throw new Error('Runtime must start in strict mode and be safe to inline');
}
const output = template
  .replace('<!-- STYLES -->', () => '<style>\n' + styles + '</style>')
  .replace('<!-- SCRIPTS -->', () => '<script>\n' + strict + configuration + '\n' + antialiasing + '\n' + frameTiming + '\n' + runtime.slice(strict.length) + '</script>');

mkdirSync(resolve(root, 'dist'), { recursive: true });
const file = resolve(root, 'dist/index.html');
writeFileSync(file + '.tmp', output);
renameSync(file + '.tmp', file);
console.log('dist/index.html · ' + (Buffer.byteLength(output) / 1024 / 1024).toFixed(2) + ' MiB · ' + canisters.length + ' canisters');
