// Separate entry point for Go browser tests.
// Run with: npm run test:browser-go
//
// Requires Playwright and a built Go demo (npm run demo:go:build).

import './browser-go.test.ts';
import { run } from './runner.ts';
await run();
