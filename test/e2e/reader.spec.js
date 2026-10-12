import { expect, test } from '@playwright/test';

async function seedNovelWithChapters(request, { chapterNumbers, title = 'Seeded novel' }) {
  const novel = await request.post('/api/v1/novels', { data: { title } });
  const novelBody = await novel.json();

  for (const chapterNumber of chapterNumbers) {
    await request.post(`/api/v1/novels/${novelBody.id}/chapters`, {
      data: {
        chapterNumber,
        title: `Chapter ${chapterNumber} title`,
        originalText: `Chapter ${chapterNumber} text\n\n`.repeat(120)
      }
    });
  }

  return novelBody.id;
}

async function readProgress(request, novelId) {
  const response = await request.get(`/api/v1/novels/${novelId}`);
  return (await response.json()).readingProgress.chapterNumber;
}

test('library creates and displays a novel', async ({ page }) => {
  await page.goto('/');

  await page.getByLabel('Novel title').fill('A new shelf entry');
  await page.getByRole('button', { name: 'Create novel' }).click();

  await expect(page.getByRole('button', { name: 'A new shelf entry' }).last()).toBeVisible();
});

test('reader navigation updates chapter, URL, scroll position, focus, and reading progress', async ({ page }) => {
  const novelId = await seedNovelWithChapters(page.request, { chapterNumbers: [1, 2] });
  await page.goto(`/?novel=${novelId}&chapter=1`);

  await expect(page.getByRole('heading', { name: 'Chapter 1 title' })).toBeVisible();
  await page.getByRole('button', { name: 'Next chapter' }).last().click();

  await expect(page).toHaveURL(new RegExp(`\\?novel=${novelId}&chapter=2$`));
  await expect(page.getByRole('heading', { name: 'Chapter 2 title' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('chapter-title');
  await expect.poll(() => readProgress(page.request, novelId)).toBe(2);
});

test('arrow keys do not navigate while the novel title input has focus', async ({ page }) => {
  const novelId = await seedNovelWithChapters(page.request, { chapterNumbers: [1, 2] });
  await page.goto(`/?novel=${novelId}&chapter=1`);
  const initialUrl = page.url();

  await page.getByLabel('Novel title').focus();
  await page.keyboard.press('ArrowRight');

  await expect(page).toHaveURL(initialUrl);
});
