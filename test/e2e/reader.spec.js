import { expect, test } from '@playwright/test';

const novelPingFixtureUrls = Object.freeze({
  unresolved: 'https://novelping.com/book/unknown/chapter-2-lamp-fire',
  retryable: 'https://novelping.com/book/return-of-the-war-god/chapter-2-retry'
});

function acceptedNovelPingUrl(testInfo, sourceId) {
  const id = (testInfo.project.name === 'desktop-chromium' ? 100 : 200) + sourceId;
  return `https://novelping.com/book/fixture-source-${id}/chapter-2-lamp-fire`;
}

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

async function seedResolutionIdentity(request, novelId, sourceId) {
  const created = await request.post(`/api/v1/novels/${novelId}/source-identities`, {
    data: {
      bookUrl: `https://www.kujiang.com/book/8${sourceId}`,
      novelTitle: `Fixture source ${sourceId}`,
      novelTitleAliases: [`fixture source ${sourceId}`],
      chapterTitleAliases: { '101': ['lamp fire'] }
    }
  });
  expect(created.ok(), await created.text()).toBeTruthy();
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

async function seedSourcedChapters(request, { title = 'Sourced novel', sourceUrls }) {
  const novel = await request.post('/api/v1/novels', { data: { title } });
  const novelBody = await novel.json();

  for (const [index, sourceUrl] of sourceUrls.entries()) {
    const imported = await request.post(`/api/v1/novels/${novelBody.id}/source-chapters`, {
      data: { sourceUrl, chapterNumber: index + 1 }
    });
    expect(imported.ok(), await imported.text()).toBeTruthy();
  }

  return novelBody.id;
}

async function seedSourcedNovel(request, { title, sourceUrl }) {
  return seedSourcedChapters(request, { title, sourceUrls: [sourceUrl] });
}

async function seedSourceWorkspacePair(request, testInfo, { sourceBookId, title }) {
  const sourceNovelId = await seedSourcedNovel(request, {
    title: `${title} source`,
    sourceUrl: `https://www.kujiang.com/book/${sourceBookId}/${sourceBookId}7`
  });
  const targetNovelId = await seedSourcedNovel(request, {
    title: `${title} target`,
    sourceUrl: `https://www.kujiang.com/book/${sourceBookId}8/${sourceBookId}9`
  });
  return { sourceNovelId, targetNovelId };
}

async function discoverSourceCatalog(request, novelId, bookId) {
  const response = await request.post(`/api/v1/novels/${novelId}/source-catalogs`, {
    data: { bookUrl: `https://www.kujiang.com/book/${bookId}` }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function createSourceImportJob(request, novelId) {
  const catalogs = await request.get(`/api/v1/novels/${novelId}/source-catalogs`);
  const catalog = (await catalogs.json()).items[0];
  const created = await request.post('/api/v1/jobs', {
    data: { novelId, type: 'source_import_catalog', target: { catalogId: catalog.id } }
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  return created.json();
}

async function installWorkspaceActionSettlementObserver(page) {
  await page.addInitScript(() => {
    const observedActions = new Map([
      ['source-catalog-form', 'submit'],
      ['source-resolution-form', 'submit'],
      ['source-identity-form', 'submit'],
      ['source-chapter-import-form', 'submit'],
      ['source-identity-list', 'click'],
      ['import-resolved-source', 'click'],
      ['import-source-catalog', 'click'],
      ['source-import-job-control', 'click']
    ]);
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    window.__inktrailWorkspaceActionSettlements = [];

    EventTarget.prototype.addEventListener = function (type, listener, options) {
      const targetId = this instanceof Element ? this.id : '';
      if (observedActions.get(targetId) !== type || typeof listener !== 'function') {
        return originalAddEventListener.call(this, type, listener, options);
      }

      return originalAddEventListener.call(this, type, function (...args) {
        const result = listener.apply(this, args);
        Promise.resolve(result).then(
          () => window.__inktrailWorkspaceActionSettlements.push(targetId),
          () => window.__inktrailWorkspaceActionSettlements.push(targetId)
        );
        return result;
      }, options);
    };
  });
}

async function switchToFreshSourceWorkspace(page, { targetNovelId }) {
  const catalogsLoaded = page.waitForResponse((response) => (
    response.request().method() === 'GET'
    && new URL(response.url()).pathname === `/api/v1/novels/${targetNovelId}/source-catalogs`
  ));
  await page.locator(`[data-novel-id="${targetNovelId}"]`).click();
  await catalogsLoaded;
  await expect(page).toHaveURL(new RegExp(`\\?novel=${targetNovelId}&chapter=1$`));
  await expect(page.getByLabel('Add Kujiang source')).toBeEnabled();
  await expect(page.locator('#workspace-status')).toHaveText('');
  await expect(page.locator('#source-catalog')).toBeHidden();
  await expect(page.locator('#source-import-job')).toBeHidden();
}

async function holdWorkspaceAction(page, predicate, { errorMessage } = {}) {
  let resolveArrived;
  let releaseResponse;
  let handled = false;
  const arrived = new Promise((resolve) => { resolveArrived = resolve; });
  const released = new Promise((resolve) => { releaseResponse = resolve; });
  const handler = async (route) => {
    if (handled || !predicate(route.request())) return route.continue();
    handled = true;
    if (errorMessage) {
      resolveArrived({ status: 502 });
      await released;
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: errorMessage } })
      });
      return;
    }
    const response = await route.fetch();
    resolveArrived({ status: response.status() });
    await released;
    await route.fulfill({ response });
  };
  await page.route('**/api/v1/**', handler);
  return {
    arrived,
    release: releaseResponse,
    async dispose() {
      await page.unroute('**/api/v1/**', handler);
    }
  };
}

async function openSourceIdentityEditor(page) {
  await page.getByText('Add trusted source', { exact: true }).click();
}

function isWorkspaceRefresh(request, novelId) {
  const url = new URL(request.url());
  return request.method() === 'GET'
    && url.searchParams.get('novelId') === novelId
    && url.pathname === '/api/v1/jobs';
}

async function expectStaleWorkspaceActionToLeaveTargetUntouched(page, heldAction, targetNovelId, actionTargetId) {
  const refreshes = [];
  const observe = (request) => { if (isWorkspaceRefresh(request, targetNovelId)) refreshes.push(request.url()); };
  page.on('request', observe);
  try {
    heldAction.release();
    await page.waitForFunction((targetId) => window.__inktrailWorkspaceActionSettlements.includes(targetId), actionTargetId);
    await expect(page.locator('#workspace-status')).toHaveText('');
    await expect(page.locator('#source-catalog')).toBeHidden();
    await expect(page.locator('#source-import-job')).toBeHidden();
    await expect(page.getByLabel('Add Kujiang source')).toBeEnabled();
    await expect(page.locator('#import-source-catalog')).toBeEnabled();
    await expect(page.locator('#source-import-job-control')).toBeEnabled();
    expect(refreshes).toEqual([]);
  } finally {
    page.off('request', observe);
    await heldAction.dispose();
  }
}

function fixtureChapterUrl(testInfo, sourceId) {
  const projectOffset = testInfo.project.name === 'desktop-chromium' ? 910000 : 920000;
  const externalId = projectOffset + sourceId;
  return `https://www.kujiang.com/book/${externalId}/${externalId}`;
}

function fixtureNextChapterUrl(testInfo, sourceId) {
  const projectOffset = testInfo.project.name === 'desktop-chromium' ? 910000 : 920000;
  const externalId = projectOffset + sourceId;
  return `https://www.kujiang.com/book/${externalId}/${externalId + 1}`;
}

function fixtureControlChapterUrl(testInfo, sourceId, mode) {
  const projectOffset = testInfo.project.name === 'desktop-chromium' ? 910000 : 920000;
  const externalNovelId = projectOffset + sourceId;
  const externalChapterId = `7${externalNovelId}${sourceId}${mode}`;
  return `https://www.kujiang.com/book/${externalNovelId}/${externalChapterId}`;
}

function fixtureCatalogBookId(prefix, identity) {
  const suffixes = {
    completion: '1',
    error: '2',
    'pause-completion': '3',
    'pause-error': '4',
    'resume-completion': '5',
    'resume-error': '6'
  };
  return `${prefix}${suffixes[identity]}`;
}

async function readProgress(request, novelId) {
  const response = await request.get(`/api/v1/novels/${novelId}`);
  return (await response.json()).readingProgress.chapterNumber;
}

test('library creates and displays a novel', async ({ page }) => {
  await page.goto('/');

  await page.getByLabel('Novel title', { exact: true }).fill('A new shelf entry');
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

  await page.getByLabel('Novel title', { exact: true }).focus();
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

test('reader imports a direct Chinese source chapter into an empty novel', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByLabel('Novel title', { exact: true }).fill(`Direct source reader ${testInfo.project.name}`);
  await page.getByRole('button', { name: 'Create novel' }).click();
  await expect(page).toHaveURL(/\?novel=[^&]+&chapter=1$/);
  await page.reload();
  const novelId = new URL(page.url()).searchParams.get('novel');

  await expect(page.getByRole('heading', { name: 'No chapters yet' })).toBeVisible();
  await expect(page.locator('#reader-status')).toHaveText('');
  await expect(page.locator('#source-chapter-import')).toHaveAttribute('open', '');
  await page.getByLabel('Chinese source chapter URL').fill(fixtureChapterUrl(testInfo, 17));
  await page.getByLabel('Reader chapter number').fill('1');
  const imported = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/source-chapters'));
  await page.getByRole('button', { name: 'Import chapter' }).click();

  expect((await imported).postDataJSON()).toEqual({ sourceUrl: fixtureChapterUrl(testInfo, 17), chapterNumber: 1 });
  await expect(page.getByRole('heading', { name: '第2491章 归途 & 灯火' })).toBeVisible();
  await expect(page.locator('#chapter-text')).toContainText('夜色落在城墙上，远处的灯火仍未熄灭。');
  await expect(page).toHaveURL(/\?novel=[^&]+&chapter=1$/);
  await expect(page.locator('#source-chapter-import')).not.toHaveAttribute('open', '');
  await expect(page.getByLabel('Reader chapter number')).toHaveValue('2');
  await expect.poll(async () => readProgress(page.request, novelId)).toBe(1);

  await page.getByText('Import a Chinese source chapter', { exact: true }).click();
  await page.getByLabel('Chinese source chapter URL').fill(fixtureNextChapterUrl(testInfo, 17));
  const secondImport = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/source-chapters'));
  await page.getByRole('button', { name: 'Import chapter' }).click();

  expect((await secondImport).postDataJSON()).toEqual({ sourceUrl: fixtureNextChapterUrl(testInfo, 17), chapterNumber: 2 });
  await expect(page).toHaveURL(/\?novel=[^&]+&chapter=2$/);
  await expect.poll(async () => readProgress(page.request, novelId)).toBe(2);
  await page.locator(`[data-novel-id="${novelId}"]`).click();
  await expect(page).toHaveURL(/\?novel=[^&]+&chapter=2$/);
  await page.getByRole('button', { name: 'Previous chapter' }).first().click();
  await expect(page).toHaveURL(/\?novel=[^&]+&chapter=1$/);
  await expect(page.getByLabel('Reader chapter number')).toHaveValue('');
  await page.screenshot({ path: testInfo.outputPath('direct-source-import.png'), fullPage: true });
});

test('stale direct source import does not navigate a newer workspace', async ({ page }, testInfo) => {
  const sourceBookId = testInfo.project.name === 'desktop-chromium' ? '971' : '972';
  const { sourceNovelId, targetNovelId } = await seedSourceWorkspacePair(page.request, testInfo, {
    sourceBookId,
    title: 'Stale direct source import'
  });
  await installWorkspaceActionSettlementObserver(page);
  await page.goto(`/?novel=${sourceNovelId}&chapter=1`);
  const held = await holdWorkspaceAction(
    page,
    (request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/source-chapters')
  );

  try {
    await page.getByText('Import a Chinese source chapter', { exact: true }).click();
    await page.getByLabel('Chinese source chapter URL').fill(`https://www.kujiang.com/book/${sourceBookId}/${sourceBookId}8`);
    await page.getByLabel('Reader chapter number').fill('2');
    await page.getByRole('button', { name: 'Import chapter' }).click();
    expect((await held.arrived).status).toBe(201);

    await switchToFreshSourceWorkspace(page, { targetNovelId });
    held.release();
    await page.waitForFunction(() => window.__inktrailWorkspaceActionSettlements.includes('source-chapter-import-form'));
    await expect(page).toHaveURL(new RegExp(`\\?novel=${targetNovelId}&chapter=1$`));
    await expect(page.locator('#source-chapter-import-status')).toHaveText('');
    await expect(page.locator('#import-source-chapter')).toBeEnabled();
  } finally {
    held.release();
    await held.dispose();
  }
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

test('workspace queues the current sourced chapter and retains durable status after reload', async ({ page }, testInfo) => {
  const novelId = await seedSourcedChapters(page.request, { sourceUrls: [fixtureChapterUrl(testInfo, 11)] });
  await page.goto(`/?novel=${novelId}&chapter=1`);

  await expect(page.locator('#translation-workspace')).toBeVisible();
  await expect(page.getByLabel('From')).toHaveValue('1');
  await expect(page.getByLabel('To')).toHaveValue('1');
  await page.getByRole('button', { name: 'Queue translation' }).click();
  await expect(page.locator('#workspace-job-status')).toHaveText('Translation is completed after 1 attempt.');

  await page.reload();
  await expect(page.locator('#workspace-job-status')).toHaveText('Translation is completed after 1 attempt.');
});

test('local chapters keep source resolution available and stop source-work polling after navigation', async ({ page }, testInfo) => {
  const novel = await page.request.post('/api/v1/novels', { data: { title: 'Mixed provenance novel' } });
  const novelBody = await novel.json();
  const imported = await page.request.post(`/api/v1/novels/${novelBody.id}/source-chapters`, {
    data: { sourceUrl: fixtureControlChapterUrl(testInfo, 15, 8), chapterNumber: 1 }
  });
  expect(imported.ok(), await imported.text()).toBeTruthy();
  const local = await page.request.post(`/api/v1/novels/${novelBody.id}/chapters`, {
    data: { chapterNumber: 2, title: 'Local chapter', originalText: 'Local chapter text' }
  });
  expect(local.ok(), await local.text()).toBeTruthy();

  await page.goto(`/?novel=${novelBody.id}&chapter=1`);
  await expect(page.locator('#translation-workspace')).toBeVisible();
  await page.getByRole('button', { name: 'Queue translation' }).click();
  await expect(page.getByRole('button', { name: 'Pause translation' })).toBeVisible();

  const workspaceRequests = [];
  page.on('request', (request) => {
    if (request.method() === 'GET' && /\/api\/v1\/(jobs\?novelId=|novels\/[^/]+\/exports$)/.test(new URL(request.url()).pathname + new URL(request.url()).search)) {
      workspaceRequests.push(request.url());
    }
  });
  await page.getByRole('button', { name: 'Next chapter' }).last().click();

  await expect(page.getByRole('heading', { name: 'Local chapter' })).toBeVisible();
  await expect(page.locator('#translation-workspace')).toBeVisible();
  await expect(page.getByLabel('NovelPing chapter URL')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Queue translation' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Create EPUB' })).toBeHidden();
  await page.waitForTimeout(1_200);
  expect(workspaceRequests).toEqual([]);
});

test('reader resolves a NovelPing source and starts its catalog import', async ({ page }, testInfo) => {
  const novelId = await seedNovelWithChapters(page.request, { chapterNumbers: [1], title: 'Resolution reader novel' });
  const sourceId = testInfo.project.name === 'desktop-chromium' ? 101 : 201;
  await seedResolutionIdentity(page.request, novelId, sourceId);
  await page.goto(`/?novel=${novelId}&chapter=1`);

  const resolution = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/source-resolutions'));
  await page.getByLabel('NovelPing chapter URL').fill(acceptedNovelPingUrl(testInfo, 1));
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  expect((await resolution).status()).toBe(201);

  await expect(page.getByLabel('NovelPing chapter URL')).toHaveValue('');
  await expect(page.locator('#source-resolution-status')).toHaveText(`Source resolved: Fixture source ${testInfo.project.name === 'desktop-chromium' ? 101 : 201}, Chapter 2.`);
  await expect(page.getByRole('button', { name: 'Import source chapters' })).toBeVisible();
  await expect(page.locator('#source-resolution-status')).not.toContainText('https://');

  const imported = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/catalog-import'));
  await page.getByRole('button', { name: 'Import source chapters' }).click();
  expect((await imported).status()).toBe(201);
  await expect(page.locator('#source-import-job-status')).toContainText('Source import is');
  await expect(page.locator('#import-resolved-source')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('source-resolution.png'), fullPage: true });
});

test('reader keeps unresolved and retryable NovelPing checks concise and safe', async ({ page }) => {
  const novelId = await seedNovelWithChapters(page.request, { chapterNumbers: [1], title: 'Safe resolution reader novel' });
  await page.goto(`/?novel=${novelId}&chapter=1`);

  await page.getByLabel('NovelPing chapter URL').fill(novelPingFixtureUrls.unresolved);
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(page.locator('#source-resolution-status')).toHaveText('No verified source match was found.');
  await expect(page.getByRole('button', { name: 'Import source chapters' })).toBeHidden();
  await expect(page.locator('#source-resolution-status')).not.toContainText('unknown');

  await page.getByLabel('NovelPing chapter URL').fill(novelPingFixtureUrls.retryable);
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(page.locator('#source-resolution-status')).toHaveText('This source check is temporarily unavailable. You can try again.');
  await expect(page.locator('#source-resolution-status')).toHaveAttribute('role', 'alert');
  await expect(page.getByLabel('NovelPing chapter URL')).toHaveValue('');
});

test('reader creates, lists, validates, and removes trusted source identities', async ({ page }, testInfo) => {
  const novelId = await seedNovelWithChapters(page.request, { chapterNumbers: [1], title: 'Trusted identity reader novel' });
  const bookId = testInfo.project.name === 'desktop-chromium' ? 301 : 401;
  const invalidBookId = bookId + 1;
  const bookUrl = `https://www.kujiang.com/book/${bookId}`;
  await page.goto(`/?novel=${novelId}&chapter=1`);
  await openSourceIdentityEditor(page);

  await page.getByLabel('Canonical book link').fill(bookUrl);
  await page.getByLabel('Source novel title', { exact: true }).fill('Reader source title');
  await page.getByLabel('Source novel title aliases').fill('reader source, source reader');
  await page.getByLabel('Author', { exact: true }).fill('Reader author');
  await page.getByLabel('Author aliases').fill('reader, author');
  await page.getByLabel('Chapter title aliases').fill('{"101":["Lamp fire"]}');
  const created = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === `/api/v1/novels/${novelId}/source-identities`);
  await page.getByRole('button', { name: 'Save trusted source' }).click();
  expect((await created).postDataJSON()).toEqual({
    bookUrl,
    novelTitle: 'Reader source title',
    novelTitleAliases: ['reader source', 'source reader'],
    author: 'Reader author',
    authorAliases: ['reader', 'author'],
    chapterTitleAliases: { '101': ['Lamp fire'] }
  });
  await expect(page.getByRole('link', { name: bookUrl })).toBeVisible();
  await expect(page.getByText('Reader source title')).toBeVisible();
  await expect(page.getByText('Reader author')).toBeVisible();

  let invalidRequests = 0;
  const observeInvalid = (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/v1/novels/${novelId}/source-identities`) invalidRequests += 1;
  };
  page.on('request', observeInvalid);
  try {
    await openSourceIdentityEditor(page);
    await page.getByLabel('Canonical book link').fill(`https://www.kujiang.com/book/${invalidBookId}`);
    await page.getByLabel('Source novel title', { exact: true }).fill('Invalid aliases');
    await page.getByLabel('Chapter title aliases').fill('{');
    await page.getByRole('button', { name: 'Save trusted source' }).click();
    await expect(page.locator('#source-identities-status')).toHaveText('Chapter title aliases must be valid JSON.');
    expect(invalidRequests).toBe(0);
  } finally {
    page.off('request', observeInvalid);
  }

  const identityId = await page.locator('[data-source-identity-id]').getAttribute('data-source-identity-id');
  let declinedDeletes = 0;
  const observeDeclinedDelete = (request) => {
    if (request.method() === 'DELETE' && new URL(request.url()).pathname === `/api/v1/novels/${novelId}/source-identities/${identityId}`) declinedDeletes += 1;
  };
  page.on('request', observeDeclinedDelete);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Remove trusted source identity Reader source title' }).click();
  await expect(page.getByRole('link', { name: bookUrl })).toBeVisible();
  expect(declinedDeletes).toBe(0);
  page.off('request', observeDeclinedDelete);
  const removed = page.waitForResponse((response) => response.request().method() === 'DELETE' && new URL(response.url()).pathname === `/api/v1/novels/${novelId}/source-identities/${identityId}`);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Remove trusted source identity Reader source title' }).click();
  expect((await removed).status()).toBe(204);
  await expect(page.getByRole('link', { name: bookUrl })).toBeHidden();
});

test('reader applies trusted source identity browser validation before sending', async ({ page }) => {
  const novelId = await seedNovelWithChapters(page.request, { chapterNumbers: [1], title: 'Validated identity reader novel' });
  let identityRequests = 0;
  const observeIdentityRequest = (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/v1/novels/${novelId}/source-identities`) identityRequests += 1;
  };
  page.on('request', observeIdentityRequest);
  try {
    await page.goto(`/?novel=${novelId}&chapter=1`);
    await openSourceIdentityEditor(page);
    await page.getByRole('button', { name: 'Save trusted source' }).click();
    await expect(page.getByLabel('Canonical book link')).toBeFocused();
    await page.getByLabel('Canonical book link').fill('https://www.kujiang.com/book/306');
    await page.getByRole('button', { name: 'Save trusted source' }).click();
    await expect(page.getByLabel('Source novel title', { exact: true })).toBeFocused();
    await page.getByLabel('Source novel title', { exact: true }).fill('Validated source');
    await page.getByLabel('Canonical book link').fill('not a URL');
    await page.getByRole('button', { name: 'Save trusted source' }).click();
    await expect(page.getByLabel('Canonical book link')).toBeFocused();
    expect(identityRequests).toBe(0);
  } finally {
    page.off('request', observeIdentityRequest);
  }
});

test('stale source identity refresh cannot overwrite a newer list', async ({ page }, testInfo) => {
  const novelId = await seedNovelWithChapters(page.request, { chapterNumbers: [1], title: 'Identity refresh reader novel' });
  const bookUrl = `https://www.kujiang.com/book/${testInfo.project.name === 'desktop-chromium' ? 305 : 405}`;
  const held = await holdWorkspaceAction(
    page,
    (request) => request.method() === 'GET' && new URL(request.url()).pathname === `/api/v1/novels/${novelId}/source-identities`
  );
  try {
    await page.goto(`/?novel=${novelId}&chapter=1`);
    expect((await held.arrived).status).toBe(200);
    await openSourceIdentityEditor(page);
    await page.getByLabel('Canonical book link').fill(bookUrl);
    await page.getByLabel('Source novel title', { exact: true }).fill('Fresh source identity');
    await page.getByRole('button', { name: 'Save trusted source' }).click();
    await expect(page.getByRole('link', { name: bookUrl })).toBeVisible();
    const staleResponse = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/v1/novels/${novelId}/source-identities`);
    held.release();
    expect((await staleResponse).status()).toBe(200);
    await expect(page.getByRole('link', { name: bookUrl })).toBeVisible();
  } finally {
    await held.dispose();
  }
});

for (const action of ['create', 'remove']) {
  test(`stale trusted source identity ${action} cannot update a newer workspace`, async ({ page }, testInfo) => {
    const sourceNovelId = await seedNovelWithChapters(page.request, { chapterNumbers: [1], title: `Stale identity ${action} source` });
    const targetNovelId = await seedNovelWithChapters(page.request, { chapterNumbers: [1], title: `Stale identity ${action} target` });
    const sourceId = testInfo.project.name === 'desktop-chromium' ? 303 : 403;
    if (action === 'remove') await seedResolutionIdentity(page.request, sourceNovelId, sourceId);
    await installWorkspaceActionSettlementObserver(page);
    await page.goto(`/?novel=${sourceNovelId}&chapter=1`);
    if (action === 'create') await openSourceIdentityEditor(page);
    if (action === 'remove') await expect(page.getByRole('button', { name: /Remove trusted source identity/ })).toBeVisible();
    const held = await holdWorkspaceAction(
      page,
      (request) => request.method() === (action === 'create' ? 'POST' : 'DELETE') && new URL(request.url()).pathname.includes('/source-identities')
    );

    if (action === 'create') {
      await page.getByLabel('Canonical book link').fill(`https://www.kujiang.com/book/${sourceId + 1}`);
      await page.getByLabel('Source novel title', { exact: true }).fill('Stale identity');
      await page.getByRole('button', { name: 'Save trusted source' }).click();
    } else {
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: /Remove trusted source identity/ }).click();
    }
    expect((await held.arrived).status).toBe(action === 'create' ? 201 : 204);
    await page.locator(`[data-novel-id="${targetNovelId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`\\?novel=${targetNovelId}&chapter=1$`));
    await expect(page.locator('#source-identity-list')).toBeEmpty();

    try {
      held.release();
      await page.waitForFunction((targetId) => window.__inktrailWorkspaceActionSettlements.includes(targetId), action === 'create' ? 'source-identity-form' : 'source-identity-list');
      await expect(page.locator('#source-identity-list')).toBeEmpty();
      await expect(page.getByText('Add trusted source', { exact: true })).toBeVisible();
    } finally {
      await held.dispose();
    }
  });
}

for (const [name, errorMessage] of [
  ['completion', undefined],
  ['retryable error', 'Fixture source resolution request failed']
]) {
  test(`stale NovelPing resolution ${name} cannot update a newer workspace`, async ({ page }, testInfo) => {
    const sourceNovelId = await seedNovelWithChapters(page.request, { chapterNumbers: [1], title: `Stale resolution ${name} source` });
    const targetNovelId = await seedNovelWithChapters(page.request, { chapterNumbers: [1], title: `Stale resolution ${name} target` });
    await installWorkspaceActionSettlementObserver(page);
    await page.goto(`/?novel=${sourceNovelId}&chapter=1`);
    const held = await holdWorkspaceAction(
      page,
      (request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/source-resolutions'),
      { errorMessage }
    );

    await page.getByLabel('NovelPing chapter URL').fill(acceptedNovelPingUrl(testInfo, errorMessage ? 3 : 2));
    await page.getByRole('button', { name: 'Resolve', exact: true }).click();
    expect((await held.arrived).status).toBe(errorMessage ? 502 : 201);
    await page.locator(`[data-novel-id="${targetNovelId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`\\?novel=${targetNovelId}&chapter=1$`));
    await expect(page.getByLabel('NovelPing chapter URL')).toBeVisible();

    try {
      held.release();
      await page.waitForFunction(() => window.__inktrailWorkspaceActionSettlements.includes('source-resolution-form'));
      await expect(page.locator('#source-resolution-status')).toHaveText('');
      await expect(page.getByRole('button', { name: 'Import source chapters' })).toBeHidden();
      await expect(page.getByLabel('NovelPing chapter URL')).toBeEnabled();
    } finally {
      await held.dispose();
    }
  });
}

test('stale resolved-source import cannot update a newer workspace', async ({ page }) => {
  const sourceNovelId = await seedNovelWithChapters(page.request, { chapterNumbers: [1], title: 'Stale resolved import source' });
  const targetNovelId = await seedNovelWithChapters(page.request, { chapterNumbers: [1], title: 'Stale resolved import target' });
  await installWorkspaceActionSettlementObserver(page);
  const attemptId = 'fixture-resolution';
  const collectionPath = `**/api/v1/novels/${sourceNovelId}/source-resolutions`;
  const detailPath = `${collectionPath}/${attemptId}`;
  const importPath = `${detailPath}/catalog-import`;
  await page.route(collectionPath, async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [{ id: attemptId, state: 'resolved', acceptedSource: { catalogId: 'fixture-catalog' } }] }) });
  });
  await page.route(detailPath, async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: attemptId, state: 'resolved', selectedCandidateId: 'fixture-candidate', acceptedSource: { catalogId: 'fixture-catalog' }, evidence: { chapterNumber: 2 }, candidates: [{ id: 'fixture-candidate', metadata: { novelTitle: 'Fixture source' } }], importEligible: true }) });
  });
  let releaseImport;
  const importReleased = new Promise((resolve) => { releaseImport = resolve; });
  let resolveImportArrival;
  const importArrived = new Promise((resolve) => { resolveImportArrival = resolve; });
  await page.route(importPath, async (route) => {
    resolveImportArrival();
    await importReleased;
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'fixture-job' }) });
  });
  await page.goto(`/?novel=${sourceNovelId}&chapter=1`);
  await expect(page.getByRole('button', { name: 'Import source chapters' })).toBeVisible();

  await page.getByRole('button', { name: 'Import source chapters' }).click();
  await importArrived;
  await page.locator(`[data-novel-id="${targetNovelId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`\\?novel=${targetNovelId}&chapter=1$`));

  try {
    releaseImport();
    await page.waitForFunction(() => window.__inktrailWorkspaceActionSettlements.includes('import-resolved-source'));
    await expect(page.locator('#source-resolution-status')).toHaveText('');
    await expect(page.getByRole('button', { name: 'Import source chapters' })).toBeHidden();
  } finally {
    await page.unroute(collectionPath);
    await page.unroute(detailPath);
    await page.unroute(importPath);
  }
});

test('stale source-resolution list refresh cannot update a newer workspace', async ({ page }) => {
  const sourceNovelId = await seedNovelWithChapters(page.request, { chapterNumbers: [1], title: 'Stale resolution list source' });
  const targetNovelId = await seedNovelWithChapters(page.request, { chapterNumbers: [1], title: 'Stale resolution list target' });
  const held = await holdWorkspaceAction(
    page,
    (request) => request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/source-resolutions')
  );

  await page.goto(`/?novel=${sourceNovelId}&chapter=1`);
  expect((await held.arrived).status).toBe(200);
  await page.locator(`[data-novel-id="${targetNovelId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`\\?novel=${targetNovelId}&chapter=1$`));

  try {
    held.release();
    await expect(page.locator('#source-resolution-status')).toHaveText('');
    await expect(page.getByRole('button', { name: 'Import source chapters' })).toBeHidden();
  } finally {
    await held.dispose();
  }
});

