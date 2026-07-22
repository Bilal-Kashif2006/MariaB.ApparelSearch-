import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sourcePath = path.resolve(process.cwd(), process.argv[2] ?? path.join('data', 'resham.db'));
const targetPath = path.resolve(process.cwd(), process.argv[3] ?? path.join('data', 'maria-b.db'));
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

runOrThrow(nodeBin, ['scripts/export-brand-db.mjs', sourcePath, 'maria-b', tempPath]);
runOrThrow(nodeBin, ['--experimental-strip-types', 'scripts/classify-maria-b-occasion-rules.ts', tempPath]);

cleanupSqliteSidecars(targetPath);
removeIfExists(targetPath);
fs.renameSync(tempPath, targetPath);
cleanupSqliteSidecars(tempPath);

console.log(JSON.stringify({
  sourcePath,
  targetPath,
  refreshedAt: new Date().toISOString(),
}, null, 2));
