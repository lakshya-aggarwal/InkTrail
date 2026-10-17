const library = document.querySelector('#library');
const novelForm = document.querySelector('#novel-form');
const novelTitle = document.querySelector('#novel-title');
const libraryStatus = document.querySelector('#library-status');
const novelList = document.querySelector('#novel-list');
const reader = document.querySelector('#reader');
const chapterNumber = document.querySelector('#chapter-number');
const chapterTitle = document.querySelector('#chapter-title');
const chapterText = document.querySelector('#chapter-text');
const translationStatus = document.querySelector('#translation-status');
const reportTranslation = document.querySelector('#report-translation');
const feedbackForm = document.querySelector('#feedback-form');
const feedbackSelectedText = document.querySelector('#feedback-selected-text');
const feedbackCorrection = document.querySelector('#feedback-correction');
const feedbackReason = document.querySelector('#feedback-reason');
const feedbackStatus = document.querySelector('#feedback-status');
const readerStatus = document.querySelector('#reader-status');
const workspace = document.querySelector('#translation-workspace');
const workspaceForm = document.querySelector('#workspace-form');
const workspaceFrom = document.querySelector('#workspace-from');
const workspaceTo = document.querySelector('#workspace-to');
const queueTranslation = document.querySelector('#queue-translation');
const createEpub = document.querySelector('#create-epub');
const workspaceStatus = document.querySelector('#workspace-status');
const workspaceJob = document.querySelector('#workspace-job');
const workspaceJobStatus = document.querySelector('#workspace-job-status');
const workspaceJobControl = document.querySelector('#workspace-job-control');
const workspaceExport = document.querySelector('#workspace-export');
const workspaceExportStatus = document.querySelector('#workspace-export-status');
const workspaceExportDownload = document.querySelector('#workspace-export-download');
const sourceCatalogForm = document.querySelector('#source-catalog-form');
const sourceBookUrl = document.querySelector('#source-book-url');
const discoverSourceCatalog = document.querySelector('#discover-source-catalog');
const sourceCatalog = document.querySelector('#source-catalog');
const sourceCatalogStatus = document.querySelector('#source-catalog-status');
const importSourceCatalog = document.querySelector('#import-source-catalog');
const sourceImportJob = document.querySelector('#source-import-job');
const sourceImportJobStatus = document.querySelector('#source-import-job-status');
const sourceImportJobControl = document.querySelector('#source-import-job-control');

let novels = [];
let currentChapter = null;
let workspacePoll = null;
let workspaceToken = 0;
let workspaceCatalogProgress = null;

const activeStates = new Set(['queued', 'running', 'retrying']);

function readerState() {
  const query = new URLSearchParams(window.location.search);
  const novelId = query.get('novel');
  const chapter = Number(query.get('chapter'));
  return novelId && Number.isSafeInteger(chapter) && chapter > 0 ? { novelId, chapter } : null;
}

function setReaderState(novelId, chapter) { window.history.pushState({}, '', `/?${new URLSearchParams({ novel: novelId, chapter: String(chapter) })}`); }

async function request(path, options) {
  const response = await fetch(path, options);
  if (response.ok) return response.json();
  const body = await response.json().catch(() => null);
  throw new Error(body?.error?.message || 'The library could not be updated.');
}

function stopWorkspacePolling() {
  if (workspacePoll !== null) window.clearTimeout(workspacePoll);
  workspacePoll = null;
}

function setWorkspaceStatus(message, { error = false } = {}) {
  workspaceStatus.setAttribute('role', error ? 'alert' : 'status');
  workspaceStatus.textContent = message;
}

function clearWorkspaceStatus() {
  workspaceStatus.setAttribute('role', 'status');
  workspaceStatus.textContent = '';
}

function hideWorkspace() {
  workspaceToken += 1;
  stopWorkspacePolling();
  workspace.hidden = true;
  workspaceJob.hidden = true;
  workspaceExport.hidden = true;
  workspaceExportDownload.hidden = true;
  sourceCatalog.hidden = true;
  sourceImportJob.hidden = true;
  workspaceCatalogProgress = null;
  clearWorkspaceStatus();
}

