import { readFile } from 'node:fs/promises';
import { createChapterRepository } from '../src/chapters/chapter-repository.js';
import { openDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import { createLegacyCatalogImportService } from '../src/migration/legacy-catalog-import-service.js';
import { readLegacySnapshotData } from '../src/migration/legacy-snapshot.js';
import { createNovelRepository } from '../src/novels/novel-repository.js';
import { createSourceRepository } from '../src/sources/source-repository.js';

const [databasePath, directory, manifestPath, title] = process.argv.slice(2);

if (!databasePath || !directory || !manifestPath || !title || process.argv.length !== 6) {
  console.error('Usage: node scripts/import-legacy-catalog.js <database-path> <legacy-state-directory> <manifest-path> <novel-title>');
  process.exitCode = 2;
} else {
  let database;
  try {
    const [snapshot, manifest] = await Promise.all([
      readLegacySnapshotData(directory),
      readFile(manifestPath, 'utf8').then(JSON.parse)
    ]);
    database = openDatabase({ databasePath });
    migrate(database);
    const clock = () => new Date();
    const repositories = {
      novels: createNovelRepository(database, clock),
      chapters: createChapterRepository(database, clock),
      sources: createSourceRepository(database, clock)
    };
    const result = createLegacyCatalogImportService({ database, repositories, clock }).importManifest({
      ...snapshot,
      manifest,
      title
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    database?.close();
  }
}
