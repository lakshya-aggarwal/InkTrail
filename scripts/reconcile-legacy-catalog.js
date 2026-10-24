import { createLegacyCatalogReconciliationManifest } from '../src/migration/legacy-catalog-reconciliation.js';
import { readLegacySnapshotData } from '../src/migration/legacy-snapshot.js';
import { createKujiangAdapter } from '../src/sources/kujiang-adapter.js';

const [directory, bookUrl] = process.argv.slice(2);

if (!directory || !bookUrl || process.argv.length !== 4) {
  console.error('Usage: node scripts/reconcile-legacy-catalog.js <legacy-state-directory> <kujiang-book-url>');
  process.exitCode = 2;
} else {
  try {
    const snapshot = await readLegacySnapshotData(directory);
    const catalog = await createKujiangAdapter({ fetch: globalThis.fetch }).fetchCatalog(bookUrl);
    const manifest = createLegacyCatalogReconciliationManifest({ ...snapshot, catalog });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
