// Separate entry point for browser tests.
// Run with: npm run test:browser
//
// Requires Playwright and a built demo (npm run demo:build).

import './browser.test.ts';
import { run } from './runner.ts';
await run();
