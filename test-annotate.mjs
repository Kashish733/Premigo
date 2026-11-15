// Offline test of the overlay: no model, no call. Run: node test-annotate.mjs
// Writes out/permiso-*.png using the ground-truth fields from gen-forms.mjs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { annotateToPng } from './annotate.mjs';
import { sharpness } from './vision.mjs';

mkdirSync('out', { recursive: true });
const img = readFileSync('forms/permiso.png');
const state = JSON.parse(readFileSync('forms/permiso.json', 'utf8'));
console.log('sharpness of clean form:', Math.round(await sharpness(img)));

const cases = {
  'permiso-current-es': { currentField: 'guardian', lang: 'es', banner: 'Aquí va SU nombre (el del padre o tutor)' },
  'permiso-current-en': { currentField: 'guardian', lang: 'en', banner: 'Write YOUR name here (the parent/guardian)' },
  'permiso-mistake': { currentField: 'signature', issues: { date: 'Falta la fecha / Date is empty' }, lang: 'es', banner: 'Casi listo: revise la fecha' },
  'permiso-all': { showAll: true, lang: 'es', banner: 'Campos del formulario' },
};
for (const [name, opts] of Object.entries(cases)) {
  writeFileSync(`out/${name}.png`, await annotateToPng(img, state, opts));
  console.log('wrote', `out/${name}.png`);
}
