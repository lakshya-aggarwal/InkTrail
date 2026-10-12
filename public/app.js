const library = document.querySelector('#library');
const novelForm = document.querySelector('#novel-form');
const novelTitle = document.querySelector('#novel-title');
const libraryStatus = document.querySelector('#library-status');
const novelList = document.querySelector('#novel-list');
const reader = document.querySelector('#reader');
const chapterNumber = document.querySelector('#chapter-number');
const chapterTitle = document.querySelector('#chapter-title');
const chapterText = document.querySelector('#chapter-text');
const readerStatus = document.querySelector('#reader-status');

let novels = [];
let currentChapter = null;

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
  setNavigationAvailability(null);
}

function renderChapter(chapter, { focus = false } = {}) {
  currentChapter = chapter;
  readerStatus.textContent = '';
  chapterNumber.textContent = `Chapter ${chapter.chapterNumber}`;
  chapterTitle.textContent = chapter.title;
  const text = chapter.translatedText || chapter.originalText;
  chapterText.replaceChildren(...text.split(/\n{2,}/).map((paragraph) => Object.assign(document.createElement('p'), { textContent: paragraph })));
  setNavigationAvailability(chapter);
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
reader.addEventListener('click', (event) => { const button = event.target.closest('[data-direction]'); if (button) navigate(button.dataset.direction); });
window.addEventListener('keydown', (event) => { if (event.target.matches('input, textarea, select, [contenteditable]')) return; if (event.key === 'ArrowLeft') navigate('previous'); if (event.key === 'ArrowRight') navigate('next'); });
window.addEventListener('popstate', async () => { const state = readerState(); if (!state) return showReaderMessage('Choose a novel', 'Select a novel from your shelf to begin reading.'); try { await showChapter(state.novelId, state.chapter, { focus: true }); renderLibrary(); } catch (error) { showReaderMessage('Chapter unavailable', error.message); } });

try { await refreshLibrary(); const state = readerState(); if (state) await showChapter(state.novelId, state.chapter); } catch (error) { libraryStatus.textContent = error.message; }
