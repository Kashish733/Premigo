import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { AutoSubscribe, defineAgent, llm, voice } from '@livekit/agents';
import { realtime } from '@livekit/agents-plugin-google';
import { LocalVideoTrack, RoomEvent, TrackKind, TrackSource, VideoBufferType, VideoFrame, VideoSource, VideoStream } from '@livekit/rtc-node';
import sharp from 'sharp';
import { z } from 'zod';
import { annotateFrame, HEIGHT, WIDTH } from './annotate.mjs';
import { readDocument, reviewDocument, sharpness, visionProvider } from './vision.mjs';
import { runAgent } from './chert-rooms.mjs';
import { greetOnBridgeReady } from './greet.mjs';

const RENDER_FPS = 6; // overlay frames per second sent back to the caller
const MIN_SHARPNESS = 15; // below this the page is too blurry to read
// NOTICE_MOCK=1 skips the vision model and "reads" forms/permiso.json instead: handy for testing the call without a page.
const MOCK = process.env.NOTICE_MOCK === '1';

const instructions = `You are Notice, a friendly AI helper on a FaceTime video call for people who struggle with
English or Spanish paperwork (school notices, clinic forms, work documents).
You cannot see the camera yourself. You see the page only through your tools.
How to work:
1. When the caller shows a page, call read_page. Then explain in simple words what the document is and what they must do.
2. Walk them through it one field at a time. For each field call highlight_field, then tell them what to write there.
3. While they write, the system checks the page for you. When a mistake is found you will be asked to tell the caller: do it kindly in one short sentence, say how to fix it, and do not call tools for it.
   Call read_page again only when they show a new page or ask you to look again.
4. If the page is blurry or missing, ask them to hold it steady in front of the camera.
Always answer in the language the caller speaks to you, Spanish or English. If unsure, use Spanish.
Keep each reply to one or two short sentences. Say you are an AI. Never give legal or medical advice.`;
// Said once, as soon as FaceTime is ready. Keep it short: it is the first thing the caller hears.
const greeting = 'Greet the caller in one short sentence in both Spanish and English: say you are Notice, an AI helper, and ask them to hold their form up to the camera. Hola, soy Notice.';

