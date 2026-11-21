import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Not using vitest's `test.globals`, so testing-library's auto-cleanup never
// registers on its own — without this, each render() leaks into the next test.
afterEach(cleanup);