function rangeSelection() {
  const from = Number(workspaceFrom.value);
  const to = Number(workspaceTo.value);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
    throw new Error('Choose a valid chapter range.');
  }
  return { startChapterNumber: from, endChapterNumber: to };
}

function workspaceStillSelected(novelId, token) {
  return workspaceToken === token && currentChapter?.novelId === novelId && currentChapter.hasSourceProvenance;
}

function renderWorkspaceJob(job) {
  if (!job) {
    workspaceJob.hidden = true;
    return;
  }
  workspaceJob.hidden = false;
  const attempts = job.attemptCount === 1 ? '1 attempt' : `${job.attemptCount} attempts`;
  workspaceJobStatus.textContent = `Translation is ${job.state} after ${attempts}.`;
  const controllable = activeStates.has(job.state) || job.state === 'paused';
  workspaceJobControl.hidden = !controllable;
  if (controllable) workspaceJobControl.textContent = job.state === 'paused' ? 'Resume translation' : 'Pause translation';
  workspaceJobControl.dataset.jobId = job.id;
  workspaceJobControl.dataset.action = job.state === 'paused' ? 'resume' : 'pause';
}

function renderWorkspaceExport(exportItem, novelId) {
  if (!exportItem) {
    workspaceExport.hidden = true;
    return;
  }
  workspaceExport.hidden = false;
  workspaceExportStatus.textContent = `EPUB is ${exportItem.state}.`;
  const available = exportItem.state === 'available';
  workspaceExportDownload.hidden = !available;
  if (available) workspaceExportDownload.href = `/api/v1/novels/${encodeURIComponent(novelId)}/exports/${encodeURIComponent(exportItem.id)}/download`;
}

function renderSourceCatalog(catalog, detail, job) {
  if (!catalog) {
    sourceCatalog.hidden = true;
    return;
  }
  sourceCatalog.hidden = false;
  sourceCatalogStatus.textContent = `Kujiang catalog ready: ${catalog.entryCount} source chapters, ${catalog.importedEntryCount} imported.`;
  const complete = catalog.importedEntryCount >= catalog.entryCount;
  importSourceCatalog.disabled = complete;
  importSourceCatalog.textContent = complete ? 'Source chapters imported' : 'Import source chapters';
  if (!job) {
    sourceImportJob.hidden = true;
    return;
  }
  sourceImportJob.hidden = false;
  const entry = detail?.entries.find((item) => item.id === job.currentCatalogEntryId);
  const attempts = job.attemptCount === 1 ? '1 attempt' : `${job.attemptCount} attempts`;
  const current = entry ? ` Current source chapter ${entry.ordinal}.` : '';
  const reason = job.lastErrorMessage && (job.state === 'retrying' || job.state === 'paused') ? ` ${job.lastErrorMessage}` : '';
  sourceImportJobStatus.textContent = `Source import is ${job.state} after ${attempts}. ${catalog.importedEntryCount} of ${catalog.entryCount} imported.${current}${reason}`;
  const controllable = activeStates.has(job.state) || job.state === 'paused';
  sourceImportJobControl.hidden = !controllable;
  if (controllable) sourceImportJobControl.textContent = job.state === 'paused' ? 'Resume source import' : 'Pause source import';
  sourceImportJobControl.dataset.jobId = job.id;
  sourceImportJobControl.dataset.action = job.state === 'paused' ? 'resume' : 'pause';
}

async function refreshCurrentChapterNavigation(novelId, token) {
  const chapter = currentChapter;
  if (!chapter || !workspaceStillSelected(novelId, token)) return;
  const refreshed = await request(`/api/v1/novels/${encodeURIComponent(novelId)}/chapters/${chapter.chapterNumber}`);
  if (!workspaceStillSelected(novelId, token) || currentChapter?.chapterNumber !== chapter.chapterNumber) return;
  currentChapter = { ...currentChapter, previousChapterNumber: refreshed.previousChapterNumber, nextChapterNumber: refreshed.nextChapterNumber };
  setNavigationAvailability(currentChapter);
}

