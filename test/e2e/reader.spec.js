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

async function seedTranslatedSourceChapter(request, { title = 'Translated novel', sourceUrl } = {}) {
  const novel = await request.post('/api/v1/novels', { data: { title } });
  const novelBody = await novel.json();
  const imported = await request.post(`/api/v1/novels/${novelBody.id}/source-chapters`, {
    data: { sourceUrl, chapterNumber: 1 }
  });
  expect(imported.ok(), await imported.text()).toBeTruthy();
  const translation = await request.post(`/api/v1/novels/${novelBody.id}/chapters/1/translations`);
  const translationBody = await translation.json();
  expect(translation.ok(), JSON.stringify(translationBody)).toBeTruthy();
  return { novelId: novelBody.id, translation: translationBody };
}

function fixtureChapterUrl(testInfo, sourceId) {
  const projectOffset = testInfo.project.name === 'desktop-chromium' ? 910000 : 920000;
  const externalId = projectOffset + sourceId;
  return `https://www.kujiang.com/book/${externalId}/${externalId}`;
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

test('reader retains Chinese text and explains when English is unavailable', async ({ page }) => {
  const novelId = await seedNovelWithChapters(page.request, { chapterNumbers: [1] });
  await page.goto(`/?novel=${novelId}&chapter=1`);

  await expect(page.locator('#chapter-text')).toContainText('Chapter 1 text');
  await expect(page.getByText('English translation unavailable. Showing the original Chinese.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Report a translation issue' })).toBeHidden();
});

test('reader uses the latest English revision', async ({ page }, testInfo) => {
  const { novelId, translation } = await seedTranslatedSourceChapter(page.request, { sourceUrl: fixtureChapterUrl(testInfo, 1) });
  const report = await page.request.post(`/api/v1/novels/${novelId}/chapters/1/feedback`, {
    data: {
      translationRevisionId: translation.revision.id,
      selectedText: 'Fixture translation 1.',
      sourceContext: 'Source context',
      translatedContext: 'Fixture translation 1.',
      proposedCorrection: 'Verified correction.',
      reason: 'Meaning is clearer.'
    }
  });
  const reportBody = await report.json();
  await page.request.patch(`/api/v1/novels/${novelId}/feedback/${reportBody.id}`, {
    data: {
      status: 'approved',
      memory: { sourceTerm: 'term', preferredRendering: 'term', semanticScope: 'scope', evidence: 'evidence', confidence: 1 }
    }
  });
  await page.goto(`/?novel=${novelId}&chapter=1`);

  await expect(page.locator('#chapter-text')).toContainText('Verified correction.');
  await expect(page.locator('#chapter-text')).toContainText('Fixture translation 2.');
  await expect(page.getByText('English translation unavailable. Showing the original Chinese.')).toBeHidden();
});

test('reader submits a translation issue with selected text and context', async ({ page }, testInfo) => {
  const { novelId } = await seedTranslatedSourceChapter(page.request, { sourceUrl: fixtureChapterUrl(testInfo, 2) });
  await page.goto(`/?novel=${novelId}&chapter=1`);
  await expect(page.locator('#feedback-status')).toHaveAttribute('role', 'status');
  await page.getByRole('button', { name: 'Report a translation issue' }).click();
  await expect(page.getByLabel('Selected passage')).toHaveValue('Fixture translation 1.\n\nFixture translation 2.\n\nFixture translation 3.\n\nFixture translation 4.');
  await page.getByLabel('Suggested correction').fill('The city walls were dark.');
  await page.getByLabel('What needs attention?').fill('The first sentence changes the scene.');
  const response = page.waitForResponse((item) => item.url().endsWith('/feedback') && item.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send report' }).click();

  expect((await response).status()).toBe(201);
  await expect(page.locator('#feedback-status')).toContainText('Your translation issue report was sent. Thank you.');
  await expect(page.locator('#feedback-status')).toHaveAttribute('role', 'status');
  await expect(page.locator('#feedback-form')).toBeHidden();

  await page.evaluate((id) => {
    window.history.pushState({}, '', `/?novel=${id}&chapter=2`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, novelId);
  await expect(page.getByRole('heading', { name: 'Chapter unavailable' })).toBeVisible();
  await expect(page.locator('#feedback-status')).toBeEmpty();
});

test('reader keeps feedback errors visible and focused', async ({ page }, testInfo) => {
  const { novelId } = await seedTranslatedSourceChapter(page.request, { sourceUrl: fixtureChapterUrl(testInfo, 3) });
  await page.goto(`/?novel=${novelId}&chapter=1`);
  await page.getByRole('button', { name: 'Report a translation issue' }).click();
  await page.getByLabel('Suggested correction').fill('A correction');
  await page.getByLabel('What needs attention?').fill('A reason');
  await page.getByLabel('Selected passage').fill('');
  await page.getByRole('button', { name: 'Send report' }).click();

  await expect(page.locator('#feedback-status')).toHaveText('Selected passage is required.');
  await expect(page.getByLabel('Selected passage')).toBeFocused();
  await expect(page.getByLabel('Selected passage')).toHaveAttribute('aria-invalid', 'true');

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('#feedback-status')).toBeEmpty();
  await expect(page.getByRole('button', { name: 'Report a translation issue' })).toBeFocused();
});
