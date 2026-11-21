/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/__tests__'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: './tsconfig.test.json',
    }],
  },
  moduleNameMapper: {
    // Prevent heavy OTel SDK from loading in unit tests (not needed for logic tests)
    '@opentelemetry/sdk-node': '<rootDir>/src/__tests__/__mocks__/otelSdk.ts',
    '@opentelemetry/auto-instrumentations-node': '<rootDir>/src/__tests__/__mocks__/otelSdk.ts',
    '@opentelemetry/exporter-trace-otlp-http': '<rootDir>/src/__tests__/__mocks__/otelSdk.ts',
  },
  testTimeout: 15000,
  clearMocks: true,
  // Integration tests share a real PostgreSQL database. Running them in parallel
  // causes cleanDb() calls from different workers to wipe each other's mid-test data.
  // maxWorkers: 1 enforces sequential execution regardless of how jest is invoked
  // (CLI flag or npm script). This is the canonical fix — do NOT remove it.
  maxWorkers: 1,
  // Was limited to services/ + two hand-picked files — routes/ (the actual
  // request-handling layer) wasn't measured at all. No coverageThreshold yet:
  // this repo has no coverage baseline (no local DB to run integration tests
  // against outside CI), so a number here would be a guess. Run `npm run
  // test -- --coverage` in CI once and set a real threshold from that result.
  collectCoverageFrom: [
    'src/services/**/*.ts',
    'src/routes/**/*.ts',
    'src/middleware/**/*.ts',
    '!src/**/__tests__/**',
  ],
  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/__tests__/unit/**/*.test.ts'],
      transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: './tsconfig.test.json' }] },
      moduleNameMapper: {
        '@opentelemetry/sdk-node': '<rootDir>/src/__tests__/__mocks__/otelSdk.ts',
        '@opentelemetry/auto-instrumentations-node': '<rootDir>/src/__tests__/__mocks__/otelSdk.ts',
        '@opentelemetry/exporter-trace-otlp-http': '<rootDir>/src/__tests__/__mocks__/otelSdk.ts',
      },
      testTimeout: 15000,
      clearMocks: true,
    },
    {
      displayName: 'integration',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/__tests__/integration/**/*.test.ts'],
      transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: './tsconfig.test.json' }] },
      moduleNameMapper: {
        '@opentelemetry/sdk-node': '<rootDir>/src/__tests__/__mocks__/otelSdk.ts',
        '@opentelemetry/auto-instrumentations-node': '<rootDir>/src/__tests__/__mocks__/otelSdk.ts',
        '@opentelemetry/exporter-trace-otlp-http': '<rootDir>/src/__tests__/__mocks__/otelSdk.ts',
      },
      testTimeout: 30000,
      clearMocks: true,
      maxWorkers: 1,
      // Disconnect the lib/prisma singleton after every suite — its pool leaks
      // across jest's per-suite module registries and exhausts max_connections.
      setupFilesAfterEnv: ['<rootDir>/src/__tests__/helpers/disconnectPrisma.setup.ts'],
    },
  ],
};
