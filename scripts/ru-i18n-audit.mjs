import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = 'apps/dashboard/src/i18n/locales';
const enDir = path.join(root, 'en');
const ruDir = path.join(root, 'ru');
const namespaces = fs.readdirSync(enDir).filter((f) => f.endsWith('.json')).sort();

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, p, out);
    else out[p] = v;
  }
  return out;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function oldEnglish(ns) {
  const p = `${root}/en/${ns}`;
  try {
    return JSON.parse(execFileSync('git', ['show', `origin/main:${p}`], { encoding: 'utf8' }));
  } catch {
    return {};
  }
}

let totalMissing = 0;
let totalExtra = 0;
let totalChanged = 0;
for (const ns of namespaces) {
  const en = flatten(readJson(path.join(enDir, ns)));
  const ru = flatten(readJson(path.join(ruDir, ns)));
  const old = flatten(oldEnglish(ns));
  const missing = Object.keys(en).filter((k) => !(k in ru));
  const extra = Object.keys(ru).filter((k) => !(k in en));
  const changed = Object.keys(en).filter((k) => k in old && JSON.stringify(en[k]) !== JSON.stringify(old[k]));
  const added = Object.keys(en).filter((k) => !(k in old));
  if (missing.length || extra.length || changed.length || added.length) {
    console.log(`\n### ${ns}`);
    if (missing.length) console.log('MISSING', JSON.stringify(missing));
    if (extra.length) console.log('EXTRA', JSON.stringify(extra));
    if (changed.length) console.log('CHANGED', JSON.stringify(changed));
    if (added.length) console.log('ADDED', JSON.stringify(added));
  }
  totalMissing += missing.length;
  totalExtra += extra.length;
  totalChanged += new Set([...changed, ...added]).size;
}
console.log(`\nTOTAL missing=${totalMissing} extra=${totalExtra} changed_or_added=${totalChanged}`);
