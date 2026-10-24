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
const translationModel = document.querySelector('#translation-model');
const translationModelStatus = document.querySelector('#translation-model-status');
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
const sourceResolutionForm = document.querySelector('#source-resolution-form');
const novelPingChapterUrl = document.querySelector('#novelping-chapter-url');
const resolveSource = document.querySelector('#resolve-source');
const sourceResolutionStatus = document.querySelector('#source-resolution-status');
const importResolvedSource = document.querySelector('#import-resolved-source');
const sourceIdentityForm = document.querySelector('#source-identity-form');
const sourceIdentityBookUrl = document.querySelector('#source-identity-book-url');
const sourceIdentityTitle = document.querySelector('#source-identity-title');
const sourceIdentityTitleAliases = document.querySelector('#source-identity-title-aliases');
const sourceIdentityAuthor = document.querySelector('#source-identity-author');
const sourceIdentityAuthorAliases = document.querySelector('#source-identity-author-aliases');
const sourceIdentityChapterAliases = document.querySelector('#source-identity-chapter-aliases');
const addSourceIdentity = document.querySelector('#add-source-identity');
const sourceIdentityEditor = document.querySelector('#source-identity-editor');
const sourceIdentitiesStatus = document.querySelector('#source-identities-status');
const sourceIdentityList = document.querySelector('#source-identity-list');
const sourceChapterImport = document.querySelector('#source-chapter-import');
const sourceChapterImportForm = document.querySelector('#source-chapter-import-form');
const sourceChapterUrl = document.querySelector('#source-chapter-url');
const sourceChapterNumber = document.querySelector('#source-chapter-number');
const importSourceChapter = document.querySelector('#import-source-chapter');
const sourceChapterImportStatus = document.querySelector('#source-chapter-import-status');

let novels = [];
let currentChapter = null;
let workspacePoll = null;
let workspaceToken = 0;
let workspaceCatalogProgress = null;
let translationModelRefreshToken = 0;
let workspaceResolution = null;
let sourceIdentityRefreshToken = 0;
let sourceChapterImportToken = 0;

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
  if (response.ok) return response.status === 204 ? null : response.json();
  const body = await response.json().catch(() => null);
  const error = new Error(body?.error?.message || 'The library could not be updated.');
  error.retryable = body?.error?.retryable === true;
  throw error;
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

function setSourceResolutionStatus(message, { error = false } = {}) {
  sourceResolutionStatus.setAttribute('role', error ? 'alert' : 'status');
  sourceResolutionStatus.textContent = message;
}

function clearSourceResolution() {
  workspaceResolution = null;
  importResolvedSource.hidden = true;
  importResolvedSource.disabled = false;
  setSourceResolutionStatus('');
}

function setSourceIdentitiesStatus(message, { error = false } = {}) {
  sourceIdentitiesStatus.setAttribute('role', error ? 'alert' : 'status');
  sourceIdentitiesStatus.textContent = message;
}

function clearSourceIdentities() {
  sourceIdentityRefreshToken += 1;
  sourceIdentityForm.reset();
  sourceIdentityEditor.open = false;
  sourceIdentityList.replaceChildren();
  addSourceIdentity.disabled = false;
  setSourceIdentitiesStatus('');
}

function setSourceChapterImportStatus(message, { error = false } = {}) {
  sourceChapterImportStatus.setAttribute('role', error ? 'alert' : 'status');
  sourceChapterImportStatus.textContent = message;
}

function hideSourceChapterImport() {
  sourceChapterImportToken += 1;
  sourceChapterImport.hidden = true;
  sourceChapterImportForm.reset();
  sourceChapterImport.open = false;
  importSourceChapter.disabled = false;
  setSourceChapterImportStatus('');
}

function showSourceChapterImport(chapterNumberValue, { open = false } = {}) {
  sourceChapterImportToken += 1;
  sourceChapterImport.hidden = false;
  sourceChapterImportForm.reset();
  sourceChapterNumber.value = chapterNumberValue === null ? '' : String(chapterNumberValue);
  sourceChapterImport.open = open;
  importSourceChapter.disabled = false;
  setSourceChapterImportStatus('');
}

