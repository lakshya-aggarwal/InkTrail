import { DatabaseSync } from 'node:sqlite';

export function openDatabase({ databasePath }) {
  const database = new DatabaseSync(databasePath);
  database.exec('pragma foreign_keys = on');
  return database;
}
