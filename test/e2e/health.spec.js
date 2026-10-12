import { expect, test } from '@playwright/test';

test('health route returns an ok status', async ({ page }) => {
  const response = await page.goto('/api/v1/health');

  expect(response).not.toBeNull();
  expect(response.status()).toBe(200);
  await expect(page.locator('body')).toHaveText('{"status":"ok"}');
});
