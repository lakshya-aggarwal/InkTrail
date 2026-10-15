import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import { ConflictError, ValidationError } from '../domain/errors.js';
import { canonicalizeChapterTarget } from '../jobs/job-repository.js';

const EPUB_DATE = new Date('1980-01-01T00:00:00.000Z');

function escapeXml(value) {
  let output = '';
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0);
    if (!(codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd || (codePoint >= 0x20 && codePoint <= 0xd7ff) || (codePoint >= 0xe000 && codePoint <= 0xfffd) || (codePoint >= 0x10000 && codePoint <= 0x10ffff))) continue;
    output += character.replace(/[&<>"']/g, (match) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[match]);
  }
  return output;
}

function chapterFileName(ordinal) {
  return `OEBPS/chapters/${String(ordinal).padStart(4, '0')}.xhtml`;
}

function chapterXhtml(chapter) {
  const paragraphs = chapter.translatedText.split(/\r?\n\s*\r?\n/)
    .map((paragraph) => `<p>${paragraph.split(/\r?\n/).map(escapeXml).join('<br />')}</p>`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en"><head><title>${escapeXml(chapter.title)}</title></head><body><h1>${escapeXml(chapter.title)}</h1>\n${paragraphs}\n</body></html>`;
}

function packageDocument(snapshot) {
  const chapterItems = snapshot.chapters.map((chapter) => `<item id="chapter-${chapter.ordinal}" href="chapters/${String(chapter.ordinal).padStart(4, '0')}.xhtml" media-type="application/xhtml+xml" />`).join('\n');
  const spineItems = snapshot.chapters.map((chapter) => `<itemref idref="chapter-${chapter.ordinal}" />`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="en"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:${snapshot.export.id}</dc:identifier><dc:title>InkTrail Export</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">${escapeXml(snapshot.export.snapshotAt.replace(/\.\d{3}Z$/, 'Z'))}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />\n${chapterItems}</manifest><spine>\n${spineItems}\n</spine></package>`;
}

function navigationDocument(snapshot) {
  const links = snapshot.chapters.map((chapter) => `<li><a href="chapters/${String(chapter.ordinal).padStart(4, '0')}.xhtml">${escapeXml(chapter.title)}</a></li>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en"><head><title>Contents</title></head><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><h1>Contents</h1><ol>\n${links}\n</ol></nav></body></html>`;
}

function expectedChapterNumbers(selection) {
  const target = canonicalizeChapterTarget(selection);
  return target.chapterNumbers ?? Array.from(
    { length: target.endChapterNumber - target.startChapterNumber + 1 },
    (_, index) => target.startChapterNumber + index
  );
}

export function validateExportSnapshot(snapshot) {
  if (!snapshot?.export || !Array.isArray(snapshot.chapters)) throw new ValidationError('EPUB snapshot is invalid');
  const expected = expectedChapterNumbers(snapshot.export.selection);
  if (snapshot.chapters.length !== expected.length) throw new ConflictError('EPUB snapshot has incomplete chapter coverage');
  snapshot.chapters.forEach((chapter, index) => {
    if (chapter.ordinal !== index + 1 || chapter.chapterNumber !== expected[index] || typeof chapter.translatedText !== 'string' || chapter.translatedText.trim().length === 0) {
      throw new ConflictError('EPUB snapshot has invalid chapter coverage');
    }
  });
  return snapshot;
}

export async function writeEpubArchive({ temporaryFile, snapshot }) {
  await new Promise((resolve, reject) => {
    const output = createWriteStream(temporaryFile, { flags: 'wx' });
    const archive = archiver('zip', { zlib: { level: 9 } });
    const rejectOnce = (error) => reject(error);
    output.once('close', resolve);
    output.once('error', rejectOnce);
    archive.once('error', rejectOnce);
    archive.pipe(output);
    archive.append('application/epub+zip', { name: 'mimetype', store: true, date: EPUB_DATE });
    archive.append('<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" /></rootfiles></container>', { name: 'META-INF/container.xml', date: EPUB_DATE });
    archive.append(packageDocument(snapshot), { name: 'OEBPS/content.opf', date: EPUB_DATE });
    archive.append(navigationDocument(snapshot), { name: 'OEBPS/nav.xhtml', date: EPUB_DATE });
    snapshot.chapters.forEach((chapter) => archive.append(chapterXhtml(chapter), { name: chapterFileName(chapter.ordinal), date: EPUB_DATE }));
    archive.finalize();
  });
}

export function createEpubBuilder({ exports, exportRoot, writeArchive = writeEpubArchive }) {
  async function build({ novelId, exportId, shouldContinue = () => true }) {
    const snapshot = validateExportSnapshot(exports.getExportSnapshot({ novelId, exportId }));
    let building = false;
    let temporaryFile = null;
    let published = false;
    try {
      if (!shouldContinue()) throw new ConflictError('EPUB job claim is no longer active');
      exports.transitionExport({ novelId, exportId, toState: 'building' });
      building = true;
      temporaryFile = exportRoot.temporaryPath(snapshot.export.fileName);
      await writeArchive({ temporaryFile, snapshot });
      if (!shouldContinue()) throw new ConflictError('EPUB job claim is no longer active');
      const output = await exportRoot.publish({ fileName: snapshot.export.fileName, temporaryFile });
      published = true;
      if (!shouldContinue()) throw new ConflictError('EPUB job claim is no longer active');
      const exportRecord = exports.transitionExport({
        novelId,
        exportId,
        toState: 'available',
        byteSize: output.byteSize,
        sha256: output.sha256
      });
      return { export: exportRecord, chapters: snapshot.chapters };
    } catch (error) {
      if (temporaryFile) await exportRoot.removeTemporary(temporaryFile);
      if (published) await exportRoot.removeOutput(snapshot.export.fileName);
      if (building && shouldContinue()) exports.transitionExport({
        novelId,
        exportId,
        toState: 'failed',
        errorCode: 'epub_build_failed',
        errorMessage: 'EPUB export could not be built.'
      });
      throw error;
    }
  }

  function reset({ novelId, exportId }) {
    const { export: snapshot } = exports.getExportSnapshot({ novelId, exportId });
    if (snapshot.state === 'building') {
      return exports.transitionExport({ novelId, exportId, toState: 'queued' });
    }
    return snapshot;
  }

  async function openDownload({ novelId, exportId }) {
    const snapshot = exports.getExportSnapshot({ novelId, exportId });
    if (snapshot.export.state !== 'available') throw new ConflictError('EPUB export is not available');
    return exportRoot.openAvailable({
      fileName: snapshot.export.fileName,
      byteSize: snapshot.export.byteSize,
      sha256: snapshot.export.sha256
    });
  }

  return { build, reset, openDownload };
}