function scheduleWorkspaceRefresh(novelId, token) {
  stopWorkspacePolling();
  workspacePoll = window.setTimeout(() => {
    workspacePoll = null;
    void refreshWorkspace(novelId, token);
  }, 1_000);
}

async function refreshWorkspace(novelId, token = workspaceToken) {
  try {
    const [jobs, exports, catalogs] = await Promise.all([
      request(`/api/v1/jobs?novelId=${encodeURIComponent(novelId)}`),
      request(`/api/v1/novels/${encodeURIComponent(novelId)}/exports`),
      request(`/api/v1/novels/${encodeURIComponent(novelId)}/source-catalogs`)
    ]);
    if (!workspaceStillSelected(novelId, token)) return;
    const translationJobs = jobs.items.filter((job) => job.type === 'translate_chapters');
    const sourceImportJobs = jobs.items.filter((job) => job.type === 'source_import_catalog');
    const translationJob = translationJobs.find((job) => activeStates.has(job.state) || job.state === 'paused') ?? translationJobs[0];
    const sourceImport = sourceImportJobs.find((job) => activeStates.has(job.state) || job.state === 'paused') ?? sourceImportJobs[0];
    const currentCatalog = catalogs.items.find((catalog) => catalog.id === sourceImport?.target.catalogId) ?? catalogs.items[0];
    const detail = currentCatalog ? await request(`/api/v1/novels/${encodeURIComponent(novelId)}/source-catalogs/${encodeURIComponent(currentCatalog.id)}`) : null;
    if (!workspaceStillSelected(novelId, token)) return;
    const exportItem = exports.items.find((item) => activeStates.has(item.state) || item.state === 'building') ?? exports.items[0];
    renderWorkspaceJob(translationJob);
    renderWorkspaceExport(exportItem, novelId);
    renderSourceCatalog(currentCatalog, detail, sourceImport);
    const progressChanged = currentCatalog && (workspaceCatalogProgress?.id !== currentCatalog.id || workspaceCatalogProgress.importedEntryCount !== currentCatalog.importedEntryCount);
    workspaceCatalogProgress = currentCatalog && { id: currentCatalog.id, importedEntryCount: currentCatalog.importedEntryCount };
    if (progressChanged) void refreshCurrentChapterNavigation(novelId, token).catch(() => {});
    const hasActiveWork = Boolean(
      translationJobs.some((job) => activeStates.has(job.state)) ||
      sourceImportJobs.some((job) => activeStates.has(job.state)) ||
      exports.items.some((item) => activeStates.has(item.state) || item.state === 'building')
    );
    if (hasActiveWork) scheduleWorkspaceRefresh(novelId, token);
    else stopWorkspacePolling();
  } catch (error) {
    if (workspaceStillSelected(novelId, token)) setWorkspaceStatus(error.message, { error: true });
  }
}

function showWorkspace(chapter) {
  if (!chapter.hasSourceProvenance) {
    hideWorkspace();
    return;
  }
  workspaceToken += 1;
  const token = workspaceToken;
  stopWorkspacePolling();
  workspace.hidden = false;
  workspaceFrom.value = String(chapter.chapterNumber);
  workspaceTo.value = String(chapter.chapterNumber);
  workspaceJob.hidden = true;
  workspaceExport.hidden = true;
  workspaceExportDownload.hidden = true;
  sourceCatalog.hidden = true;
  sourceImportJob.hidden = true;
  discoverSourceCatalog.disabled = false;
  importSourceCatalog.disabled = false;
  sourceImportJobControl.disabled = false;
  workspaceCatalogProgress = null;
  clearWorkspaceStatus();
  void refreshWorkspace(chapter.novelId, token);
}

function setNavigationAvailability(chapter) {
  for (const button of reader.querySelectorAll('[data-direction]')) {
    button.disabled = !chapter || (button.dataset.direction === 'previous' ? chapter.previousChapterNumber === null : chapter.nextChapterNumber === null);
  }
}

