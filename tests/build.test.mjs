import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url));
const html = read('dist/index.html').toString();
const catalog = JSON.parse(read('src/asset-catalog.json'));

function embedded(key) {
  const start = html.indexOf('const ' + key + '=');
  assert.ok(start >= 0);
  const line = html.slice(start, html.indexOf('\n', start));
  return JSON.parse(line.slice(key.length + 7, -1));
}

test('the standalone page has valid scripts and no external runtime dependencies', () => {
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<(?:script|link)\b[^>]*(?:src|href)=/i);
  for (const image of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)) {
    assert.match(image[1], /^data:image\/png;base64,/);
  }
  const start = html.indexOf('<script>') + '<script>'.length;
  const script = html.slice(start, html.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new vm.Script(script, { filename: 'index.html' }));
  assert.equal(embedded('WORKER_SOURCE'), read('src/worker.js').toString());
});

test('the fleet and all placed canisters match the source PNG bytes', () => {
  const fleet = embedded('ASSETS');
  assert.deepEqual(Object.keys(fleet), Object.keys(catalog.fleet));
  for (const [name, entry] of Object.entries(catalog.fleet)) {
    for (const key of ['body', 'wheel']) {
      if (entry[key]) assert.deepEqual(Buffer.from(fleet[name][key], 'base64'), read(entry[key]), entry[key]);
    }
    if (entry.icon) {
      const start = html.indexOf('data-vehicle="' + name + '"');
      assert.ok(start >= 0);
      const option = html.slice(start, html.indexOf('</button>', start));
      const thumbnail = option.match(/src="data:image\/png;base64,([^"]+)"/);
      assert.ok(thumbnail, name);
      assert.deepEqual(Buffer.from(thumbnail[1], 'base64'), read(entry.icon), entry.icon);
    }
    for (const [key, part] of Object.entries(entry.parts ?? {})) {
      assert.deepEqual(Buffer.from(fleet[name].parts[key].source, 'base64'), read(part.source), part.source);
    }
  }
  const props = embedded('CANISTER_ASSETS');
  assert.deepEqual(props.map(({ id }) => id), catalog.props.map(({ id }) => id));
  for (const [i, { source }] of catalog.props.entries()) {
    assert.deepEqual(Buffer.from(props[i].encoded, 'base64'), read(source), source);
  }
});
