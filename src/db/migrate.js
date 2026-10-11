import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

function migrationFiles() {
  return readdirSync(migrationsDirectory)
    .map((name) => ({ name, match: /^(\d+)-.+\.sql$/.exec(name) }))
    .filter(({ match }) => match)
    .map(({ name, match }) => ({ name, version: Number(match[1]) }))
    .sort((left, right) => left.version - right.version);
}

function appliedVersions(database) {
  const migrationTable = database.prepare("select 1 from sqlite_master where type = 'table' and name = 'schema_migrations'").get();
  if (!migrationTable) {
    return new Set();
  }

  return new Set(database.prepare('select version from schema_migrations').all().map(({ version }) => version));
}

export function migrate(database) {
  database.exec('begin immediate');
  try {
    const applied = appliedVersions(database);
    for (const migration of migrationFiles()) {
      if (applied.has(migration.version)) {
        continue;
      }

      database.exec(readFileSync(join(migrationsDirectory, migration.name), 'utf8'));
      database.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(migration.version, new Date().toISOString());
    }
    database.exec('commit');
  } catch (error) {
    database.exec('rollback');
    throw error;
  }
}