test('workspace submits a huge chapter range without expanding it in the browser', async ({ page }, testInfo) => {
  const novelId = await seedSourcedChapters(page.request, { sourceUrls: [fixtureChapterUrl(testInfo, 16)] });
  await page.goto(`/?novel=${novelId}&chapter=1`);
  await page.getByLabel('From').fill('1');
  await page.getByLabel('To').fill('100000000');

  const queued = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/jobs');
  await page.getByRole('button', { name: 'Queue translation' }).click();
  const request = await queued;
  const body = request.postDataJSON();

  expect(body).toEqual({
    novelId,
    type: 'translate_chapters',
    target: { startChapterNumber: 1, endChapterNumber: 100000000 }
  });
  expect(request.postData()?.length).toBeLessThan(200);
  await expect(page.locator('#workspace-status')).toHaveText('translation target must contain only imported source chapters');
});

test('workspace pauses and resumes a durable translation', async ({ page }, testInfo) => {
  const novelId = await seedSourcedChapters(page.request, {
    title: 'Paused workspace novel',
    sourceUrls: [fixtureControlChapterUrl(testInfo, 13, 8)]
  });
  await page.goto(`/?novel=${novelId}&chapter=1`);

  await page.getByRole('button', { name: 'Queue translation' }).click();
  await expect(page.getByRole('button', { name: 'Pause translation' })).toBeVisible();
  await page.getByRole('button', { name: 'Pause translation' }).click();
  await expect(page.getByRole('button', { name: 'Resume translation' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('button', { name: 'Resume translation' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume translation' }).click();
  await expect(page.locator('#workspace-job-status')).toHaveText(/Translation is (queued|running|completed) after \d+ attempts?\./);
});

test('workspace reports the fourth retry failure as paused', async ({ page }, testInfo) => {
  const novelId = await seedSourcedChapters(page.request, {
    title: 'Unavailable workspace novel',
    sourceUrls: [fixtureControlChapterUrl(testInfo, 14, 9)]
  });
  await page.goto(`/?novel=${novelId}&chapter=1`);

  await page.getByRole('button', { name: 'Queue translation' }).click();
  await expect(page.locator('#workspace-job-status')).toHaveText('Translation is paused after 4 attempts.', { timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Resume translation' })).toBeVisible();
});

test('workspace downloads an available EPUB while another chapter translates', async ({ page }, testInfo) => {
  const novelId = await seedSourcedChapters(page.request, {
    title: 'Concurrent workspace novel',
    sourceUrls: [fixtureChapterUrl(testInfo, 12), fixtureControlChapterUrl(testInfo, 12, 8)]
  });
  const directTranslation = await page.request.post(`/api/v1/novels/${novelId}/chapters/1/translations`);
  expect(directTranslation.ok(), await directTranslation.text()).toBeTruthy();
  await page.goto(`/?novel=${novelId}&chapter=1`);

  await page.getByLabel('From').fill('2');
  await page.getByLabel('To').fill('2');
  await page.getByRole('button', { name: 'Queue translation' }).click();
  await expect(page.getByRole('button', { name: 'Pause translation' })).toBeVisible();

  await page.getByLabel('From').fill('1');
  await page.getByLabel('To').fill('1');
  await page.getByRole('button', { name: 'Create EPUB' }).click();
  await expect(page.locator('#workspace-job-status')).toHaveText(/Translation is (queued|running|completed) after 1 attempt\./);
  const downloadLink = page.getByRole('link', { name: 'Download EPUB' });
  await expect(downloadLink).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    downloadLink.click()
  ]);
  expect(download.suggestedFilename()).toMatch(/\.epub$/);
  await expect(page.locator('#workspace-job-status')).toHaveText('Translation is completed after 1 attempt.');
});

test('workspace discovers and controls a source catalog without interrupting reader navigation', async ({ page }, testInfo) => {
  const bookId = testInfo.project.name === 'desktop-chromium' ? '91' : '92';
  const chapterId = `${testInfo.workerIndex + 1}911`;
  const novel = await page.request.post('/api/v1/novels', { data: { title: 'Catalog workspace novel' } });
  const novelBody = await novel.json();
  const sourced = await page.request.post(`/api/v1/novels/${novelBody.id}/source-chapters`, {
    data: { sourceUrl: `https://www.kujiang.com/book/${bookId}/${chapterId}`, chapterNumber: 10 }
  });
  expect(sourced.ok(), await sourced.text()).toBeTruthy();
  const local = await page.request.post(`/api/v1/novels/${novelBody.id}/chapters`, {
    data: { chapterNumber: 11, title: 'Navigation remains available', originalText: 'Local reader text' }
  });
  expect(local.ok(), await local.text()).toBeTruthy();
  await page.goto(`/?novel=${novelBody.id}&chapter=10`);

  await expect(page.getByLabel('Add Kujiang source')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import source chapters' })).toBeHidden();
  await expect(page.request.get(`/api/v1/jobs?novelId=${novelBody.id}`).then((response) => response.json())).resolves.toEqual({ items: [] });

  const discovery = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/source-catalogs'));
  await page.getByLabel('Add Kujiang source').fill(`https://www.kujiang.com/book/${bookId}`);
  await page.getByRole('button', { name: 'Discover source' }).click();
  expect((await discovery).status()).toBe(201);
  await expect(page.locator('#source-catalog-status')).toHaveText('Kujiang catalog ready: 1 source chapters, 0 imported.');
  await expect(page.locator('#workspace-status')).toHaveText('Source catalog saved. Import starts only when you choose it.');
  await expect(page.request.get(`/api/v1/jobs?novelId=${novelBody.id}`).then((response) => response.json())).resolves.toEqual({ items: [] });

  const created = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/jobs');
  await page.getByRole('button', { name: 'Import source chapters' }).click();
  expect((await created).postDataJSON()).toMatchObject({ novelId: novelBody.id, type: 'source_import_catalog' });
  await expect(page.locator('#source-import-job-status')).toContainText('Source import is running after 1 attempt. 0 of 1 imported. Current source chapter 1.');
  await expect(page.getByRole('button', { name: 'Pause source import' })).toBeVisible();

  await page.getByRole('button', { name: 'Pause source import' }).click();
  await expect(page.getByRole('button', { name: 'Resume source import' })).toBeVisible();
  await expect(page.locator('#source-import-job-status')).toContainText('Source import is paused');
  await page.getByRole('button', { name: 'Resume source import' }).click();
  await expect(page.getByRole('button', { name: 'Pause source import' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('source-workspace.png'), fullPage: true });

  await page.getByRole('button', { name: 'Next chapter' }).last().click();
  await expect(page.getByRole('heading', { name: 'Navigation remains available' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`\\?novel=${novelBody.id}&chapter=11$`));
  await expect(page.locator('#translation-workspace')).toBeVisible();
  await expect(page.getByLabel('NovelPing chapter URL')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Queue translation' })).toBeHidden();
});

for (const [name, sourceBookPrefix, errorMessage] of [
  ['completion', ['93', '94'], undefined],
  ['error', ['95', '96'], 'Fixture catalog fetch failure']
]) {
  test(`stale source discovery ${name} cannot update a newer sourced workspace`, async ({ page }, testInfo) => {
    const sourceBookId = fixtureCatalogBookId(sourceBookPrefix[testInfo.project.name === 'desktop-chromium' ? 0 : 1], name);
    const { sourceNovelId, targetNovelId } = await seedSourceWorkspacePair(page.request, testInfo, {
      sourceBookId,
      title: `Stale source discovery ${name}`
    });
    await installWorkspaceActionSettlementObserver(page);
    await page.goto(`/?novel=${sourceNovelId}&chapter=1`);
    await expect(page.getByLabel('Add Kujiang source')).toBeVisible();
    const held = await holdWorkspaceAction(
      page,
      (request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/source-catalogs'),
      { errorMessage }
    );

    await page.getByLabel('Add Kujiang source').fill(`https://www.kujiang.com/book/${sourceBookId}`);
    await page.getByRole('button', { name: 'Discover source' }).click();
    expect((await held.arrived).status).toBe(errorMessage ? 502 : 201);
    await switchToFreshSourceWorkspace(page, { targetNovelId });
    await expectStaleWorkspaceActionToLeaveTargetUntouched(page, held, targetNovelId, 'source-catalog-form');
  });
}

for (const [name, errorMessage] of [
  ['completion', undefined],
  ['error', 'Fixture source import request failed']
]) {
  test(`stale source import ${name} cannot update a newer sourced workspace`, async ({ page }, testInfo) => {
    const sourceBookId = fixtureCatalogBookId(testInfo.project.name === 'desktop-chromium' ? '91' : '92', name);
    const { sourceNovelId, targetNovelId } = await seedSourceWorkspacePair(page.request, testInfo, {
      sourceBookId,
      title: `Stale source import ${name}`
    });
    await installWorkspaceActionSettlementObserver(page);
    await discoverSourceCatalog(page.request, sourceNovelId, sourceBookId);
    await page.goto(`/?novel=${sourceNovelId}&chapter=1`);
    await expect(page.getByRole('button', { name: 'Import source chapters' })).toBeVisible();
    const held = await holdWorkspaceAction(
      page,
      (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/jobs',
      { errorMessage }
    );

    await page.getByRole('button', { name: 'Import source chapters' }).click();
    expect((await held.arrived).status).toBe(errorMessage ? 502 : 201);
    await switchToFreshSourceWorkspace(page, { targetNovelId });
    await expectStaleWorkspaceActionToLeaveTargetUntouched(page, held, targetNovelId, 'import-source-catalog');
  });
}

for (const action of ['pause', 'resume']) {
  for (const [name, errorMessage] of [
    ['completion', undefined],
    ['error', `Fixture source import ${action} failed`]
  ]) {
    test(`stale source import ${action} ${name} cannot update a newer sourced workspace`, async ({ page }, testInfo) => {
      const sourceBookId = fixtureCatalogBookId(testInfo.project.name === 'desktop-chromium' ? '91' : '92', `${action}-${name}`);
      const { sourceNovelId, targetNovelId } = await seedSourceWorkspacePair(page.request, testInfo, {
        sourceBookId,
        title: `Stale source import ${action} ${name}`
      });
      await installWorkspaceActionSettlementObserver(page);
      await discoverSourceCatalog(page.request, sourceNovelId, sourceBookId);
      const job = await createSourceImportJob(page.request, sourceNovelId);
      if (action === 'resume') {
        const paused = await page.request.post(`/api/v1/jobs/${job.id}/pause?novelId=${sourceNovelId}`);
        expect(paused.ok(), await paused.text()).toBeTruthy();
      }
      await page.goto(`/?novel=${sourceNovelId}&chapter=1`);
      const controlName = action === 'pause' ? 'Pause source import' : 'Resume source import';
      await expect(page.getByRole('button', { name: controlName })).toBeVisible();
      const held = await holdWorkspaceAction(
        page,
        (request) => request.method() === 'POST' && new URL(request.url()).pathname === `/api/v1/jobs/${job.id}/${action}`,
        { errorMessage }
      );

      await page.getByRole('button', { name: controlName }).click();
      expect((await held.arrived).status).toBe(errorMessage ? 502 : 200);
      await switchToFreshSourceWorkspace(page, { targetNovelId });
      await expectStaleWorkspaceActionToLeaveTargetUntouched(page, held, targetNovelId, 'source-import-job-control');
    });
  }
}
