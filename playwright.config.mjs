import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    expect: { timeout: 5000 },
    browserName: 'chromium',
    headless: true,
  },
  webServer: {
    command: 'node scripts/server.mjs',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: 'chrome', use: { browserName: 'chromium' } }],
});
