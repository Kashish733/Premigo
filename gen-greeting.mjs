// Pre-records Notice's greeting with the same Gemini voice as the live conversation, so the greeting plays INSTANTLY when
// FaceTime is ready and never depends on the live model being fast at that moment (a silent first 10 s ends the call).
// Run: node --env-file=.env.local gen-greeting.mjs   -> assets/greeting.pcm (24 kHz, 16-bit, mono) and assets/greeting.txt
import { mkdirSync, writeFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';

export const GREETING_TEXT =
  'Hola, soy Notice, tu ayudante de IA. Hi, I am Notice, your AI helper. Te ayudo con tus documentos: llenarlos, entenderlos o revisarlos. ¿Qué necesitas? What do you need?';
const MODEL = process.env.TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const VOICE = process.env.VOICE_NAME || 'Aoede'; // same voice as the live agent (agent.mjs)

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
const res = await ai.models.generateContent({
  model: MODEL,
  contents: [{ role: 'user', parts: [{ text: `Say this warmly and at a natural, brisk, conversational pace with short pauses, like a friendly helper on a phone call. It mixes Spanish and English: ${GREETING_TEXT}` }] }],
  config: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } } },
});
const part = res.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
if (!part) { console.error('no audio came back'); process.exit(1); }
const raw = Buffer.from(part.inlineData.data, 'base64');
// Tidy the recording: cut silence at the ends and shorten long pauses (text-to-speech leaves a lot of both).
const RATE = 24000, WIN = 480; // 20 ms windows
const loud = [];
for (let i = 0; i + WIN * 2 <= raw.length; i += WIN * 2) { let m = 0; for (let k = 0; k < WIN; k++) m = Math.max(m, Math.abs(raw.readInt16LE(i + k * 2))); loud.push(m > 0.012 * 32768); }
const first = Math.max(0, loud.indexOf(true) - 3), last = Math.min(loud.length - 1, loud.lastIndexOf(true) + 6);
const keep = []; let quiet = 0;
for (let w = first; w <= last; w++) { quiet = loud[w] ? 0 : quiet + 1; if (quiet <= 12) keep.push(raw.subarray(w * WIN * 2, (w + 1) * WIN * 2)); } // pauses capped at 240 ms
const pcm = Buffer.concat(keep);
console.log(`raw ${(raw.length / (RATE * 2)).toFixed(1)} s -> tidied ${(pcm.length / (RATE * 2)).toFixed(1)} s`);
mkdirSync('assets', { recursive: true });
writeFileSync('assets/greeting.pcm', pcm);
writeFileSync('assets/greeting.txt', GREETING_TEXT);
let peak = 0; for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
console.log(`mime ${part.inlineData.mimeType} | ${pcm.length} bytes | ${(pcm.length / 48000).toFixed(1)} s at 24 kHz | peak level ${(peak / 32768).toFixed(2)}`);
