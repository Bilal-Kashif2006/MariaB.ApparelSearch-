import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';


const dumpArg = process.argv[2] ?? 'resham_dump (1).dump';
const outputArg = process.argv[3] ?? path.join('data', 'resham.db');


const dumpPath = path.resolve(process.cwd(), dumpArg);
const outputPath = path.resolve(process.cwd(), outputArg);


function readArchive(buf) {
  let offset = 0;


  const readBuf = (len) => {
    const slice = buf.subarray(offset, offset + len);
    if (slice.length !== len) throw new Error(`Unexpected EOF while reading ${len} bytes at ${offset}`);
    offset += len;
    return slice;
  };


  const readByte = () => readBuf(1)[0];


  const magic = readBuf(5).toString('ascii');
  if (magic !== 'PGDMP') throw new Error(`Unexpected archive signature: ${magic}`);


  const version = {
    major: readByte(),
    minor: readByte(),
    rev: readByte(),
  };
  const intSize = readByte();
  const offSize = readByte();
  const format = readByte();
  const compressionAlgorithm = readByte();


  const readInt = () => {
    const sign = readByte();
    let value = 0;
    let shift = 0;
    for (let i = 0; i < intSize; i += 1) {
      value += readByte() << shift;
      shift += 8;
    }
    return sign ? -value : value;
  };


  const readStr = () => {
    const len = readInt();
    if (len < 0) return null;
    return readBuf(len).toString('utf8');
  };


  const readOffset = () => {
    const state = readByte();
    let value = 0n;
    for (let i = 0; i < offSize; i += 1) {
      value |= BigInt(readByte()) << BigInt(i * 8);
    }
    return { state, value: Number(value) };
  };


  const readTimestamp = () => ({
    sec: readInt(),
    min: readInt(),
    hour: readInt(),
    mday: readInt(),
    mon: readInt(),
    year: readInt(),
    isdst: readInt(),
  });


  const timestamp = readTimestamp();
  const dbName = readStr();
  const remoteVersion = readStr();
  const dumpVersion = readStr();
  const tocCount = readInt();


  const archive = {
    version,
    intSize,
    offSize,
    format,
    compressionAlgorithm,
    timestamp,
    dbName,
    remoteVersion,
    dumpVersion,
    toc: [],
    dataStart: 0,
  };


  const versionAtLeast = (maj, min) =>
    version.major > maj || (version.major === maj && version.minor >= min);


  for (let i = 0; i < tocCount; i += 1) {
    const entry = {
      dumpId: readInt(),
      hadDumper: readInt(),
      catalogTableOid: null,
      catalogOid: null,
      tag: null,
      desc: null,
      section: null,
      defn: null,
      dropStmt: null,
      copyStmt: null,
      namespace: null,
      tablespace: null,
      tableam: null,
      relkind: null,
      owner: null,
      withOids: null,
      dependencies: [],
      dataPos: null,
      dataState: null,
    };


    if (versionAtLeast(1, 8)) entry.catalogTableOid = readStr();
    entry.catalogOid = readStr();
    entry.tag = readStr();
    entry.desc = readStr();
    if (versionAtLeast(1, 11)) entry.section = readInt();
    entry.defn = readStr();
    entry.dropStmt = readStr();
    if (versionAtLeast(1, 3)) entry.copyStmt = readStr();
    if (versionAtLeast(1, 6)) entry.namespace = readStr();
    if (versionAtLeast(1, 10)) entry.tablespace = readStr();
    if (versionAtLeast(1, 14)) entry.tableam = readStr();
    if (versionAtLeast(1, 16)) entry.relkind = readInt();
    entry.owner = readStr();
    if (versionAtLeast(1, 9)) entry.withOids = readStr();


    if (versionAtLeast(1, 5)) {
      for (;;) {
        const dep = readStr();
        if (dep == null) break;
        entry.dependencies.push(dep);
      }
    }


    const { state, value } = readOffset();
    entry.dataState = state;
    entry.dataPos = value;
    archive.toc.push(entry);
  }


  archive.dataStart = offset;
  return archive;
}


