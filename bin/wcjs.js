#!/usr/bin/env node
// Thin wrapper so the npm bin gets a clean shebang (#!/usr/bin/env node).
// cli.ts has a shebang with --experimental-transform-types for local dev,
// and tsgo preserves it in dist/cli.js — which would break on older Node versions.
import '../dist/cli.js';
