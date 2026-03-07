// Test entry point — imports all test suites and runs them.

// Unit tests
import './unit/types.test.ts';
import './unit/handle-table.test.ts';
import './unit/waitable-set.test.ts';
import './unit/future.test.ts';
import './unit/stream.test.ts';
import './unit/subtask.test.ts';
import './unit/call-context.test.ts';
import './unit/binary-reader.test.ts';
import './unit/parser.test.ts';
import './unit/event-loop.test.ts';

// Integration tests
import './integration.ts';

// Guest integration tests
import './guest-integration.ts';

// Wasmtime P3 tests
import './wasmtime-p3.ts';

// Generate command tests
import './generate.test.ts';

// Run
import { run } from './runner.ts';
await run();