function extractColumns(copyStmt) {
  const match = copyStmt?.match(/^COPY\s+public\.([^\s]+)\s+\((.+)\)\s+FROM\s+stdin;\s*$/s);
  if (!match) return null;
  return {
    table: match[1],
    columns: match[2].split(',').map((part) => part.trim()),
  };
}


function parseColumnTypes(createTableSql) {
  if (!createTableSql) return new Map();
  const start = createTableSql.indexOf('(');
  const end = createTableSql.lastIndexOf(')');
  if (start < 0 || end < 0 || end <= start) return new Map();
  const inner = createTableSql.slice(start + 1, end);
  const lines = inner
    .split('\n')
    .map((line) => line.trim().replace(/,$/, ''))
    .filter(Boolean);


  const types = new Map();
  for (const line of lines) {
    if (line.startsWith('CONSTRAINT ') || line.startsWith('PRIMARY KEY') || line.startsWith('UNIQUE ') || line.startsWith('FOREIGN KEY')) {
      continue;
    }
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) continue;
    const column = line.slice(0, spaceIdx);
    const rest = line.slice(spaceIdx + 1);
    types.set(column, rest);
  }
  return types;
}


function sqliteTypeFromPg(pgType = '') {
  const normalized = pgType.toLowerCase();
  if (normalized.includes('boolean')) return 'INTEGER';
  if (normalized.includes('integer')) return 'INTEGER';
  if (normalized.includes('numeric')) return 'REAL';
  if (normalized.includes('double precision')) return 'REAL';
  if (normalized.includes('real')) return 'REAL';
  if (normalized.includes('json')) return 'TEXT';
  if (normalized.includes('timestamp')) return 'TEXT';
  if (normalized.includes('uuid')) return 'TEXT';
  if (normalized.includes('character varying')) return 'TEXT';
  if (normalized.includes('text')) return 'TEXT';
  if (normalized.includes('[]')) return 'TEXT';
  return 'TEXT';
}


function unescapeCopyField(value) {
  if (value === '\\N') return null;
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    i += 1;
    if (i >= value.length) {
      out += '\\';
      break;
    }
    const esc = value[i];
    switch (esc) {
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'v': out += '\v'; break;
      case '\\': out += '\\'; break;
      default:
        if (/[0-7]/.test(esc)) {
          let oct = esc;
          for (let j = 0; j < 2 && i + 1 < value.length && /[0-7]/.test(value[i + 1]); j += 1) {
            i += 1;
            oct += value[i];
          }
          out += String.fromCharCode(parseInt(oct, 8));
        } else {
          out += esc;
        }
    }
  }
  return out;
}


function coerceValue(raw, pgType = '') {
  if (raw == null) return null;
  const normalized = pgType.toLowerCase();
  if (normalized.includes('boolean')) return raw === 't' ? 1 : raw === 'f' ? 0 : raw;
  if (normalized.includes('integer')) {
    const n = Number.parseInt(raw, 10);
    return Number.isNaN(n) ? raw : n;
  }
  if (normalized.includes('numeric') || normalized.includes('double precision') || normalized.includes('real')) {
    const n = Number.parseFloat(raw);
    return Number.isNaN(n) ? raw : n;
  }
  return raw;
}