function sourceChapterImportStillSelected(novelId, token) {
  return sourceChapterImportToken === token && readerState()?.novelId === novelId;
}

function hideWorkspace() {
  workspaceToken += 1;
  translationModelRefreshToken += 1;
  stopWorkspacePolling();
  hideSourceChapterImport();
  workspace.hidden = true;
  workspaceJob.hidden = true;
  workspaceExport.hidden = true;
  workspaceExportDownload.hidden = true;
  sourceCatalog.hidden = true;
  sourceImportJob.hidden = true;
  workspaceCatalogProgress = null;
  clearSourceResolution();
  clearSourceIdentities();
  clearWorkspaceStatus();
  translationModel.replaceChildren(Object.assign(document.createElement('option'), { textContent: 'Loading local models' }));
  translationModel.disabled = true;
  translationModelStatus.textContent = '';
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
  return workspaceToken === token && currentChapter?.novelId === novelId;
}

async function refreshTranslationModels(novelId, token = workspaceToken) {
  const refreshToken = ++translationModelRefreshToken;
  translationModel.disabled = true;
  translationModel.replaceChildren(Object.assign(document.createElement('option'), { textContent: 'Loading local models' }));
  translationModelStatus.textContent = 'Checking local Ollama models.';
  try {
    const { items, defaultModel } = await request('/api/v1/translation-models');
    if (!workspaceStillSelected(novelId, token) || refreshToken !== translationModelRefreshToken) return;
    translationModel.replaceChildren(...items.map((model) => Object.assign(document.createElement('option'), { value: model, textContent: model })));
    translationModel.value = items.includes(defaultModel) ? defaultModel : items[0] ?? '';
    translationModel.disabled = items.length === 0;
    translationModelStatus.textContent = items.length === 0
      ? 'No local Ollama models are installed.'
      : `${items.length} local Ollama model${items.length === 1 ? '' : 's'} available.`;
  } catch (error) {
    if (!workspaceStillSelected(novelId, token) || refreshToken !== translationModelRefreshToken) return;
    translationModel.replaceChildren(Object.assign(document.createElement('option'), { textContent: 'Local models unavailable' }));
    translationModel.disabled = true;
    translationModelStatus.textContent = error.message;
  }
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
  const importedFromResolution = workspaceResolution?.catalogId === catalog.id;
  importSourceCatalog.hidden = importedFromResolution;
  if (importedFromResolution && job) importResolvedSource.hidden = true;
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

function currentSourceResolution(items) {
  return items.find((item) => item.state === 'resolved' && item.acceptedSource) ?? items[0] ?? null;
}

function renderSourceResolution(detail) {
  workspaceResolution = null;
  importResolvedSource.hidden = true;
  if (!detail) {
    setSourceResolutionStatus('');
    return;
  }
  if (detail.state === 'resolved' && detail.importEligible && detail.acceptedSource) {
    const candidate = detail.candidates.find((item) => item.id === detail.selectedCandidateId);
    const sourceTitle = candidate?.metadata?.novelTitle ?? 'source catalog';
    setSourceResolutionStatus(`Source resolved: ${sourceTitle}, Chapter ${detail.evidence.chapterNumber}.`);
    workspaceResolution = { id: detail.id, catalogId: detail.acceptedSource.catalogId };
    importResolvedSource.hidden = false;
    return;
  }
  if (detail.state === 'unresolved') {
    setSourceResolutionStatus('No verified source match was found.');
    return;
  }
  setSourceResolutionStatus('This source check is temporarily unavailable. You can try again.', { error: true });
}

function renderSourceIdentities(items) {
  sourceIdentityList.replaceChildren(...items.map((identity) => {
    const item = document.createElement('li');
    item.className = 'source-identity';
    const title = document.createElement('span');
    title.textContent = identity.novelTitle;
    const link = document.createElement('a');
    link.href = identity.canonicalBookUrl;
    link.textContent = identity.canonicalBookUrl;
    const author = identity.author ? document.createElement('span') : null;
    if (author) author.textContent = identity.author;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.dataset.sourceIdentityId = identity.id;
    remove.setAttribute('aria-label', `Remove trusted source identity ${identity.novelTitle}`);
    remove.textContent = 'Remove';
    item.append(title, link);
    if (author) item.append(author);
    item.append(remove);
    return item;
  }));
}

async function refreshSourceIdentities(novelId, token = workspaceToken) {
  const refreshToken = ++sourceIdentityRefreshToken;
  try {
    const { items } = await request(`/api/v1/novels/${encodeURIComponent(novelId)}/source-identities`);
    if (!workspaceStillSelected(novelId, token) || refreshToken !== sourceIdentityRefreshToken) return;
    renderSourceIdentities(items);
  } catch (error) {
    if (workspaceStillSelected(novelId, token) && refreshToken === sourceIdentityRefreshToken) setSourceIdentitiesStatus(error.message, { error: true });
  }
}

async function refreshSourceResolution(novelId, token = workspaceToken) {
  const identitiesRefresh = refreshSourceIdentities(novelId, token);
  try {
    const { items } = await request(`/api/v1/novels/${encodeURIComponent(novelId)}/source-resolutions`);
    const resolution = currentSourceResolution(items);
    const detail = resolution ? await request(`/api/v1/novels/${encodeURIComponent(novelId)}/source-resolutions/${encodeURIComponent(resolution.id)}`) : null;
    if (!workspaceStillSelected(novelId, token)) return;
    renderSourceResolution(detail);
  } catch (error) {
    if (workspaceStillSelected(novelId, token)) {
      workspaceResolution = null;
      importResolvedSource.hidden = true;
      setSourceResolutionStatus('This source check is temporarily unavailable. You can try again.', { error: true });
    }
  } finally {
    await identitiesRefresh;
  }
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
  const resolutionRefresh = refreshSourceResolution(novelId, token);
  try {
    const [jobs, exports, catalogs] = await Promise.all([
      request(`/api/v1/jobs?novelId=${encodeURIComponent(novelId)}`),
      request(`/api/v1/novels/${encodeURIComponent(novelId)}/exports`),
      request(`/api/v1/novels/${encodeURIComponent(novelId)}/source-catalogs`)
    ]);
    if (!workspaceStillSelected(novelId, token)) return;
    await resolutionRefresh;
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
  workspaceToken += 1;
  const token = workspaceToken;
  stopWorkspacePolling();
  workspace.hidden = false;
  workspaceForm.hidden = !chapter.hasSourceProvenance;
  sourceCatalogForm.hidden = !chapter.hasSourceProvenance;
  workspaceFrom.value = String(chapter.chapterNumber);
  workspaceTo.value = String(chapter.chapterNumber);
  workspaceJob.hidden = true;
  workspaceExport.hidden = true;
  workspaceExportDownload.hidden = true;
  sourceCatalog.hidden = true;
  sourceImportJob.hidden = true;
  importSourceCatalog.hidden = false;
  discoverSourceCatalog.disabled = false;
  importSourceCatalog.disabled = false;
  sourceImportJobControl.disabled = false;
  resolveSource.disabled = false;
  showSourceChapterImport(chapter.nextChapterNumber === null ? chapter.chapterNumber + 1 : null);
  workspaceCatalogProgress = null;
  translationModelRefreshToken += 1;
  translationModel.replaceChildren(Object.assign(document.createElement('option'), { textContent: 'Loading local models' }));
  translationModel.disabled = true;
  translationModelStatus.textContent = '';
  clearSourceResolution();
  clearSourceIdentities();
  clearWorkspaceStatus();
  if (chapter.hasSourceProvenance) {
    void refreshTranslationModels(chapter.novelId, token);
    void refreshWorkspace(chapter.novelId, token);
  }
  else void refreshSourceResolution(chapter.novelId, token);
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
  const state = readerState();
  if (state) showSourceChapterImport(state.chapter, { open: true });
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
  try {
    await showChapter(novelId, number, { focus: true });
  } catch (error) {
    showReaderMessage('No chapters yet', 'This novel has no readable chapter yet.');
    if (error.message !== 'chapter not found') readerStatus.textContent = error.message;
  }
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
      body: JSON.stringify({
        novelId: currentChapter.novelId,
        type: 'translate_chapters',
        target: translationModel.value ? { ...target, model: translationModel.value } : target
      })
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
sourceChapterImportForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const state = readerState();
  if (!state) return;
  const novelId = state.novelId;
  const token = sourceChapterImportToken;
  const chapterNumberValue = Number(sourceChapterNumber.value);
  const sourceUrl = sourceChapterUrl.value.trim();
  try {
    importSourceChapter.disabled = true;
    setSourceChapterImportStatus('Importing source chapter.');
    await request(`/api/v1/novels/${encodeURIComponent(novelId)}/source-chapters`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceUrl, chapterNumber: chapterNumberValue })
    });
    if (!sourceChapterImportStillSelected(novelId, token)) return;
    await refreshLibrary();
    if (!sourceChapterImportStillSelected(novelId, token)) return;
    await request(`/api/v1/novels/${encodeURIComponent(novelId)}/reading-progress`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chapterNumber: chapterNumberValue })
    });
    if (!sourceChapterImportStillSelected(novelId, token)) return;
    await refreshLibrary();
    if (!sourceChapterImportStillSelected(novelId, token)) return;
    setReaderState(novelId, chapterNumberValue);
    renderLibrary();
    await showChapter(novelId, chapterNumberValue, { focus: true });
  } catch (error) {
    if (sourceChapterImportStillSelected(novelId, token)) setSourceChapterImportStatus(error.message, { error: true });
  } finally {
    if (sourceChapterImportStillSelected(novelId, token)) importSourceChapter.disabled = false;
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
sourceIdentityForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentChapter) return;
  const novelId = currentChapter.novelId;
  const token = workspaceToken;
  let chapterTitleAliases;
  if (sourceIdentityChapterAliases.value.trim()) {
    try {
      chapterTitleAliases = JSON.parse(sourceIdentityChapterAliases.value);
    } catch {
      setSourceIdentitiesStatus('Chapter title aliases must be valid JSON.', { error: true });
      return;
    }
    if (chapterTitleAliases === null || typeof chapterTitleAliases !== 'object' || Array.isArray(chapterTitleAliases)) {
      setSourceIdentitiesStatus('Chapter title aliases must be a JSON object.', { error: true });
      return;
    }
  }
  const aliases = (value) => value.split(',').map((item) => item.trim()).filter(Boolean);
  const novelTitleAliases = aliases(sourceIdentityTitleAliases.value);
  const authorAliases = aliases(sourceIdentityAuthorAliases.value);
  const input = {
    bookUrl: sourceIdentityBookUrl.value.trim(),
    novelTitle: sourceIdentityTitle.value.trim(),
    ...(novelTitleAliases.length ? { novelTitleAliases } : {}),
    ...(sourceIdentityAuthor.value.trim() ? { author: sourceIdentityAuthor.value.trim() } : {}),
    ...(authorAliases.length ? { authorAliases } : {}),
    ...(chapterTitleAliases === undefined ? {} : { chapterTitleAliases })
  };
  try {
    addSourceIdentity.disabled = true;
    setSourceIdentitiesStatus('Saving trusted source identity.');
    await request(`/api/v1/novels/${encodeURIComponent(novelId)}/source-identities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input)
    });
    if (!workspaceStillSelected(novelId, token)) return;
    sourceIdentityForm.reset();
    sourceIdentityEditor.open = false;
    setSourceIdentitiesStatus('Trusted source identity saved.');
    await refreshSourceIdentities(novelId, token);
  } catch (error) {
    if (workspaceStillSelected(novelId, token)) setSourceIdentitiesStatus(error.message, { error: true });
  } finally {
    if (workspaceStillSelected(novelId, token)) addSourceIdentity.disabled = false;
  }
});
sourceIdentityList.addEventListener('click', async (event) => {
  const remove = event.target.closest('[data-source-identity-id]');
  if (!remove || remove.disabled || !currentChapter) return;
  const novelId = currentChapter.novelId;
  const token = workspaceToken;
  const identityId = remove.dataset.sourceIdentityId;
  if (!window.confirm('Remove this trusted source identity? This cannot be undone.')) return;
  try {
    remove.disabled = true;
    setSourceIdentitiesStatus('Removing trusted source identity.');
    await request(`/api/v1/novels/${encodeURIComponent(novelId)}/source-identities/${encodeURIComponent(identityId)}`, { method: 'DELETE' });
    if (!workspaceStillSelected(novelId, token)) return;
    setSourceIdentitiesStatus('Trusted source identity removed.');
    await refreshSourceIdentities(novelId, token);
  } catch (error) {
    if (workspaceStillSelected(novelId, token)) setSourceIdentitiesStatus(error.message, { error: true });
  } finally {
    if (workspaceStillSelected(novelId, token)) remove.disabled = false;
  }
});
sourceResolutionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentChapter || !novelPingChapterUrl.value.trim()) return;
  const novelId = currentChapter.novelId;
  const token = workspaceToken;
  const novelPingUrl = novelPingChapterUrl.value.trim();
  sourceResolutionForm.reset();
  try {
    resolveSource.disabled = true;
    setSourceResolutionStatus('Checking this chapter against a trusted source.');
    const detail = await request(`/api/v1/novels/${encodeURIComponent(novelId)}/source-resolutions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': `reader-resolution-${crypto.randomUUID()}` },
      body: JSON.stringify({ novelPingUrl })
    });
    if (!workspaceStillSelected(novelId, token)) return;
    renderSourceResolution(detail);
    await refreshWorkspace(novelId, token);
  } catch (error) {
    if (workspaceStillSelected(novelId, token)) {
      const message = error.retryable
        ? 'This source check is temporarily unavailable. You can try again.'
        : 'This chapter URL cannot be used for source matching.';
      setSourceResolutionStatus(message, { error: true });
    }
  } finally {
    if (workspaceStillSelected(novelId, token)) resolveSource.disabled = false;
  }
});
importResolvedSource.addEventListener('click', async () => {
  if (!currentChapter || !workspaceResolution) return;
  const novelId = currentChapter.novelId;
  const token = workspaceToken;
  const attemptId = workspaceResolution.id;
  try {
    importResolvedSource.disabled = true;
    setSourceResolutionStatus('Starting source import.');
    await request(`/api/v1/novels/${encodeURIComponent(novelId)}/source-resolutions/${encodeURIComponent(attemptId)}/catalog-import`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `reader-source-import-${crypto.randomUUID()}` }
    });
    if (!workspaceStillSelected(novelId, token)) return;
    setSourceResolutionStatus('Source import started.');
    await refreshWorkspace(novelId, token);
  } catch (error) {
    if (workspaceStillSelected(novelId, token)) {
      setSourceResolutionStatus(error.retryable ? 'This source import is temporarily unavailable. You can try again.' : 'This source is no longer ready to import.', { error: true });
    }
  } finally {
    if (workspaceStillSelected(novelId, token)) importResolvedSource.disabled = false;
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

try {
  await refreshLibrary();
  const state = readerState();
  if (state) await showChapter(state.novelId, state.chapter);
} catch (error) {
  const state = readerState();
  if (state && error.message === 'chapter not found') showReaderMessage('No chapters yet', 'This novel has no readable chapter yet.');
  else libraryStatus.textContent = error.message;
}
