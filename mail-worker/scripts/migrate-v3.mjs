import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = readFileSync('src/init/init.js', 'utf8');
const start = source.indexOf('async v3_3DB(c)');
const end = source.indexOf('async v2_9DB(c)');
if (start < 0 || end <= start) throw new Error('V3 migration source was not found');

const statements = [...source.slice(start, end).matchAll(/`((?:ALTER TABLE|CREATE INDEX IF NOT EXISTS)[^`]+)`/g)]
  .map((match) => match[1].trim());
if (statements.length !== 44) throw new Error(`Unexpected V3 statement count: ${statements.length}`);

if (process.argv.includes('--check')) {
  console.log(`V3 migration source checked: ${statements.length} statements`);
  process.exit(0);
}

function wrangler(args) {
  try {
    return execFileSync('pnpm', ['exec', 'wrangler', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    let detail = String(error.stderr || '').slice(-2000);
    for (const name of ['JWT_SECRET', 'ADMIN', 'DOMAIN', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'D1_DATABASE_ID', 'KV_NAMESPACE_ID', 'CUSTOM_DOMAIN']) {
      const value = process.env[name];
      if (value) detail = detail.replaceAll(value, '[redacted]');
    }
    const stage = args.includes('--command') ? args[args.indexOf('--command') + 1] : args.includes('--file') ? 'migration file' : 'cache update';
    throw new Error(`Wrangler ${args[0]} failed at ${stage} with exit status ${error.status}: ${detail}`);
  }
}

function query(sql) {
  const output = wrangler(['d1', 'execute', 'db', '--remote', '-c', 'wrangler-action.toml', '--json', '--command', sql]);
  const result = JSON.parse(output);
  if (!Array.isArray(result) || result[0]?.success !== true) throw new Error('D1 query failed');
  return result[0].results;
}

const columns = new Map(['setting', 'email'].map((table) => {
  const rows = query(`PRAGMA table_info(${table})`);
  if (!rows.length) throw new Error(`Existing ${table} table was not found`);
  return [table, new Set(rows.map((row) => row.name))];
}));

const pending = [];
const expected = [];
for (const sql of statements) {
  const column = sql.match(/^ALTER TABLE (setting|email) ADD COLUMN (\w+)/);
  if (column) {
    expected.push([column[1], column[2]]);
    if (!columns.get(column[1]).has(column[2])) pending.push(sql);
  } else if (sql.startsWith('CREATE INDEX IF NOT EXISTS ')) {
    pending.push(sql);
  } else {
    throw new Error(`Unexpected V3 statement: ${sql}`);
  }
}

const temp = mkdtempSync(join(tmpdir(), 'cloud-mail-v3-'));
try {
  if (pending.length) {
    for (const sql of pending) {
      wrangler(['d1', 'execute', 'db', '--remote', '-c', 'wrangler-action.toml', '--command', sql, '--yes']);
    }
  }

  const verified = new Map(['setting', 'email'].map((table) => [
    table, new Set(query(`PRAGMA table_info(${table})`).map((row) => row.name)),
  ]));
  for (const [table, name] of expected) {
    if (!verified.get(table).has(name)) {
      throw new Error(`V3 column missing after migration: ${table}.${name}`);
    }
  }
  const indexes = new Set(query("SELECT name FROM sqlite_master WHERE type = 'index'").map((row) => row.name));
  for (const sql of statements) {
    const index = sql.match(/^CREATE INDEX IF NOT EXISTS (\w+)/);
    if (index && !indexes.has(index[1])) throw new Error(`V3 index missing: ${index[1]}`);
  }

  const row = query('SELECT * FROM setting LIMIT 1')[0];
  if (!row) throw new Error('Setting row was not found');
  const entity = readFileSync('src/entity/setting.js', 'utf8');
  const setting = {};
  for (const [, property, column] of entity.matchAll(/^\s*(\w+):\s*(?:integer|text)\('(\w+)'\)/gm)) {
    if (!(column in row)) throw new Error(`Setting column missing: ${column}`);
    setting[property] = row[column];
  }
  setting.resendTokens = JSON.parse(setting.resendTokens);
  const path = join(temp, 'setting.json');
  writeFileSync(path, JSON.stringify(setting), { mode: 0o600 });
  wrangler(['kv', 'key', 'put', 'setting:', '--binding', 'kv', '--remote', '-c', 'wrangler-action.toml', '--path', path]);
  console.log(`V3 schema verified and setting cache refreshed (${pending.length} statements applied)`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
