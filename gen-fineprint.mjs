// Test pages for small print and scam detection. Run: node gen-fineprint.mjs
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';
const W = 960, H = 540;
const t = (x, y, s, size = 14, extra = '') => `<text x="${x}" y="${y}" font-family="Helvetica" font-size="${size}" ${extra}>${s.replace(/&/g, '&amp;')}</text>`;
const page = body => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#e5e7eb"/><rect x="150" y="10" width="660" height="520" fill="#fff" stroke="#9ca3af"/>${body}</svg>`;

const scam = page([
  t(480, 52, 'FINAL NOTICE - TOLL VIOLATION', 24, 'text-anchor="middle" font-weight="700" fill="#b91c1c"'),
  t(180, 100, 'Our records show an unpaid toll balance of $49.80 on your vehicle.', 15),
  t(180, 126, 'To avoid a $500 fine and suspension of your license, you must pay', 15),
  t(180, 148, 'within 24 HOURS. Failure to respond will lead to legal action.', 15),
  t(180, 200, 'Pay now using ANY of these methods:', 15, 'font-weight="700"'),
  t(200, 228, '- Gift cards (Google Play, Apple): send the card numbers to 555-0199', 14),
  t(200, 252, '- Zelle or Cash App to $TollPayNow', 14),
  t(200, 276, '- Or verify your identity at tollpay-secure.example.net: enter your', 14),
  t(214, 296, 'Social Security number and bank login to release the hold.', 14),
  t(180, 340, 'Do not contact your state toll agency. This notice is confidential.', 14),
  t(480, 515, 'State Toll Services Dept. (not affiliated with any government agency)', 9, 'text-anchor="middle" fill="#777"'),
].join(''));

const school = page([
  t(480, 48, 'Summer Camp Registration', 24, 'text-anchor="middle" font-weight="700"'),
  t(480, 72, 'Maplewood Community Center - Ages 6 to 12', 13, 'text-anchor="middle" fill="#444"'),
  t(180, 130, 'Child name: ______________________   Age: ______', 14),
  t(180, 175, 'Parent/guardian: ______________________   Phone: ______________', 14),
  t(180, 220, 'Session:  [ ] June 8-19    [ ] July 6-17', 14),
  t(180, 330, 'Parent signature: ______________________   Date: __________', 14),
  t(180, 440, '* Registration fee of $85 is non-refundable. Balance due by May 15 or the spot is released.', 9.5, 'fill="#444"'),
  t(180, 456, '* By signing, I release Maplewood and its staff from all liability, including injury, and agree to', 9.5, 'fill="#444"'),
  t(180, 470, '  binding arbitration. I allow photos of my child to be used on social media and in ads.', 9.5, 'fill="#444"'),
  t(180, 486, '* Bring a signed medical form and a packed lunch on the first day. Late pickup costs $5 per minute.', 9.5, 'fill="#444"'),
].join(''));

for (const [name, svg] of [['scam', scam], ['camp', school]]) {
  writeFileSync(`forms/${name}.png`, await sharp(Buffer.from(svg)).png().toBuffer());
  console.log('wrote', `forms/${name}.png`);
}
