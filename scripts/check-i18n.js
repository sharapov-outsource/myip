/**
 * Verifies that every translation dictionary is consistent: the same set of keys,
 * an endonym and a locale for each language, and placeholders such as {name}
 * matching the English reference.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = { window: {} };
vm.createContext(context);
vm.runInContext(readFileSync(path.join(root, 'public/i18n.js'), 'utf8'), context);

const { I18N, LANG_NAMES, LANG_LOCALES, RTL_LANGS } = context.window;
const problems = [];

if (!I18N || !Object.keys(I18N).length) {
  console.error('i18n.js did not define window.I18N');
  process.exit(1);
}

const reference = Object.keys(I18N.en);
const placeholders = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

for (const [lang, dict] of Object.entries(I18N)) {
  for (const key of reference) {
    if (!(key in dict)) problems.push(`${lang}: missing key ${key}`);
    else if (typeof dict[key] !== 'string') problems.push(`${lang}.${key}: value is not a string`);
    else if (!dict[key].trim()) problems.push(`${lang}.${key}: empty string`);
    else if (placeholders(dict[key]) !== placeholders(I18N.en[key])) {
      problems.push(`${lang}.${key}: placeholders "${placeholders(dict[key])}" != "${placeholders(I18N.en[key])}"`);
    }
  }
  for (const key of Object.keys(dict)) {
    if (!reference.includes(key)) problems.push(`${lang}: unexpected key ${key}`);
  }
  if (!LANG_NAMES?.[lang]) problems.push(`${lang}: no entry in LANG_NAMES`);
  if (!LANG_LOCALES?.[lang]) problems.push(`${lang}: no entry in LANG_LOCALES`);
}

for (const lang of RTL_LANGS || []) {
  if (!I18N[lang]) problems.push(`RTL_LANGS points at a missing language: ${lang}`);
}

// Keys the markup expects to exist.
const html = readFileSync(path.join(root, 'public/index.html'), 'utf8');
for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) {
  if (!reference.includes(m[1])) problems.push(`index.html references a missing key: ${m[1]}`);
}

if (problems.length) {
  console.error('Translation problems found:');
  problems.forEach(p => console.error('  · ' + p));
  process.exit(1);
}

console.log(`Translations are consistent: ${Object.keys(I18N).length} languages x ${reference.length} keys.`);
