// Offline test: a 16:9 frame with a small portrait picture and black bars (like the FaceTime frames). Run: node test-frame.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { makeBarCropper } from './frame.mjs';
const W = 1280, H = 720;
const page = await sharp(readFileSync('forms/permiso.png')).resize(390, 720, { fit: 'fill' }).png().toBuffer(); // portrait picture
const frame = await sharp({ create: { width: W, height: H, channels: 3, background: '#000' } }).composite([{ input: page, left: 60, top: 0 }]).png().toBuffer();
const { data, info } = await sharp(frame).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const crop = makeBarCropper();
const out = await crop({ raw: data, width: info.width, height: info.height });
console.log(`input ${info.width}x${info.height} -> cropped ${out.width}x${out.height} (expected about 390x720)`);
// a full-frame picture with dark corners must NOT be cropped
const full = await sharp({ create: { width: W, height: H, channels: 3, background: '#808080' } }).png().toBuffer();
const f2 = await sharp(full).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const o2 = await makeBarCropper()({ raw: f2.data, width: f2.info.width, height: f2.info.height });
console.log(`full picture ${f2.info.width}x${f2.info.height} -> ${o2.width}x${o2.height} (expected unchanged)`);
writeFileSync('out/cropped-frame.png', await sharp(out.raw, { raw: { width: out.width, height: out.height, channels: 4 } }).png().toBuffer());