function showReaderMessage(title, message) {
  currentChapter = null;
  chapterNumber.textContent = '';
  chapterTitle.textContent = title;
  chapterText.replaceChildren(Object.assign(document.createElement('p'), { textContent: message }));
  translationStatus.textContent = '';
  resetFeedbackForm();
  clearFeedbackStatus();
  reportTranslation.hidden = true;
  hideWorkspace();
  setNavigationAvailability(null);
}

function setFeedbackStatus(message, { error = false } = {}) {
  feedbackStatus.setAttribute('role', error ? 'alert' : 'status');
  feedbackStatus.textContent = message;
  if (error) feedbackStatus.focus();
}

function clearFeedbackStatus() {
  feedbackStatus.setAttribute('role', 'status');
  feedbackStatus.textContent = '';
}

function resetFeedbackForm() {
  feedbackForm.reset();
  feedbackForm.hidden = true;
  reportTranslation.setAttribute('aria-expanded', 'false');
  for (const field of [feedbackSelectedText, feedbackCorrection, feedbackReason]) field.removeAttribute('aria-invalid');
}

function selectedChapterText() {
  const selection = window.getSelection();
  if (selection?.rangeCount && chapterText.contains(selection.anchorNode) && chapterText.contains(selection.focusNode)) {
    const text = selection.toString().trim();
    if (text) return text;
  }
  return currentChapter?.translatedText ?? '';
}

function showFeedbackForm() {
  if (!currentChapter?.translatedText || !currentChapter.translationRevisionId) return;
  feedbackSelectedText.value = selectedChapterText();
  feedbackForm.hidden = false;
  reportTranslation.setAttribute('aria-expanded', 'true');
  clearFeedbackStatus();
  feedbackSelectedText.focus();
}

function renderChapter(chapter, { focus = false } = {}) {
  currentChapter = chapter;
  readerStatus.textContent = '';
  resetFeedbackForm();
  clearFeedbackStatus();
  chapterNumber.textContent = `Chapter ${chapter.chapterNumber}`;
  chapterTitle.textContent = chapter.title;
  const hasTranslation = Boolean(chapter.translatedText && chapter.translationRevisionId);
  const text = hasTranslation ? chapter.translatedText : chapter.originalText;
  chapterText.replaceChildren(...text.split(/\n{2,}/).map((paragraph) => Object.assign(document.createElement('p'), { textContent: paragraph })));
  chapterText.lang = hasTranslation ? 'en' : 'zh';
  translationStatus.textContent = hasTranslation ? '' : 'English translation unavailable. Showing the original Chinese.';
  reportTranslation.hidden = !hasTranslation;
  setNavigationAvailability(chapter);
  showWorkspace(chapter);
  if (focus) { chapterTitle.focus({ preventScroll: true }); window.scrollTo(0, 0); }
}

function renderLibrary() {
  const selectedNovelId = readerState()?.novelId;
  novelList.replaceChildren(...novels.map((novel) => {
    const item = document.createElement('li');
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: novel.title });
    button.dataset.novelId = novel.id;
    if (novel.id === selectedNovelId) button.setAttribute('aria-current', 'page');
    item.append(button);
    return item;
  }));
  libraryStatus.textContent = novels.length === 0 ? 'Your shelf is empty.' : '';
}

async function refreshLibrary() { novels = (await request('/api/v1/novels')).items; renderLibrary(); }
async function showChapter(novelId, number, options) { renderChapter(await request(`/api/v1/novels/${encodeURIComponent(novelId)}/chapters/${number}`), options); }

async function openNovel(novelId) {
  const number = novels.find((item) => item.id === novelId)?.readingProgress?.chapterNumber || 1;
  setReaderState(novelId, number);
  renderLibrary();
  try { await showChapter(novelId, number, { focus: true }); } catch (error) { showReaderMessage('No chapters yet', 'This novel has no readable chapter yet.'); readerStatus.textContent = error.message; }
}

