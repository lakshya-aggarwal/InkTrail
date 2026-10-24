import { readLegacySnapshot } from '../src/migration/legacy-snapshot.js';

const directory = process.argv[2];

if (!directory || process.argv.length !== 3) {
  console.error('Usage: node scripts/inspect-legacy-snapshot.js <legacy-state-directory>');
  process.exitCode = 2;
} else {
  try {
    const report = await readLegacySnapshot(directory);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
