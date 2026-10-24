import { restoreLocalData } from '../src/storage/local-data-backup.js';

const [backupDirectory, dataDirectory] = process.argv.slice(2);

if (!backupDirectory || !dataDirectory || process.argv.length !== 4) {
  console.error('Usage: node scripts/restore-local-data.js <backup-directory> <new-data-directory>');
  process.exitCode = 2;
} else {
  try {
    process.stdout.write(`${JSON.stringify(await restoreLocalData({ backupDirectory, dataDirectory }), null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
