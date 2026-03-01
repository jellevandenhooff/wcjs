// Browser integration tests using Playwright.
//
// Serves the demo/dist/ directory and runs headless Chrome to verify
// the calculator component works in a real browser environment.

import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { describe, test, assert, beforeAll } from './runner.ts';

const DIST_DIR = join(import.meta.dirname!, '..', 'demo', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.map': 'application/json',
};

function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const path = req.url === '/' ? '/index.html' : req.url!;
      const filePath = join(DIST_DIR, path);
      try {
        const data = await readFile(filePath);
        const ext = extname(filePath);
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
        });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

describe('browser', () => {
  let chromium: any;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    // Dynamic import so Playwright is only needed when running browser tests
    const pw = await import('playwright');
    chromium = pw.chromium;

    // Start static server
    const s = await startServer();
    server = s.server;
    port = s.port;
  });

  test('auto-run demo completes', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (err: Error) => errors.push(err.message));

      await page.goto(`http://127.0.0.1:${port}/`);

      // Wait for the demo to finish — it logs "done." at the end
      await page.waitForFunction(
        () => document.getElementById('log')?.textContent?.includes('done.'),
        { timeout: 15000 },
      );

      const log = await page.textContent('#log');

      // Verify add(3, 4) = 7
      assert.ok(log!.includes('add(3, 4)'), 'Log should contain add(3, 4)');
      assert.ok(log!.includes('=> 7'), 'Log should contain => 7');

      // Verify double-and-add(5, 7) calls slow-double concurrently
      assert.ok(log!.includes('double-and-add(5, 7)'), 'Log should contain double-and-add call');
      assert.ok(log!.includes('slow-double(5)'), 'Log should contain slow-double(5)');
      assert.ok(log!.includes('slow-double(7)'), 'Log should contain slow-double(7)');
      assert.ok(log!.includes('=> 24'), 'Log should contain => 24 (10 + 14)');

      assert.equal(errors.length, 0, `Console errors: ${errors.join(', ')}`);
    } finally {
      await browser.close();
    }
  });

  test('cleanup', async () => {
    server.close();
  });
});
