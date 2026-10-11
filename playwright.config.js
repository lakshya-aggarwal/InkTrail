import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  use: { baseURL: 'http://127.0.0.1:4177' },
  webServer: {
    command: 'PORT=4177 INKTRAIL_DATA_DIR=.test-data node src/server.js',
    url: 'http://127.0.0.1:4177/api/v1/health',
    reuseExistingServer: false
  }
});
