import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(`Wrangler ${args[0]} read failed with exit status ${error.status}`);
  }
}

function query(sql) {
  const output = wrangler(['d1', 'execute', 'db', '--remote', '-c', 'wrangler-action.toml', '--json', '--command', sql]);
  const result = JSON.parse(output);
  if (!Array.isArray(result) || result[0]?.success !== true) throw new Error('D1 query failed');
  return result[0].results;
}

const columns = new Map(['setting', 'email'].map((table) => [
  table, new Set(query(`PRAGMA table_info(${table})`).map((row) => row.name)),
]));
const indexes = new Set(query("SELECT name FROM sqlite_master WHERE type = 'index'").map((row) => row.name));
const entity = readFileSync('src/entity/setting.js', 'utf8');
const settingNames = new Map([...entity.matchAll(/^\s*(\w+):\s*(?:integer|text)\('(\w+)'\)/gm)]
  .map(([, property, column]) => [column, property]));
const newSettingColumns = [];

for (const sql of statements) {
  const column = sql.match(/^ALTER TABLE (setting|email) ADD COLUMN (\w+)/);
  const index = sql.match(/^CREATE INDEX IF NOT EXISTS (\w+)/);
  if (column) {
    if (!columns.get(column[1])?.has(column[2])) throw new Error(`V3 column pending: ${column[1]}.${column[2]}`);
    if (column[1] === 'setting') newSettingColumns.push(column[2]);
  } else if (index) {
    if (!indexes.has(index[1])) throw new Error(`V3 index pending: ${index[1]}`);
  } else {
    throw new Error(`Unexpected V3 statement: ${sql}`);
  }
}
const cached = JSON.parse(wrangler(['kv', 'key', 'get', 'setting:', '--binding', 'kv', '--remote', '-c', 'wrangler-action.toml', '--text']));
for (const column of newSettingColumns) {
  if (!(settingNames.get(column) in cached)) throw new Error(`Setting cache pending: ${column}`);
}
console.log('V3 D1 schema and setting cache verified');
