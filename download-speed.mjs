import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const REQUEST_COUNT = 10;
const TIMEOUT_MS = 30_000;

export function parseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Укажите абсолютный HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Поддерживаются только HTTP и HTTPS.');
  }
  if (url.username || url.password) {
    throw new Error('URL с логином и паролем не поддерживается.');
  }
  return url;
}

export async function download(url, { timeoutMs = TIMEOUT_MS } = {}) {
  const target = parseUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();

  try {
    const bytes = await new Promise((resolve, reject) => {
      const transport = target.protocol === 'https:' ? https : http;
      const request = transport.get(target, {
        signal: controller.signal,
        // Independent connections: the benchmark does not reuse a warm socket.
        agent: false,
        headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' },
      }, (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.destroy();
          const hint = status >= 300 && status < 400
            ? ' Используйте конечный URL: автоматических редиректов нет.' : '';
          reject(new Error(`HTTP ${status}.${hint}`));
          return;
        }

        let received = 0;
        response.on('data', (chunk) => { received += chunk.length; });
        response.once('end', () => resolve(received));
        response.once('aborted', () => reject(new Error('Ответ оборвался до завершения.')));
        response.once('error', reject);
      });
      request.once('error', reject);
    });
    return { bytes, durationMs: performance.now() - start };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Таймаут: запрос не завершился за ${timeoutMs} мс.`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function summarize(samples) {
  const totalBytes = samples.reduce((sum, sample) => sum + sample.bytes, 0);
  const totalMs = samples.reduce((sum, sample) => sum + sample.durationMs, 0);
  return {
    count: samples.length,
    totalBytes,
    totalMs,
    averageMs: totalMs / samples.length,
    mbps: totalBytes * 8 / (totalMs / 1000) / 1_000_000,
  };
}

export async function measure(url, options) {
  const target = parseUrl(url);
  const samples = [];
  for (let index = 0; index < REQUEST_COUNT; index += 1) {
    try {
      // Awaiting the complete body also prevents overlap between requests.
      samples.push(await download(target, options));
    } catch (error) {
      throw new Error(`Запрос ${index + 1}/${REQUEST_COUNT}: ${error.message}`, { cause: error });
    }
  }
  return summarize(samples);
}

async function main() {
  if (process.argv.length !== 3) {
    throw new Error('Запуск: node download-speed.mjs <http(s)://адрес-файла>');
  }
  const result = await measure(process.argv[2]);
  console.log(`Успешных запросов: ${result.count}`);
  console.log(`Среднее время запроса: ${result.averageMs.toFixed(2)} мс`);
  console.log(`Всего скачано: ${result.totalBytes} байт (${(result.totalBytes / 1024 ** 2).toFixed(2)} МиБ)`);
  console.log(`Суммарное время запросов: ${(result.totalMs / 1000).toFixed(3)} с`);
  console.log(`Скорость скачивания: ${result.mbps.toFixed(3)} Мбит/с`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Ошибка: ${error.message}`);
    process.exitCode = 1;
  });
}
