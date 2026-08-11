/**
 * Verifies the dictionaries. The checks live in the service kit, which loads
 * the shared dictionary before this service's own — the two are layered, and
 * checking either half alone would report the other half as missing.
 *
 * There is no runtime-code check here: a lookup carries no machine codes. The
 * upstream already answers in the requested language, so what needs verifying
 * is the interface vocabulary and nothing beyond it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkTranslations } from '@sharapov/service-kit/check-i18n';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { problems, notes, languages, keys, translated } = checkTranslations({ root });

if (problems.length) {
  console.error('Translation problems found:');
  problems.forEach(problem => console.error('  · ' + problem));
  process.exit(1);
}

notes.forEach(note => console.log('  note: ' + note));
console.log(`Translations are consistent: ${languages} languages x ${keys} keys ` +
  `(service vocabulary translated in ${translated}).`);
