// Generates two printable demo forms (PNG) plus ground-truth DocState JSON for testing the overlay
// without calling any model. Run: node gen-forms.mjs   -> forms/permiso.png, forms/intake.png (+ .json)
import { writeFileSync, mkdirSync } from 'node:fs';
import sharp from 'sharp';

const W = 960, H = 540;
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function build({ file, title, subtitle, fields, footer }) {
  const parts = [`<rect width="${W}" height="${H}" fill="#e5e7eb"/>`, `<rect x="150" y="10" width="660" height="520" fill="#fff" stroke="#9ca3af"/>`];
  parts.push(`<text x="480" y="48" text-anchor="middle" font-family="Helvetica" font-size="24" font-weight="700" fill="#111">${esc(title)}</text>`);
  parts.push(`<text x="480" y="72" text-anchor="middle" font-family="Helvetica" font-size="13" fill="#444">${esc(subtitle)}</text>`);
  const state = { doc_type: title, fields: [] };
  for (const f of fields) {
    const [x, y, w, h] = f.box; // pixels on the 960x540 canvas
    if (f.kind === 'check') {
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff" stroke="#111" stroke-width="2"/>`);
      parts.push(`<text x="${x + w + 10}" y="${y + h - 4}" font-family="Helvetica" font-size="13" fill="#111">${esc(f.text)}</text>`);
    } else {
      parts.push(`<text x="${x}" y="${y - 6}" font-family="Helvetica" font-size="12" fill="#333">${esc(f.text)}</text>`);
      parts.push(`<line x1="${x}" y1="${y + h}" x2="${x + w}" y2="${y + h}" stroke="#111" stroke-width="1.5"/>`);
    }
    state.fields.push({
      id: f.id, label_en: f.en, label_es: f.es, hint_en: f.hint_en, hint_es: f.hint_es,
      bbox: [x / W, y / H, w / W, h / H], filled: false, value: null,
    });
  }
  parts.push(`<text x="480" y="515" text-anchor="middle" font-family="Helvetica" font-size="11" fill="#666">${esc(footer)}</text>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join('')}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer().then(png => {
    writeFileSync(`forms/${file}.png`, png);
    writeFileSync(`forms/${file}.json`, JSON.stringify(state, null, 2));
    console.log(`wrote forms/${file}.png (${state.fields.length} fields)`);
  });
}

mkdirSync('forms', { recursive: true });

await build({
  file: 'permiso',
  title: 'Permiso para Excursión Escolar',
  subtitle: 'Escuela Primaria Lincoln · Devolver antes del 20 de noviembre',
  footer: 'Visita al Museo de Ciencias el 5 de diciembre. Costo: $12 por estudiante.',
  fields: [
    { id: 'student_name', kind: 'line', box: [180, 120, 360, 22], text: 'Nombre del estudiante', en: 'Student name', es: 'Nombre del estudiante', hint_en: 'Write your child\'s full name.', hint_es: 'Escriba el nombre completo de su hijo/a.' },
    { id: 'grade', kind: 'line', box: [580, 120, 200, 22], text: 'Grado', en: 'Grade', es: 'Grado', hint_en: 'Write your child\'s grade, like 3rd.', hint_es: 'Escriba el grado, por ejemplo 3.°.' },
    { id: 'guardian', kind: 'line', box: [180, 190, 360, 22], text: 'Nombre del padre/madre o tutor', en: 'Parent/guardian name', es: 'Nombre del padre/madre o tutor', hint_en: 'Write YOUR name.', hint_es: 'Escriba SU nombre.' },
    { id: 'phone', kind: 'line', box: [580, 190, 200, 22], text: 'Teléfono', en: 'Phone', es: 'Teléfono', hint_en: 'A number where the school can reach you.', hint_es: 'Un número donde la escuela pueda llamarle.' },
    { id: 'allergies', kind: 'line', box: [180, 260, 600, 22], text: 'Alergias o condiciones médicas', en: 'Allergies / medical conditions', es: 'Alergias o condiciones médicas', hint_en: 'List allergies, or write "none".', hint_es: 'Escriba las alergias, o "ninguna".' },
    { id: 'authorize', kind: 'check', box: [180, 320, 20, 20], text: 'Sí, autorizo a mi hijo/a a participar en la excursión.', en: 'Yes, I authorize my child to go', es: 'Sí, autorizo', hint_en: 'Check this box to give permission.', hint_es: 'Marque esta casilla para dar permiso.' },
    { id: 'decline', kind: 'check', box: [180, 360, 20, 20], text: 'No, no autorizo.', en: 'No, I do not authorize', es: 'No autorizo', hint_en: 'Check this box to refuse.', hint_es: 'Marque esta casilla para negar el permiso.' },
    { id: 'signature', kind: 'line', box: [180, 440, 360, 22], text: 'Firma del padre/madre o tutor', en: 'Parent/guardian signature', es: 'Firma', hint_en: 'Sign here. Do not sign for the date.', hint_es: 'Firme aquí.' },
    { id: 'date', kind: 'line', box: [580, 440, 200, 22], text: 'Fecha', en: 'Date', es: 'Fecha', hint_en: 'Today\'s date: month/day/year.', hint_es: 'La fecha de hoy: mes/día/año.' },
  ],
});

await build({
  file: 'intake',
  title: 'New Patient Intake Form',
  subtitle: 'Riverside Family Clinic · Please print clearly',
  footer: 'Bring your insurance card and photo ID to your first visit.',
  fields: [
    { id: 'full_name', kind: 'line', box: [180, 120, 360, 22], text: 'Full legal name', en: 'Full legal name', es: 'Nombre legal completo', hint_en: 'Your name as on your ID.', hint_es: 'Su nombre como aparece en su identificación.' },
    { id: 'dob', kind: 'line', box: [580, 120, 200, 22], text: 'Date of birth (MM/DD/YYYY)', en: 'Date of birth', es: 'Fecha de nacimiento', hint_en: 'Month/day/year.', hint_es: 'Mes/día/año.' },
    { id: 'address', kind: 'line', box: [180, 190, 600, 22], text: 'Home address', en: 'Home address', es: 'Domicilio', hint_en: 'Street, city, ZIP.', hint_es: 'Calle, ciudad, código postal.' },
    { id: 'insurance', kind: 'line', box: [180, 260, 360, 22], text: 'Insurance provider & member ID', en: 'Insurance provider & ID', es: 'Seguro médico e ID', hint_en: 'Copy from your insurance card.', hint_es: 'Copie de su tarjeta del seguro.' },
    { id: 'medications', kind: 'line', box: [180, 330, 600, 22], text: 'Current medications', en: 'Current medications', es: 'Medicamentos actuales', hint_en: 'List everything you take, or "none".', hint_es: 'Liste todo lo que toma, o "ninguno".' },
    { id: 'consent', kind: 'check', box: [180, 390, 20, 20], text: 'I consent to treatment and agree to the privacy policy.', en: 'I consent to treatment', es: 'Doy mi consentimiento', hint_en: 'Check to consent to treatment.', hint_es: 'Marque para dar su consentimiento.' },
    { id: 'signature', kind: 'line', box: [180, 450, 360, 22], text: 'Signature', en: 'Signature', es: 'Firma', hint_en: 'Sign here.', hint_es: 'Firme aquí.' },
    { id: 'date', kind: 'line', box: [580, 450, 200, 22], text: 'Date', en: 'Date', es: 'Fecha', hint_en: 'Today\'s date.', hint_es: 'La fecha de hoy.' },
  ],
});
