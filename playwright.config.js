import { defineConfig } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4277);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './test/e2e',
  use: { baseURL },
  projects: [
    {
      name: 'desktop-chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 1440, height: 1000 }
      }
    },
    {
      name: 'mobile-chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        isMobile: true
      }
    }
  ],
  webServer: {
    command: `PORT=${port} node scripts/source-fixture-server.js`,
    url: `${baseURL}/api/v1/health`,
    reuseExistingServer: false
  }
});