async function navigate(direction) {
  const number = direction === 'previous' ? currentChapter?.previousChapterNumber : currentChapter?.nextChapterNumber;
  if (!number || !currentChapter) return;
  try {
    const novelId = currentChapter.novelId;
    const chapter = await request(`/api/v1/novels/${encodeURIComponent(novelId)}/chapters/${number}`);
    await request(`/api/v1/novels/${encodeURIComponent(novelId)}/reading-progress`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chapterNumber: number }) });
    setReaderState(novelId, number);
    renderChapter(chapter, { focus: true });
    await refreshLibrary();
  } catch (error) { readerStatus.textContent = error.message; }
}

novelForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = novelTitle.value.trim();
  if (!title) return;
  try {
    const novel = await request('/api/v1/novels', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) });
    novelForm.reset();
    await refreshLibrary();
    await openNovel(novel.id);
  } catch (error) { libraryStatus.textContent = error.message; }
});

library.addEventListener('click', (event) => { const button = event.target.closest('[data-novel-id]'); if (button) openNovel(button.dataset.novelId); });
reader.addEventListener('click', (event) => {
  const button = event.target.closest('[data-direction]');
  if (button) navigate(button.dataset.direction);
  if (event.target.closest('#report-translation')) showFeedbackForm();
  if (event.target.closest('[data-feedback-cancel]')) {
    resetFeedbackForm();
    clearFeedbackStatus();
    reportTranslation.focus();
  }
});
feedbackForm.addEventListener('input', (event) => event.target.removeAttribute('aria-invalid'));
feedbackForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentChapter?.translatedText || !currentChapter.translationRevisionId) return;
  const fields = [
    [feedbackSelectedText, 'Selected passage'],
    [feedbackCorrection, 'Suggested correction'],
    [feedbackReason, 'What needs attention?']
  ];
  const missing = fields.find(([field]) => !field.value.trim());
  if (missing) {
    const [field, label] = missing;
    field.setAttribute('aria-invalid', 'true');
    setFeedbackStatus(`${label} is required.`, { error: true });
    field.focus();
    return;
  }
  try {
    await request(`/api/v1/novels/${encodeURIComponent(currentChapter.novelId)}/chapters/${currentChapter.chapterNumber}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        translationRevisionId: currentChapter.translationRevisionId,
        selectedText: feedbackSelectedText.value.trim(),
        sourceContext: currentChapter.originalText,
        translatedContext: currentChapter.translatedText,
        proposedCorrection: feedbackCorrection.value.trim(),
        reason: feedbackReason.value.trim()
      })
    });
    resetFeedbackForm();
    setFeedbackStatus('Your translation issue report was sent. Thank you.');
  } catch (error) {
    setFeedbackStatus(error.message, { error: true });
  }
});
workspaceForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentChapter?.hasSourceProvenance) return;
  try {
    const target = rangeSelection();
    queueTranslation.disabled = true;
    clearWorkspaceStatus();
    await request('/api/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ novelId: currentChapter.novelId, type: 'translate_chapters', target })
    });
    setWorkspaceStatus('Translation job saved.');
    await refreshWorkspace(currentChapter.novelId);
  } catch (error) {
    setWorkspaceStatus(error.message, { error: true });
  } finally {
    queueTranslation.disabled = false;
  }
});
createEpub.addEventListener('click', async () => {
  if (!currentChapter?.hasSourceProvenance) return;
  try {
    const selection = rangeSelection();
    createEpub.disabled = true;
    clearWorkspaceStatus();
    await request(`/api/v1/novels/${encodeURIComponent(currentChapter.novelId)}/exports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selection })
    });
    setWorkspaceStatus('EPUB snapshot saved.');
    await refreshWorkspace(currentChapter.novelId);
  } catch (error) {
    setWorkspaceStatus(error.message, { error: true });
  } finally {
    createEpub.disabled = false;
  }
});
sourceCatalogForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentChapter?.hasSourceProvenance || !sourceBookUrl.value.trim()) return;
  const novelId = currentChapter.novelId;
  const token = workspaceToken;
  try {
    discoverSourceCatalog.disabled = true;
    clearWorkspaceStatus();
    await request(`/api/v1/novels/${encodeURIComponent(novelId)}/source-catalogs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bookUrl: sourceBookUrl.value.trim() })
    });
    if (!workspaceStillSelected(novelId, token)) return;
    setWorkspaceStatus('Source catalog saved. Import starts only when you choose it.');
    await refreshWorkspace(novelId, token);
  } catch (error) {
    if (workspaceStillSelected(novelId, token)) setWorkspaceStatus(error.message, { error: true });
  } finally {
    if (workspaceStillSelected(novelId, token)) discoverSourceCatalog.disabled = false;
  }
});
importSourceCatalog.addEventListener('click', async () => {
  if (!currentChapter?.hasSourceProvenance || !workspaceCatalogProgress) return;
  const novelId = currentChapter.novelId;
  const token = workspaceToken;
  const catalogId = workspaceCatalogProgress.id;
  try {
    importSourceCatalog.disabled = true;
    clearWorkspaceStatus();
    await request('/api/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ novelId, type: 'source_import_catalog', target: { catalogId } })
    });
    if (!workspaceStillSelected(novelId, token)) return;
    setWorkspaceStatus('Source import job saved.');
    await refreshWorkspace(novelId, token);
  } catch (error) {
    if (workspaceStillSelected(novelId, token)) setWorkspaceStatus(error.message, { error: true });
  } finally {
    if (workspaceStillSelected(novelId, token)) importSourceCatalog.disabled = false;
  }
});
workspaceJobControl.addEventListener('click', async () => {
  if (!currentChapter || !workspaceJobControl.dataset.jobId) return;
  try {
    workspaceJobControl.disabled = true;
    clearWorkspaceStatus();
    await request(`/api/v1/jobs/${encodeURIComponent(workspaceJobControl.dataset.jobId)}/${workspaceJobControl.dataset.action}?novelId=${encodeURIComponent(currentChapter.novelId)}`, { method: 'POST' });
    await refreshWorkspace(currentChapter.novelId);
  } catch (error) {
    setWorkspaceStatus(error.message, { error: true });
  } finally {
    workspaceJobControl.disabled = false;
  }
});
sourceImportJobControl.addEventListener('click', async () => {
  if (!currentChapter || !sourceImportJobControl.dataset.jobId) return;
  const novelId = currentChapter.novelId;
  const token = workspaceToken;
  const jobId = sourceImportJobControl.dataset.jobId;
  const action = sourceImportJobControl.dataset.action;
  try {
    sourceImportJobControl.disabled = true;
    clearWorkspaceStatus();
    await request(`/api/v1/jobs/${encodeURIComponent(jobId)}/${action}?novelId=${encodeURIComponent(novelId)}`, { method: 'POST' });
    if (!workspaceStillSelected(novelId, token)) return;
    await refreshWorkspace(novelId, token);
  } catch (error) {
    if (workspaceStillSelected(novelId, token)) setWorkspaceStatus(error.message, { error: true });
  } finally {
    if (workspaceStillSelected(novelId, token)) sourceImportJobControl.disabled = false;
  }
});
window.addEventListener('keydown', (event) => { if (event.target.matches('input, textarea, select, button, a, [contenteditable]')) return; if (event.key === 'ArrowLeft') navigate('previous'); if (event.key === 'ArrowRight') navigate('next'); });
window.addEventListener('popstate', async () => { const state = readerState(); if (!state) return showReaderMessage('Choose a novel', 'Select a novel from your shelf to begin reading.'); try { await showChapter(state.novelId, state.chapter, { focus: true }); renderLibrary(); } catch (error) { showReaderMessage('Chapter unavailable', error.message); } });

try { await refreshLibrary(); const state = readerState(); if (state) await showChapter(state.novelId, state.chapter); } catch (error) { libraryStatus.textContent = error.message; }
