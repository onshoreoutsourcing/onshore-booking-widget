import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Ensure each test file runs with a fresh module cache so global
    // singletons (the tenant-config cache, the rate-limit table client,
    // etc.) start from a clean slate. The corresponding `_reset…ForTests`
    // helpers exported from each module are the official escape hatches;
    // this provides a backstop.
    isolate: true,
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts'],
      exclude: ['src/widget/**', 'src/functions/**'],
      reporter: ['text', 'html'],
    },
  },
});
