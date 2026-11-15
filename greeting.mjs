// The pre-recorded greeting (made by gen-greeting.mjs). It is played with session.say() the instant FaceTime is ready,
// so the call never starts with silence, even when the live model is slow or overloaded. The text is added to the
// conversation, so the live model knows it already greeted and asked what the caller needs.
import { existsSync, readFileSync } from 'node:fs';
import { AudioFrame } from '@livekit/rtc-node';

const PCM = new URL('./assets/greeting.pcm', import.meta.url);
const TXT = new URL('./assets/greeting.txt', import.meta.url);
const RATE = 24000, FRAME = 480; // 24 kHz mono, 20 ms frames

/** @returns {{ text: string, seconds: number, stream: () => ReadableStream<AudioFrame> } | null} null if the recording is missing */
export function loadGreeting() {
  if (!existsSync(PCM)) return null;
  const buf = readFileSync(PCM);
  const samples = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length - (buf.length % 2)));
  const text = existsSync(TXT) ? readFileSync(TXT, 'utf8').trim() : 'Hola, soy Notice. Hi, I am Notice.';
  return {
    text,
    seconds: samples.length / RATE,
    stream: () => {
      let i = 0;
      return new ReadableStream({
        pull(controller) {
          if (i >= samples.length) return controller.close();
          const chunk = samples.slice(i, i + FRAME);
          i += FRAME;
          controller.enqueue(new AudioFrame(chunk, RATE, 1, chunk.length));
        },
      });
    },
  };
}
