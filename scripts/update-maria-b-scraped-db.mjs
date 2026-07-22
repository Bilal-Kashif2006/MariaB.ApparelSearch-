import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const targetPath = path.resolve(process.cwd(), process.argv[2] ?? path.join('data', 'maria-b-scraped.db'));
const snapshotSource = process.argv[3] ? path.resolve(process.cwd(), process.argv[3]) : '';
const tempPath = `${targetPath}.next`;
const nodeBin = process.execPath;

function removeIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}

function cleanupSqliteSidecars(dbPath) {
  removeIfExists(`${dbPath}-shm`);
  removeIfExists(`${dbPath}-wal`);
}

function runOrThrow(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

cleanupSqliteSidecars(tempPath);
removeIfExists(tempPath);

const args = ['scripts/scrape-maria-b-shopify.mjs', '--output', tempPath];
if (snapshotSource) args.push('--snapshot-db', snapshotSource);
runOrThrow(nodeBin, args);

cleanupSqliteSidecars(targetPath);
removeIfExists(targetPath);
fs.renameSync(tempPath, targetPath);
cleanupSqliteSidecars(tempPath);

console.log(JSON.stringify({
  targetPath,
  sourceMode: snapshotSource ? 'snapshot-db' : 'live-shopify',
  snapshotSource: snapshotSource || null,
  refreshedAt: new Date().toISOString(),
}, null, 2));
