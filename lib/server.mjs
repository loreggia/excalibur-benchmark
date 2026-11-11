import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

/**
 * Tiny static server: serves `root` (the built harness) and the given engine bundles under `/engines/<key>.js`
 * @param {{ root: string, engines: Record<string, string> }} options
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function createServer({ root, engines }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let file;
    const engineMatch = url.pathname.match(/^\/engines\/([^/]+)\.js$/);
    if (engineMatch) {
      file = engines[engineMatch[1]];
    } else {
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      file = path.join(root, path.normalize(relative));
      if (!file.startsWith(path.resolve(root))) {
        file = undefined;
      }
    }
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      // cross-origin isolation, without which Chromium rounds performance.now() to 100µs: a third of a 300µs step
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}
