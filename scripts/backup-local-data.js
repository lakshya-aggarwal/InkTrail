import { backupLocalData } from '../src/storage/local-data-backup.js';

const [dataDirectory, backupDirectory] = process.argv.slice(2);

if (!dataDirectory || !backupDirectory || process.argv.length !== 4) {
  console.error('Usage: node scripts/backup-local-data.js <data-directory> <new-backup-directory>');
  process.exitCode = 2;
} else {
  try {
    process.stdout.write(`${JSON.stringify(await backupLocalData({ dataDirectory, backupDirectory }), null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
