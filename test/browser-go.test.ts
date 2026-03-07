// Browser integration tests for the Go playground demo using Playwright.
//
// Serves demo/go/dist/ and runs headless Chrome to verify the Go compiler
// works in a real browser environment.

import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { describe, test, assert, beforeAll } from './runner.ts';

const DIST_DIR = join(import.meta.dirname!, '..', 'demo', 'go', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.tar': 'application/octet-stream',
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

// Helper to set up a page with logging and long timeouts
async function setupPage(browser: any, port: number) {
  const page = await browser.newPage();
  page.setDefaultTimeout(600000);
  const errors: string[] = [];
  page.on('pageerror', (err: Error) => {
    console.error(`[PAGE ERROR] ${err.message}`);
    errors.push(err.message);
  });
  page.on('console', (msg: any) => {
    if (msg.type() === 'error') console.error(`[browser] ${msg.text()}`);
  });

  await page.goto(`http://127.0.0.1:${port}/`, { timeout: 0 });

  // Wait for Ready status (GOROOT + cache loading)
  await page.waitForFunction(() => {
    const el = document.getElementById('output');
    return el && el.textContent?.includes('Ready');
  });

  return { page, errors };
}

describe('browser-go', () => {
  let chromium: any;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const pw = await import('playwright');
    chromium = pw.chromium;

    const s = await startServer();
    server = s.server;
    port = s.port;
  });

  test('fmt adds missing imports', async () => {
    const browser = await chromium.launch();
    try {
      const { page, errors } = await setupPage(browser, port);

      // Set code without imports
      await page.evaluate(() => {
        (document.getElementById('editor') as HTMLTextAreaElement).value =
          'package main\n\nfunc main(){\nfmt.Println(  "hi"  )\n}\n';
      });
      await page.click('#fmtBtn');
      await page.waitForFunction(
        () => !(document.getElementById('fmtBtn') as HTMLButtonElement).disabled,
      );

      const formatted = await page.evaluate(
        () => (document.getElementById('editor') as HTMLTextAreaElement).value,
      );
      assert(formatted.includes('import "fmt"'), 'expected goimports to add import');
      assert(formatted.includes('fmt.Println("hi")'), 'expected formatted code');
      assert(errors.length === 0, `expected no page errors, got: ${errors.join(', ')}`);
    } finally {
      await browser.close();
    }
  });

  test('build and run produces output', async () => {
    const browser = await chromium.launch();
    try {
      const { page, errors } = await setupPage(browser, port);

      // Click Build & Run
      await page.click('#buildBtn');

      // Wait for final status
      await page.waitForFunction(() => {
        const status = document.getElementById('status')?.textContent || '';
        return status.startsWith('Built in') || status === 'Build failed' || status === 'Error';
      });

      const output = await page.evaluate(
        () => document.getElementById('output')?.textContent || '',
      );
      const status = await page.evaluate(
        () => document.getElementById('status')?.textContent || '',
      );

      console.log(`Build status: ${status}`);
      console.log(`Output: ${output.slice(-200)}`);

      assert(status.startsWith('Built in'), `expected "Built in ...", got: ${status}`);
      assert(output.includes('Hello from the browser!'), 'expected program output');
      assert(errors.length === 0, `expected no page errors, got: ${errors.join(', ')}`);
    } finally {
      await browser.close();
    }
  });
});