function readTableData(buf, entry, intSize, compressionAlgorithm) {
  let pos = entry.dataPos;
  if (!pos) return Buffer.alloc(0);
  const chunks = [];


  const readIntAt = () => {
    const sign = buf[pos];
    pos += 1;
    let value = 0;
    let shift = 0;
    for (let i = 0; i < intSize; i += 1) {
      value += buf[pos] << shift;
      pos += 1;
      shift += 8;
    }
    return sign ? -value : value;
  };


  const blockType = buf[pos];
  pos += 1;
  if (blockType !== 1) throw new Error(`Unexpected block type ${blockType} at ${entry.dataPos} for ${entry.tag}`);


  const dumpId = readIntAt();
  if (dumpId !== entry.dumpId) throw new Error(`Dump ID mismatch for ${entry.tag}: expected ${entry.dumpId}, got ${dumpId}`);


  for (;;) {
    const len = readIntAt();
    if (len === 0) break;
    const chunk = Buffer.from(buf.subarray(pos, pos + len));
    pos += len;
    chunks.push(chunk);
  }


  const payload = Buffer.concat(chunks);
  return compressionAlgorithm === 0 ? payload : zlib.inflateSync(payload);
}


function splitCopyRows(copyData) {
  const rows = [];
  let lineStart = 0;
  for (let i = 0; i < copyData.length; i += 1) {
    if (copyData[i] !== 0x0a) continue;
    const lineEnd = i > lineStart && copyData[i - 1] === 0x0d ? i - 1 : i;
    const line = copyData.subarray(lineStart, lineEnd);
    lineStart = i + 1;
    if (line.length === 0) continue;
    const text = line.toString('utf8');
    if (text === '\\.') break;
    rows.push(text);
  }
  return rows;
}


function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}


function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}


function buildSqliteDb(archive, buf, targetPath) {
  ensureParentDir(targetPath);
  if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
  const db = new DatabaseSync(targetPath);
  const counts = [];


  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');


    const tableEntries = archive.toc.filter((entry) => entry.desc === 'TABLE' && entry.namespace === 'public');
    const dataEntries = archive.toc.filter((entry) => entry.desc === 'TABLE DATA' && entry.namespace === 'public' && entry.copyStmt?.startsWith('COPY public.'));


    const schemaByTable = new Map(tableEntries.map((entry) => [entry.tag, entry]));


    db.exec('BEGIN');
    for (const entry of dataEntries) {
      const copyInfo = extractColumns(entry.copyStmt);
      if (!copyInfo) continue;


      const schemaEntry = schemaByTable.get(copyInfo.table);
      const columnTypes = parseColumnTypes(schemaEntry?.defn);
      const columnSql = copyInfo.columns
        .map((col) => `${quoteIdent(col)} ${sqliteTypeFromPg(columnTypes.get(col))}`)
        .join(', ');
      db.exec(`CREATE TABLE ${quoteIdent(copyInfo.table)} (${columnSql});`);


      const placeholders = copyInfo.columns.map(() => '?').join(', ');
      const insert = db.prepare(
        `INSERT INTO ${quoteIdent(copyInfo.table)} (${copyInfo.columns.map(quoteIdent).join(', ')}) VALUES (${placeholders})`,
      );


      const rows = splitCopyRows(readTableData(buf, entry, archive.intSize, archive.compressionAlgorithm));
      for (const row of rows) {
        const values = row.split('\t').map((field, idx) => {
          const unescaped = unescapeCopyField(field);
          return coerceValue(unescaped, columnTypes.get(copyInfo.columns[idx]));
        });
        insert.run(...values);
      }
      counts.push({ table: copyInfo.table, rows: rows.length });
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.close();
  }


  return counts;
}


function readBrandsFromSqlite(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT name, slug, domain, department FROM brands ORDER BY name').all();
  } finally {
    db.close();
  }
}


const archiveBuffer = fs.readFileSync(dumpPath);
const archive = readArchive(archiveBuffer);
const counts = buildSqliteDb(archive, archiveBuffer, outputPath);
const brands = readBrandsFromSqlite(outputPath);


console.log(JSON.stringify({
  dumpPath,
  outputPath,
  archive: {
    dbName: archive.dbName,
    version: `${archive.version.major}.${archive.version.minor}.${archive.version.rev}`,
    remoteVersion: archive.remoteVersion,
    dumpVersion: archive.dumpVersion,
    tocEntries: archive.toc.length,
  },
  tableCounts: counts,
  brands,
}, null, 2));