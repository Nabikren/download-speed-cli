import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { download, measure, parseUrl, summarize } from '../download-speed.mjs';

async function serverFor(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('rejects invalid URLs and unsupported protocols', () => {
  for (const value of ['bad-url', 'file:///tmp/file', 'ftp://example.org/file', 'https://user:pass@example.org']) {
    assert.throws(() => parseUrl(value));
  }
  assert.equal(parseUrl('https://example.org/a?q=1').protocol, 'https:');
});

test('makes exactly 10 sequential requests and counts actual binary body bytes', async (t) => {
  let requests = 0;
  let active = 0;
  let maxActive = 0;
  const url = await serverFor(t, (_request, response) => {
    requests += 1;
    active += 1;
    maxActive = Math.max(active, maxActive);
    response.on('finish', () => { active -= 1; });
    response.write(Buffer.alloc(4096, 0xff));
    setTimeout(() => response.end(Buffer.alloc(3072, 0x80)), 5);
  });
  const result = await measure(url);
  assert.equal(requests, 10);
  assert.equal(maxActive, 1);
  assert.equal(result.count, 10);
  assert.equal(result.totalBytes, 10 * (4096 + 3072));
  assert.ok(result.averageMs > 0);
});

test('waits for the end of a chunked body, not only response headers', async (t) => {
  const url = await serverFor(t, (_request, response) => {
    response.flushHeaders();
    response.write('first');
    setTimeout(() => response.end('last'), 60);
  });
  const result = await download(url);
  assert.equal(result.bytes, 9);
  assert.ok(result.durationMs >= 50, `Measured only ${result.durationMs} ms`);
});

test('throughput uses total bytes / total time, not mean of individual speeds', () => {
  const result = summarize([
    { bytes: 1_000_000, durationMs: 1000 },
    { bytes: 1_000_000, durationMs: 3000 },
  ]);
  assert.equal(result.totalBytes, 2_000_000);
  assert.equal(result.averageMs, 2000);
  assert.equal(result.mbps, 4);
});

test('supports an empty successful response', async (t) => {
  const url = await serverFor(t, (_request, response) => response.writeHead(204).end());
  const result = await measure(url);
  assert.equal(result.count, 10);
  assert.equal(result.totalBytes, 0);
  assert.equal(result.mbps, 0);
});

test('HTTP failure stops the run without retries or a misleading final measurement', async (t) => {
  let requests = 0;
  const url = await serverFor(t, (_request, response) => {
    requests += 1;
    response.writeHead(500).end('server error');
  });
  await assert.rejects(measure(url), /Запрос 1\/10: HTTP 500/);
  assert.equal(requests, 1);
});

test('does not follow redirects or silently add extra requests', async (t) => {
  const url = await serverFor(t, (_request, response) => {
    response.writeHead(302, { Location: '/final' }).end();
  });
  await assert.rejects(download(url), /HTTP 302.*конечный URL/);
});

test('has an overall deadline even if the server keeps sending data', async (t) => {
  const url = await serverFor(t, (_request, response) => {
    response.write('a');
    const interval = setInterval(() => response.write('b'), 5);
    response.on('close', () => clearInterval(interval));
  });
  await assert.rejects(download(url, { timeoutMs: 40 }), /Таймаут/);
});

test('rejects a truncated body instead of counting it as a complete download', async (t) => {
  const url = await serverFor(t, (_request, response) => {
    response.writeHead(200, { 'Content-Length': '1000' });
    response.write('partial');
    setTimeout(() => response.destroy(), 5);
  });
  await assert.rejects(download(url), /Ответ оборвался|aborted|ECONNRESET/);
});

test('CLI prints the required result for a real local HTTP server', async (t) => {
  const url = await serverFor(t, (_request, response) => response.end(Buffer.alloc(100)));
  const script = fileURLToPath(new URL('../download-speed.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, url]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Успешных запросов: 10/);
  assert.match(stdout, /Всего скачано: 1000 байт/);
  assert.match(stdout, /Среднее время запроса:/);
  assert.match(stdout, /Скорость скачивания: [\d.]+ Мбит\/с/);
});

test('CLI without a URL exits with a clear error and nonzero status', async () => {
  const script = fileURLToPath(new URL('../download-speed.mjs', import.meta.url));
  const child = spawn(process.execPath, [script]);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  assert.match(stderr, /Запуск:/);
});