const agent = defineAgent({
  entry: async ctx => {
    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);
    // Chert prepares a room before a caller exists. Join promptly so Chert can
    // find us, but wait before opening a paid model session or sending video.
    const caller = await ctx.waitForParticipant();

    // ---- Shared state: latest camera frame, what we know about the page, what to draw ----
    let latest = null; // newest VideoFrame from the caller's camera
    let doc = null; // DocState from read_page
    const ui = { currentField: undefined, issues: {}, lang: 'en', banner: 'Muestre su formulario a la cámara · Hold your form up' };
    // Mistake watcher state: how many checks in a row saw each issue, and which ones we already said aloud.
    const seen = new Map(); // field_id -> consecutive checks that reported it
    const spoken = new Set(); // field_ids the caller has already been told about
    let agentState = 'initializing';

    // ---- Read the caller's camera ----
    const watched = new Set();
    const watch = track => {
      if (track.kind !== TrackKind.KIND_VIDEO || watched.has(track.sid)) return;
      watched.add(track.sid);
      (async () => { for await (const ev of new VideoStream(track)) latest = ev.frame; })().catch(() => {});
    };
    ctx.room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => { if (participant.identity === caller.identity) watch(track); });
    for (const pub of caller.trackPublications.values()) if (pub.track) watch(pub.track);

    const currentPng = async () => {
      if (!latest) return null;
      const f = latest.convert(VideoBufferType.RGBA);
      return sharp(f.data, { raw: { width: f.width, height: f.height, channels: 4 } }).png().toBuffer();
    };

    // ---- Send annotated video back: one camera track published by this agent ----
    const source = new VideoSource(WIDTH, HEIGHT);
    const track = LocalVideoTrack.createVideoTrack('agent-video', source);
    const idle = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#0f172a' } }).png().toBuffer();
    let busy = false;
    const render = async () => {
      if (busy) return;
      busy = true;
      try {
        let rgba;
        if (latest) {
          const f = latest.convert(VideoBufferType.RGBA);
          rgba = await annotateFrame({ raw: f.data, width: f.width, height: f.height }, doc, ui);
        } else {
          rgba = await annotateFrame(idle, null, ui);
        }
        source.captureFrame(new VideoFrame(rgba, WIDTH, HEIGHT, VideoBufferType.RGBA));
      } catch (err) {
        console.error('render failed', err?.message);
      } finally {
        busy = false;
      }
    };
    await render();
    await ctx.room.localParticipant.publishTrack(track, { source: TrackSource.SOURCE_CAMERA });
    const timer = setInterval(render, 1000 / RENDER_FPS);

    // ---- Tools the voice model can call ----
    const fieldList = () => (doc?.fields ?? []).map(f => `- ${f.id}: ${f.label_en} / ${f.label_es}${f.filled ? ` [filled: ${JSON.stringify(f.value)}]` : ' [empty]'}`).join('\n');
    const findField = id => doc?.fields?.find(f => f.id === id);
    const tools = {
      read_page: llm.tool({
        description: 'Look at the page the caller is holding up to the camera. Returns what the document is, what to do, and each field with whether it is filled. Call it when a page is shown and again after the caller writes something.',
        parameters: z.object({}),
        execute: async () => {
          if (MOCK) {
            doc = JSON.parse(readFileSync(new URL('./forms/permiso.json', import.meta.url), 'utf8'));
            doc.summary_en = 'A school field trip permission slip. Sign it and return it by November 20. The trip costs $12.';
            return `${doc.summary_en}\nFields:\n${fieldList()}`;
          }
          const png = await currentPng();
          if (!png) return 'No camera image yet. Ask the caller to turn on their video and hold the page up.';
          const blur = await sharpness(png);
          console.log('read_page sharpness', Math.round(blur), 'provider', visionProvider());
          if (blur < MIN_SHARPNESS) return 'The image is too blurry to read. Ask the caller to hold the page steady and closer.';
          if (!visionProvider()) return 'Vision is not configured (no GOOGLE_API_KEY or ANTHROPIC_API_KEY).';
          doc = await readDocument(png);
          if (!doc.fields.length) return 'No readable page is visible. Ask the caller to show the whole page, well lit.';
          ui.issues = {}; seen.clear(); spoken.clear();
          return `Document:${doc.doc_type} (${doc.language ?? '?'}).\nSummary: ${doc.summary_en}\nSummary (es): ${doc.summary_es}\nFields:\n${fieldList()}`;
        },
      }),
      highlight_field: llm.tool({
        description: 'Draw a box and a label on the caller\'s screen around one field of the form, to show where to write.',
        parameters: z.object({
          field_id: z.string().describe('id of the field from read_page'),
          language: z.enum(['es', 'en']).describe('language the caller speaks, for the on-screen label'),
        }),
        execute: async ({ field_id, language }) => {
          const f = findField(field_id);
          if (!f) return `Unknown field "${field_id}". Valid ids:\n${fieldList()}`;
          ui.currentField = field_id;
          ui.lang = language;
          ui.banner = (language === 'es' ? f.hint_es : f.hint_en) ?? '';
          return `Highlighted "${f.label_en}". Hint: ${language === 'es' ? f.hint_es : f.hint_en}`;
        },
      }),
      flag_issue: llm.tool({
        description: 'Mark a field in red on the caller\'s screen with a short message, when it is empty or filled in wrongly.',
        parameters: z.object({
          field_id: z.string(),
          message: z.string().describe('very short message in the caller\'s language, max 40 characters'),
        }),
        execute: async ({ field_id, message }) => {
          if (!findField(field_id)) return `Unknown field "${field_id}".`;
          ui.issues[field_id] = message.slice(0, 48);
          return 'Flagged on screen.';
        },
      }),
      clear_marks: llm.tool({
        description: 'Remove all boxes and red flags from the caller\'s screen.',
        parameters: z.object({}),
        execute: async () => { ui.currentField = undefined; ui.issues = {}; return 'Cleared.'; },
      }),
    };

    const session = new voice.AgentSession({
      // Reads GOOGLE_API_KEY from .env.local. Change `voice` to any name in the plugin's Voice type.
      llm: new realtime.RealtimeModel({ model: 'gemini-2.5-flash-native-audio-preview-12-2025', voice: 'Aoede' }),
    });
    session.on(voice.AgentSessionEventTypes.Error, e => console.error('session error', e?.error?.message ?? e));
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, e => { agentState = e.newState; });

    // ---- The "it caught my mistake" moment ----
    // Every few seconds, once read_page has run, look at the handwriting. An issue must be seen on two checks in a
    // row (one blurry frame must not cause a false alarm) before we draw a red box and speak. It clears itself when fixed.
    const REVIEW_EVERY_MS = 3500;
    let reviewing = false;
    const reviewTimer = setInterval(async () => {
      if (reviewing || MOCK || !doc?.fields?.length || !latest || !visionProvider()) return;
      reviewing = true;
      try {
        const png = await currentPng();
        if (!png || (await sharpness(png)) < MIN_SHARPNESS) return;
        const result = await reviewDocument(png, doc);
        for (const f of result.fields) { const d = findField(f.id); if (d) { d.filled = f.filled; d.value = f.value; } }
        const now = new Map(result.issues.map(i => [i.field_id, i]));
        for (const id of [...seen.keys()]) { // fixed or no longer reported
          if (now.has(id)) continue;
          seen.delete(id); delete ui.issues[id];
          if (spoken.delete(id)) console.log('mistake fixed:', id);
        }
        const toSay = [];
        for (const [id, issue] of now) {
          const count = (seen.get(id) ?? 0) + 1;
          seen.set(id, count);
          if (count < 2) continue; // confirm on a second look
          ui.issues[id] = (ui.lang === 'es' ? issue.problem_es : issue.problem_en).slice(0, 48);
          ui.banner = `${issue.problem_en} · ${issue.problem_es}`;
          if (!spoken.has(id)) toSay.push({ id, issue });
        }
        // Speak only when the model is free; otherwise the red box stays and we try again next round.
        if (toSay.length && agentState !== 'speaking' && agentState !== 'thinking') {
          const { id, issue } = toSay[0];
          spoken.add(id);
          console.log('mistake caught:', id, '-', issue.problem_en);
          const label = findField(id)?.label_en ?? id;
          session.generateReply({
            instructions: `The system noticed a mistake on the caller's form, field "${label}": ${issue.problem_en} Tell the caller kindly in ONE short sentence, in the language they have been speaking to you, and say how to fix it. A red box is now showing on their screen. Do not call any tools.`,
          });
        }
      } catch (err) {
        console.error('review failed', err?.message?.slice(0, 160));
      } finally {
        reviewing = false;
      }
    }, REVIEW_EVERY_MS);
    ctx.addShutdownCallback(async () => {
      clearInterval(reviewTimer);
      clearInterval(timer);
      await session.close();
      await track.close();
      await source.close();
    });
    await session.start({
      room: ctx.room,
      agent: new voice.Agent({ instructions, tools }),
      record: false,
      inputOptions: {
        participantIdentity: caller.identity,
        audioEnabled: true,
        videoEnabled: false,
        textEnabled: false,
        closeOnDisconnect: true,
        deleteRoomOnClose: false,
      },
      outputOptions: { audioEnabled: true, transcriptionEnabled: false },
    });
    // Greet once when chert dev reports that FaceTime is ready (bridge_ready in the
    // room metadata): the Mac ends the call if it hears nothing within 10 seconds
    // of that. Participant arrival alone is not readiness, so there is no greeting
    // on it. Without the signal there is no greeting, and the caller speaks first.
    const stopGreeting = greetOnBridgeReady(ctx.room, () => session.generateReply({ instructions: greeting }));
    ctx.addShutdownCallback(async () => stopGreeting());
  },
});

export default agent;

// Your own LiveKit project when .env.local has its three LIVEKIT_ values; otherwise Chert rooms through chert dev.
runAgent(agent, { file: fileURLToPath(import.meta.url), agentName: process.env.AGENT_NAME || 'video-agent' });
