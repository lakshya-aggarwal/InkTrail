import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import test from 'node:test';
import { createChapterRepository } from '../../src/chapters/chapter-repository.js';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { ConflictError, ValidationError } from '../../src/domain/errors.js';
import { createEpubBuilder, validateExportSnapshot } from '../../src/epub/epub-builder.js';
import { createExportRepository } from '../../src/epub/export-repository.js';
import { createExportRoot } from '../../src/epub/export-root.js';
import { createNovelRepository } from '../../src/novels/novel-repository.js';
import { createSourceRepository } from '../../src/sources/source-repository.js';

function zipEntries(buffer) {
  const entries = [];
  let offset = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  while (offset !== -1 && buffer.readUInt32LE(offset) === 0x02014b50) {
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.push({ name, compression, text: (compression === 0 ? data : inflateRawSync(data)).toString('utf8') });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function fixture(t) {
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  const clock = () => new Date('2026-10-15T00:00:00.000Z');
  const novels = createNovelRepository(database, clock);
  const chapters = createChapterRepository(database, clock);
  const sources = createSourceRepository(database, clock);
  const exports = createExportRepository(database, clock);
  const rootPath = await mkdtemp(join(tmpdir(), 'inktrail-epub-'));
  const exportRoot = createExportRoot({ exportRoot: rootPath });
  t.after(async () => { database.close(); await rm(rootPath, { recursive: true, force: true }); });
  const novel = novels.createNovel({ title: 'The <Trail>' });
  const source = sources.createOrGetNovelSource({ novelId: novel.id, site: 'fixture', externalNovelId: 'novel', sourceUrl: 'https://example.test/book', normalizedUrl: 'https://example.test/book', title: novel.title });
  const seeded = [
    [1, 'One & <First>', 'First chapter.\n\nA second paragraph.'],
    [2, 'Two', 'Second chapter.']
  ].map(([chapterNumber, title, translatedText]) => {
    const chapter = chapters.recordChapter({ novelId: novel.id, chapterNumber, title, originalText: `Original ${chapterNumber}` });
    sources.createChapterSource({ novelId: novel.id, chapterId: chapter.id, novelSourceId: source.id, site: 'fixture', externalChapterId: `chapter-${chapterNumber}`, sourceUrl: `https://example.test/book/${chapterNumber}`, normalizedUrl: `https://example.test/book/${chapterNumber}`, sourceTitle: title, previousSourceUrl: null, nextSourceUrl: null, fetchedAt: clock().toISOString(), contentSha256: String(chapterNumber).padEnd(64, '0') });
    const revision = chapters.addTranslationRevision({ chapterId: chapter.id, translatedText, provider: 'test', model: 'test' });
    return { chapter, revision, translatedText };
  });
  return { database, novel, chapters, exports, exportRoot, rootPath, seeded };
}

test('builds an ordered immutable EPUB 3 snapshot with recorded checksum', async (t) => {
  const repositories = await fixture(t);
  const snapshot = repositories.exports.captureSnapshot({ novelId: repositories.novel.id, selection: { startChapterNumber: 1, endChapterNumber: 2 } });
  repositories.chapters.addTranslationRevision({ chapterId: repositories.seeded[0].chapter.id, translatedText: 'Newer text that must not export.', provider: 'test', model: 'test' });
  const builder = createEpubBuilder({ exports: repositories.exports, exportRoot: repositories.exportRoot });
  const result = await builder.build({ novelId: repositories.novel.id, exportId: snapshot.export.id });
  const bytes = await readFile(repositories.exportRoot.outputPath(snapshot.export.fileName));
  const entries = zipEntries(bytes);

  assert.equal(result.export.state, 'available');
  assert.equal(result.export.byteSize, bytes.length);
  assert.equal(result.export.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(entries.map((entry) => entry.name), ['mimetype', 'META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml', 'OEBPS/chapters/0001.xhtml', 'OEBPS/chapters/0002.xhtml']);
  assert.equal(entries[0].compression, 0);
  assert.match(entries[2].text, /<dc:title>InkTrail Export<\/dc:title>/);
  assert.match(entries[3].text, /One &amp; &lt;First&gt;/);
  assert.match(entries[4].text, /First chapter\./);
  assert.doesNotMatch(entries[4].text, /Newer text/);
  assert.match(entries[5].text, /Second chapter\./);
  const download = await builder.openDownload({ novelId: repositories.novel.id, exportId: snapshot.export.id });
  assert.equal(download.byteSize, bytes.length);
  download.stream.destroy();
});

test('rejects incomplete captured coverage before publishing an EPUB', async () => {
  assert.throws(() => validateExportSnapshot({ export: { selection: { startChapterNumber: 1, endChapterNumber: 2 } }, chapters: [{ ordinal: 1, chapterNumber: 1, translatedText: 'Only one.' }] }), ConflictError);
});

test('safe export root contains output, recovers temporary files, and rejects traversal', async (t) => {
  const rootPath = await mkdtemp(join(tmpdir(), 'inktrail-epub-root-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const root = createExportRoot({ exportRoot: rootPath });
  const fileName = '00000000-0000-4000-8000-000000000000.epub';
  const temporary = root.temporaryPath(fileName);
  await writeFile(temporary, 'partial');
  await root.recoverTemporaryFiles();
  await assert.rejects(readFile(temporary));
  assert.throws(() => root.outputPath('../escape.epub'), ValidationError);
  assert.throws(() => root.temporaryPath('escape.epub'), ValidationError);
});

test('archive failure leaves no available export or corrupt output', async (t) => {
  const repositories = await fixture(t);
  const snapshot = repositories.exports.captureSnapshot({ novelId: repositories.novel.id, selection: { chapterNumbers: [1] } });
  const builder = createEpubBuilder({
    exports: repositories.exports,
    exportRoot: repositories.exportRoot,
    writeArchive: async ({ temporaryFile }) => {
      await writeFile(temporaryFile, 'not an EPUB');
      throw new Error('writer failed');
    }
  });
  await assert.rejects(builder.build({ novelId: repositories.novel.id, exportId: snapshot.export.id }), /writer failed/);
  const failed = repositories.exports.getExportSnapshot({ novelId: repositories.novel.id, exportId: snapshot.export.id }).export;
  assert.equal(failed.state, 'failed');
  await assert.rejects(readFile(repositories.exportRoot.outputPath(snapshot.export.fileName)));
});
