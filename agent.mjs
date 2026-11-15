import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { AutoSubscribe, defineAgent, llm, voice } from '@livekit/agents';
import { realtime } from '@livekit/agents-plugin-google';
import { LocalVideoTrack, RoomEvent, TrackKind, TrackSource, VideoBufferType, VideoFrame, VideoSource, VideoStream } from '@livekit/rtc-node';
import sharp from 'sharp';
import { z } from 'zod';
import { annotateFrame, HEIGHT, WIDTH } from './annotate.mjs';
import { FieldTracker } from './tracker.mjs';
import { makeBarCropper } from './frame.mjs';
import { makeCalibrationFrame } from './calibrate.mjs';
import { renderBadge, renderCharacterFrame } from './character.mjs';
import { hashDistance, pageHash, readDocument, readFinePrint, reviewDocument, sharpness, snapBoxes, alignBoxes, answerAboutPage, visionProvider, warmVision } from './vision.mjs';
import { runAgent } from './chert-rooms.mjs';
import { greetOnBridgeReady } from './greet.mjs';

const RENDER_FPS = 10; // video frames per second sent back (the camera view runs at half of this: it is heavier)
const MIN_SHARPNESS = 15; // below this the page is too blurry to read
const PAGE_CHANGED_BITS = 16; // of 64: more differing bits than this means a different page is in view
// NOTICE_MOCK=1 skips the vision model and "reads" forms/permiso.json instead: handy for testing the call without a page.
const MOCK = process.env.NOTICE_MOCK === '1';
// NOTICE_CALIBRATE=1 sends a test pattern instead of the camera, to see how the phone fits our video (see calibrate.mjs).
const CALIBRATE = process.env.NOTICE_CALIBRATE === '1';

const instructions = `You are Notice, a friendly AI helper on a FaceTime video call for people who struggle with English or Spanish paperwork (school notices, clinic forms, work documents). The caller sees you as a cheerful animated face.
You cannot see the camera yourself. You learn about the page only through your tools and the messages the system gives you.

THE FLOW
1. You have just greeted the caller and asked what they need. You gave a few EXAMPLES (filling out a document, understanding it, checking for scams), but those are only examples: you can help with anything about their documents (translate part of it, explain a word or a deadline, answer a question about it, check one detail...). Never say you can only do three things. Do NOT talk about any document until they say what they need.
2. As soon as their need is clear, in any words and either language, answer with a short polite "Sure!" or "¡Claro!" and call set_mode: fill (help fill it out), understand (explain what it says), scam (check whether it looks like a scam), or other (anything else they ask about their document).
3. The result of set_mode tells you exactly what to do next. If no document is visible yet, ask them to hold it up, steady and well lit, then wait: the system tells you when it is ready.
4. They can change or add to what they want at any time ("now explain it", "is this a scam?", "what does this word mean?"): call set_mode again if the kind of help changes.
If their answer is unclear, ask a short question about what they need.

WHILE HELPING
- fill: one field at a time. Call highlight_field, then say what to write there. While they write, the system checks for mistakes and will ask you to correct them kindly: say it in one short sentence, say how to fix it, and do not call tools for it.
- understand: plain words. What it is, what they must do, then the small print.
- scam: a clear verdict and what to do about it.
- You only see the part of the document in front of the camera right now (and short notes about earlier parts). If the caller scrolls, turns the page, moves the camera, or asks about ANY detail (a price, a date, what to bring, where to sign, what a sentence means), NEVER say you cannot see it before you have looked: call ask_document with their question. Call read_page only to re-read the whole page.
- Checkboxes and choices (Yes / No, options): ALWAYS read the option's own words aloud and say where it is (top, bottom, left, right). Never say only "this box". The box drawn on screen is a visual aid and can be slightly off, especially when it is marked approximate, so the words are what the caller must rely on. When the caller ticks one, the system asks you to confirm which option they chose: do it.
- The small print matters most. Always tell the caller what to bring, what it costs, deadlines, and anything they give up by signing (liability waivers, photo permission, data sharing, non-refundable fees), most important first, in plain words.
- Scam safety: if the page shows signs of a scam (payment by gift card, crypto or Zelle, urgent threats, requests for a Social Security number or bank login, unknown links or phone numbers), say calmly that it looks suspicious, tell them NOT to pay or share personal information, and to check with the organization using a phone number or website they already trust. Say "signs to double check" unless the evidence is overwhelming.
- If the page is blurry or missing, ask them to hold it steady in front of the camera. Call read_page again only when they show a new page or ask you to look again.
- If you are not sure about something on the page, say so instead of guessing.
SPEAKING RULES
- Tools answer instantly. Call a tool BEFORE you start talking, never in the middle of a sentence, and then say your whole reply in one go. Do not say "Sure!" and then call a tool: call the tool first, then say "Sure!" together with the rest.
- If a tool says the page is still being read, say ONE short sentence like "One moment, I am looking at it." and then stop and wait: the system gives you the details by itself a few seconds later.
Always answer in the language the caller speaks to you, Spanish or English. If unsure, use Spanish.
Keep each reply short, at most three sentences. Say you are an AI. Never give legal or medical advice.`;

// What to do in each mode. Used by the set_mode tool and by the director when a document becomes ready.
const DIRECTIVE = {
  fill: 'MODE fill: guide the caller through filling it out. In at most two sentences say you will go one field at a time, then call highlight_field for the FIRST field and tell them what to write there. Move to the next field only when they say they are done. If something in the HEADS-UP list is essential (what to bring, a deadline, a fee), mention it briefly before you start.',
  understand: 'MODE understand: explain the document in plain words, at most four short sentences: what it is, what they must do, and the most important HEADS-UP items (what to bring, costs, deadlines, anything they give up by signing). Then ask if they want help filling it out or have questions.',
  other: 'MODE other: the caller wants something specific about their document. Do exactly what they asked (translate part of it, explain a word, a deadline or a fee, answer a question about it, check one detail), using the page information below. Keep it short and ask if they need anything else.',
  scam: 'MODE scam: give a clear verdict in two or three sentences (looks like an ordinary document / signs to double check / likely a scam), name the specific signs you see, and say what to do (never pay or share personal information; verify through a phone number or website they already trust). Then ask if they want it explained.',
};
const MODE_LABEL = { fill: 'Llenar · Fill out', understand: 'Entender · Understand', scam: 'Estafa · Scam check', other: 'Ayuda · Help' };

// Said once, as soon as FaceTime is ready: the greeting plus the question that starts the flow.
const greeting = 'Say exactly this, nothing more: "Hola, soy Notice, tu ayudante de IA. Hi, I am Notice, your AI helper. Puedo ayudarte con tus documentos, por ejemplo llenarlos, entenderlos o revisar si son una estafa. ¿Qué necesitas? I can help with your documents, like filling them out, understanding them, or checking for scams. What do you need?"';

const agent = defineAgent({
  entry: async ctx => {
    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);
    // Chert prepares a room before a caller exists. Join promptly so Chert can
    // find us, but wait before opening a paid model session or sending video.
    warmVision().catch(() => {}); // load the vision client and image libraries now, not on the first page
    const caller = await ctx.waitForParticipant();

    // ---- Shared state: latest camera frame, what we know about the page, what to draw ----
    let latest = null; // newest VideoFrame from the caller's camera
    let latestRot = 0; // how many quarter turns (clockwise) the frame needs to look upright
    const tracker = new FieldTracker(); // keeps field boxes on the page while the phone moves
    let doc = null; // DocState from read_page
    const ui = { alert: undefined, chip: undefined, currentField: undefined, issues: {}, lang: 'en', banner: '' };
    // Mistake watcher state: how many checks in a row saw each issue, and which ones we already said aloud.
    const seen = new Map(); // field_id -> consecutive checks that reported it
    const spoken = new Set(); // field_ids the caller has already been told about
    const tickSeen = new Map(); // checkbox id -> consecutive checks that saw it ticked
    const tickTold = new Set(); // checkbox ids whose tick we already read back
    const isCheckbox = f => f.bbox[2] <= 0.07 && f.bbox[3] <= 0.1;
    let agentState = 'initializing';
    // The conversation flow: the character welcomes the caller full screen, then a mode is chosen by voice.
    let mode = null; // null (still choosing) | 'fill' | 'understand' | 'scam'
    let briefed = false; // the caller has been told what we found, for this page and mode
    let scamWarned = false; // already warned about a likely scam on this page
    let fineSettled = false; // the small-print read for this page has finished (or failed)
    let tickN = 0;
    const memory = []; // short notes about parts of the document seen before the caller scrolled or moved on
    let movedSince = 0; // when the picture started to shift/zoom noticeably (a scroll); 0 = steady
    let newSection = false, lastNewSectionAt = 0; // a new part of the same form came into view while filling it out
    let askId = 0, pendingAnswer = null; // ask_document: answer waiting to be spoken
    const toldHeads = new Set(); // small-print items already said aloud
    let directorTick = () => {}; // set once the voice session exists
    let mouthLevel = () => null; // 0..1 loudness of the voice as the caller will hear it (set up once the session is running); null = unknown
    let modeAt = 0; // when the caller chose a mode

    // ---- Read the caller's camera ----
    const watched = new Set();
    const watch = track => {
      if (track.kind !== TrackKind.KIND_VIDEO || watched.has(track.sid)) return;
      watched.add(track.sid);
      (async () => {
        let first = true;
        for await (const ev of new VideoStream(track)) {
          latest = ev.frame; latestRot = Number(ev.rotation) || 0;
          if (first) { first = false; console.log(`camera frames: ${ev.frame.width}x${ev.frame.height}, rotation ${latestRot * 90} deg (output ${WIDTH}x${HEIGHT})`); }
        }
      })().catch(() => {});
    };
    ctx.room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => { if (participant.identity === caller.identity) watch(track); });
    for (const pub of caller.trackPublications.values()) if (pub.track) watch(pub.track);

    const cropBars = makeBarCropper(); // FaceTime frames come with black bars around the phone's picture: cut them off
    // The newest frame, turned upright (phones send sideways frames plus a rotation flag when held in landscape).
    const snapshot = async () => {
      if (!latest) return null;
      const f = latest.convert(VideoBufferType.RGBA);
      const raw = { raw: { width: f.width, height: f.height, channels: 4 } };
      let img = { raw: f.data, width: f.width, height: f.height };
      if (latestRot) {
        const { data, info } = await sharp(f.data, raw).rotate(latestRot * 90).raw().toBuffer({ resolveWithObject: true });
        img = { raw: data, width: info.width, height: info.height };
      }
      return cropBars(img);
    };
    const toPng = snap => sharp(snap.raw, { raw: { width: snap.width, height: snap.height, channels: 4 } }).png().toBuffer();
    const currentPng = async () => { const snap = await snapshot(); return snap ? toPng(snap) : null; };

    // ---- Send annotated video back: one camera track published by this agent ----
    const source = new VideoSource(WIDTH, HEIGHT);
    const track = LocalVideoTrack.createVideoTrack('agent-video', source);
    const calibration = CALIBRATE ? await makeCalibrationFrame() : null;
    let fine = null; // { heads_up, scam_check, small_print_illegible } for the current page
    // how worried to be about a page
    const RISK = { none: 0, low: 1, medium: 2, high: 3 };
    const riskOf = f => RISK[f?.scam_check?.risk] ?? 0;
    let busy = false;
    let lostSince = 0; // when the tracker last lost the page (camera turned or moved too far); 0 = tracking fine
    const render = async () => {
      if (busy) return;
      tickN++;
      const cameraView = !!(mode && latest); // the camera only takes over once the caller has said what they need
      if (cameraView && tickN % 2) return; // the camera view is heavier: half the frame rate
      busy = true;
      try {
        if (calibration) { source.captureFrame(new VideoFrame(calibration, WIDTH, HEIGHT, VideoBufferType.RGBA)); return; }
        const snap = cameraView ? await snapshot() : null;
        const lvl = mouthLevel(); // real loudness (delayed to match what the phone hears), or null before we can measure it
        const charState = lvl !== null
          ? (lvl > 0.04 ? 'speaking' : agentState === 'thinking' ? 'thinking' : 'listening')
          : (agentState === 'speaking' || agentState === 'thinking' ? agentState : 'listening');
        const mouth = lvl ?? undefined;
        const mood = riskOf(fine) >= 2 ? 'warn' : 'happy';
        let rgba;
        if (!snap) { // welcome screen (or no camera picture yet): the full-screen character
          rgba = await renderCharacterFrame({
            width: WIDTH, height: HEIGHT, tick: tickN, state: charState, mood, mouth, menu: false, // just the character: no written list of options
            caption: mode ? 'Muéstrame tu documento · Show me your document' : undefined,
          });
        } else {
          let state = doc;
          if (doc?.fields?.length && tracker.ready) {
            const r = await tracker.update(snap);
            // Lost = the camera turned or the match is bad: draw no boxes until the next re-location (a few seconds)
            const bad = r.lost || r.similarity < 0.4; // lost, or the camera now shows different content: boxes would be wrong
            lostSince = bad ? lostSince || Date.now() : 0;
            const scrolled = !bad && (Math.abs(tracker.t.dx) > 0.05 || Math.abs(tracker.t.dy) > 0.05 || Math.abs(tracker.t.s - 1) > 0.08 || r.similarity < 0.7);
            movedSince = scrolled ? movedSince || Date.now() : 0;
            state = bad ? null : { ...doc, fields: doc.fields.filter(f => r.boxes[f.id]).map(f => ({ ...f, bbox: r.boxes[f.id], angle: (f.angle ?? 0) + (tracker.t.th * 180) / Math.PI })) };
          }
          const size = Math.round(0.27 * HEIGHT);
          const badge = { input: await renderBadge({ size, tick: tickN, state: charState, mood, mouth }), left: Math.round(0.012 * WIDTH), top: Math.round((ui.alert ? 0.1 : 0.02) * HEIGHT) };
          rgba = await annotateFrame(snap, mode === 'fill' ? state : { ...state, fields: [] }, { ...ui, badge });
        }
        source.captureFrame(new VideoFrame(rgba, WIDTH, HEIGHT, VideoBufferType.RGBA));
      } catch (err) {
        console.error('render failed', err?.message);
      } finally {
        busy = false;
      }
    };
    // Publish video in parallel with the voice session start (awaited below) so neither waits for the other.
    const videoPublished = render().then(() => ctx.room.localParticipant.publishTrack(track, { source: TrackSource.SOURCE_CAMERA }));
    const timer = setInterval(render, 1000 / RENDER_FPS);

    // ---- Reading the page: two parallel reads (fields = fast, fine print = slower), cached, started in the background ----
    let docHash = null, docAt = 0, reading = null, lastTry = 0;
    let finePromise = null;
    let fineAnnounced = true; // true once the caller has been told (via read_page or a spoken heads-up)
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const IMPORTANCE = { high: 0, medium: 1, low: 2 };
    const mergeFine = f => {
      if (!f) return;
      fine ??= { heads_up: [], scam_check: { risk: 'none' } };
      const have = new Set(fine.heads_up.map(h => h.plain_en));
      for (const h of f.heads_up ?? []) if (!have.has(h.plain_en)) fine.heads_up.push(h);
      fine.heads_up.sort((x, y) => (IMPORTANCE[x.importance] ?? 3) - (IMPORTANCE[y.importance] ?? 3));
      if (riskOf(f) > riskOf(fine)) fine.scam_check = f.scam_check;
      fine.small_print_illegible = !!f.small_print_illegible;
      ui.alert = riskOf(fine) >= 2 ? 'POSSIBLE SCAM · POSIBLE ESTAFA' : undefined;
    };
    const resetForNewPage = () => { ui.issues = {}; ui.currentField = undefined; ui.alert = undefined; ui.banner = ''; seen.clear(); spoken.clear(); tickSeen.clear(); tickTold.clear(); fine = null; fineAnnounced = false; briefed = false; scamWarned = false; fineSettled = false; };

    const loadDoc = () => (reading ??= (async () => {
      lastTry = Date.now();
      try {
        const snap = await snapshot();
        if (!snap) return { error: 'No camera image yet. Ask the caller to turn on their video and hold the page up.' };
        const png = await toPng(snap);
        if ((await sharpness(png)) < MIN_SHARPNESS) return { error: 'The image is too blurry to read. Ask the caller to hold the page steady and closer.' };
        if (!visionProvider()) return { error: 'Vision is not configured (no GOOGLE_API_KEY or ANTHROPIC_API_KEY).' };
        const t0 = Date.now();
        const hash = await pageHash(png);
        const finePending = readFinePrint(png).catch(err => { console.error('fine print read failed', err?.message?.slice(0, 120)); return null; });
        const next = await readDocument(png).catch(err => { console.error('page read failed', err?.message?.slice(0, 120)); return null; });
        if (next?.fields?.length) { // put the model's rough boxes exactly on the printed lines (and measure the page tilt)
          const al = await alignBoxes(png, next.fields);
          if (al.matched >= 2) console.log(`aligned ${al.matched} of ${al.total} boxes to printed lines, ${al.boxesFound} of ${al.boxes} checkboxes pinned to their squares, page tilt ${al.tilt} deg`);
          else { const n = await snapBoxes(png, next.fields); console.log(`no clear page lines: snapped ${n} boxes individually`); }
        }
        const nFields = next?.fields?.length ?? 0;
        const closeup = doc?.fields?.length >= 3 && nFields < 3; // the caller zoomed in on a corner: keep the page, add what the close-up shows
        let usable = nFields > 0 && !closeup;
        let finePart = null;
        if (!usable) { // a notice with no fields (like a scam letter) or a close-up: the fine print decides whether this is readable
          finePart = await finePending;
          if (!(finePart?.heads_up?.length || riskOf(finePart) > 0)) return { error: 'No readable page is visible. Ask the caller to show the whole page, well lit.' };
        }
        if (closeup) {
          mergeFine(finePart);
          fineAnnounced = false;
        } else {
          const prevDoc = doc;
          const prev = { fine, fineAnnounced, briefed, scamWarned, labels: new Set((doc?.fields ?? []).map(f => f.label_en?.toLowerCase())) };
          const tickLabels = new Set((doc?.fields ?? []).filter(f => tickTold.has(f.id)).map(f => f.label_en));
          const toldLabels = new Set((doc?.fields ?? []).filter(f => spoken.has(f.id)).map(f => f.label_en));
          doc = next ?? { doc_type: 'notice', fields: [] };
          doc.fields ??= [];
          docAt = Date.now();
          resetForNewPage();
          for (const f of doc.fields) if (tickLabels.has(f.label_en)) { tickTold.add(f.id); tickSeen.set(f.id, 2); }
          for (const f of doc.fields) if (toldLabels.has(f.label_en)) { spoken.add(f.id); seen.set(f.id, 2); } // same page re-read: do not repeat what we already said
          // Same page read again (the camera moved)? Keep the small-print results and do not announce them a second time.
          const labels = doc.fields.map(f => f.label_en?.toLowerCase());
          const overlap = prev.labels.size && labels.length ? labels.filter(l => prev.labels.has(l)).length / Math.min(labels.length, prev.labels.size) : 0;
          const words = x => new Set(String(x ?? '').toLowerCase().split(/\W+/).filter(w => w.length > 3));
          const wa = words(prevDoc?.doc_type), wb = words(doc.doc_type);
          const typeOverlap = wa.size && wb.size ? [...wa].filter(w => wb.has(w)).length / Math.min(wa.size, wb.size) : 0;
          const samePage = !!prev.fine && overlap >= 0.5; // the same view, read again
          const sameDocument = !!prev.fine && (overlap >= 0.2 || typeOverlap >= 0.5); // same document: maybe the caller scrolled to another part
          if (sameDocument) { // remember what the earlier part said, keep what we already told the caller
            if (prevDoc?.fields?.length) { memory.push({ summary_en: prevDoc.summary_en ?? prevDoc.doc_type, labels: prevDoc.fields.map(f => f.label_en) }); if (memory.length > 6) memory.shift(); }
            fine = prev.fine; fineAnnounced = prev.fineAnnounced; briefed = prev.briefed; scamWarned = prev.scamWarned; fineSettled = true;
            ui.alert = riskOf(fine) >= 2 ? 'POSSIBLE SCAM · POSIBLE ESTAFA' : undefined;
          } else { memory.length = 0; toldHeads.clear(); }
          newSection = sameDocument && !samePage && mode === 'fill' && Date.now() - lastNewSectionAt > 15000;
          if (newSection) lastNewSectionAt = Date.now();
          await tracker.setReference(snap, Object.fromEntries(doc.fields.map(f => [f.id, f.bbox])));
          if (samePage) { /* keep the earlier small-print result */ }
          else if (finePart) { const before = fine?.heads_up?.length ?? 0; mergeFine(finePart); if ((fine?.heads_up?.length ?? 0) > before) fineAnnounced = false; fineSettled = true; }
          else {
            const mine = docAt;
            finePromise = finePending.then(f => {
              if (docAt !== mine || !f) return;
              const before = fine?.heads_up?.length ?? 0;
              mergeFine(f);
              if ((fine?.heads_up?.length ?? 0) > before) fineAnnounced = false; // new small print came into view: say it
            }).finally(() => { if (docAt === mine) fineSettled = true; });
          }
        }
        docHash = hash;
        console.log(`page read in ${Date.now() - t0} ms: ${doc.doc_type}, ${doc.fields.length} fields${closeup ? ' (close-up merged)' : ''}`);
        return { ok: true };
      } catch (err) {
        console.error('page read failed', err?.message?.slice(0, 160));
        return { error: 'I could not read the page just now. Ask the caller to hold it steady and try again.' };
      } finally {
        reading = null;
      }
    })());
    let lastReadError = null, lastErrorSpokenAt = 0, forceBrief = false;
    const readAndTrack = async () => { // loadDoc plus bookkeeping the director needs
      const r = await loadDoc();
      if (r?.error) lastReadError = { msg: r.error, t: Date.now() };
      else { lastReadError = null; if (forceBrief) { briefed = false; forceBrief = false; } }
      return r;
    };
    // Every 2 s: if no page has been read yet, or the camera now shows a clearly different page, read it quietly in
    // the background (at most once per 8 s, so a face or empty desk does not burn API calls).
    const prefetchTimer = setInterval(async () => {
      const changedLong = (lostSince && Date.now() - lostSince > 1500) || (movedSince && Date.now() - movedSince > 1200); // boxes hidden, or the caller scrolled: read the view again now
      if (MOCK || reading || !latest || !visionProvider() || Date.now() - lastTry < (changedLong ? 3000 : 8000)) return;
      try {
        const png = await currentPng();
        if (!png) return;
        if (!changedLong && doc && docHash && hashDistance(await pageHash(png), docHash) <= PAGE_CHANGED_BITS) return;
        await readAndTrack();
      } catch { /* try again next round */ }
    }, 2000);
    ctx.addShutdownCallback(async () => clearInterval(prefetchTimer));

    // ---- Tools the voice model can call ----
    const fieldList = () => (doc?.fields ?? []).map(f => `- ${f.id}: ${f.label_en} / ${f.label_es}${f.filled ? ` [filled: ${JSON.stringify(f.value)}]` : ' [empty]'}${f.uncertain ? ' [on-screen box position is APPROXIMATE: describe it in words]' : ''}`).join('\n');
    const findField = id => doc?.fields?.find(f => f.id === id);
    const describePage = () => {
      const parts = [`Document: ${doc.doc_type} (${doc.language ?? '?'}).`];
      if (doc.summary_en) parts.push(`Summary: ${doc.summary_en}`, `Summary (es): ${doc.summary_es}`);
      if (doc.fields.length) parts.push(`Fields:\n${fieldList()}`);
      if (fine?.heads_up?.length) {
        parts.push('HEADS-UP: explain these to the caller, most important first. Also include any bring-list, costs, deadlines and rights they give up.');
        for (const h of fine.heads_up) { parts.push(`- [${h.importance}/${h.kind}] ${h.plain_en} (es: ${h.plain_es})${h.action_en ? ` ACTION: ${h.action_en}` : ''}`); toldHeads.add(h.plain_en); }
        fineAnnounced = true;
      } else if (reading || (finePromise && !fine)) {
        parts.push('The small print is still being checked: it will be announced in a moment.');
      }
      if (riskOf(fine) >= 1) {
        const sc = fine.scam_check;
        parts.push(`SCAM CHECK: risk ${sc.risk}. Signs to double check: ${(sc.signs_en ?? []).join('; ')}. Advice: ${sc.advice_en ?? ''} (es: ${sc.advice_es ?? ''})`);
        fineAnnounced = true;
      }
      if (fine?.small_print_illegible) parts.push('Some small print is too tiny to read: ask the caller to bring the camera closer to that part and hold it steady.');
      if (memory.length) parts.push(`EARLIER PARTS OF THIS DOCUMENT (seen before the caller scrolled or moved on; they may no longer be in view):\n${memory.map(m => `- ${m.summary_en} (fields: ${m.labels.slice(0, 8).join('; ')})`).join('\n')}`);
      parts.push('NOTE: this describes only the part in front of the camera. For any specific question, call ask_document so you look at it again.');
      return parts.join('\n');
    };
    const tools = {
      set_mode: llm.tool({
        description: 'Call this as soon as the caller says what they want help with: "fill" (help fill out the form), "understand" (explain what the document says), "scam" (check whether it looks like a scam), or "other" (anything else about the document: translate, explain a word, answer a question). Call it again if the kind of help changes.',
        parameters: z.object({
          mode: z.enum(['fill', 'understand', 'scam', 'other']),
          language: z.enum(['es', 'en']).describe('the language the caller speaks'),
        }),
        execute: async ({ mode: m, language }) => {
          mode = m; modeAt = Date.now(); ui.lang = language; ui.chip = MODE_LABEL[m];
          ui.currentField = undefined; ui.issues = {}; seen.clear(); spoken.clear();
          console.log('mode chosen:', m);
          if (!doc) { // nothing read yet: the director briefs the caller as soon as the page is ready
            briefed = false; ui.banner = 'Muestre su documento · Hold up your document';
            return `${DIRECTIVE[m]}\nNo document has been read yet. Say a short polite "Sure!" in the caller's language, ask them to hold the document up to the camera, steady and well lit, then wait. You will be told when it is ready.`;
          }
          ui.banner = '';
          briefed = true;
          return `${DIRECTIVE[m]}\n\n${describePage()}`;
        },
      }),
      ask_document: llm.tool({
        description: 'Look at what is in front of the camera RIGHT NOW and answer one specific question about the document: after the caller scrolled, turned the page or moved the camera, or whenever they ask about a detail (a price, a date, what to bring, where to sign, what a sentence means). Use this instead of ever saying you cannot see something.',
        parameters: z.object({
          question: z.string().describe("the caller's question, in their own words"),
          language: z.enum(['es', 'en']).describe('the language the caller speaks'),
        }),
        execute: async ({ question, language }) => {
          if (!mode) { mode = 'other'; modeAt = Date.now(); ui.chip = MODE_LABEL.other; } // asking about the document is itself a request for help
          ui.lang = language;
          ui.banner = 'Revisando tu documento… · Checking your document…';
          const mine = ++askId;
          console.log('asking the document:', question);
          (async () => {
            try {
              const snap = await snapshot();
              if (!snap) throw new Error('no camera image');
              const answer = await answerAboutPage(await toPng(snap), question, memory.map(m => `- ${m.summary_en}`).join('\n'));
              if (mine === askId) pendingAnswer = { q: question, answer, ok: !!answer };
            } catch (err) {
              console.error('ask_document failed', err?.message?.slice(0, 120));
              if (mine === askId) pendingAnswer = { q: question, answer: '', ok: false };
            }
            directorTick(); // speak it right away instead of waiting for the next tick
          })();
          return 'Looking at the document now. Say ONE short sentence like "Let me check", then stop and wait: the answer arrives by itself in a few seconds.';
        },
      }),
      read_page: llm.tool({
        description: 'Look at the page the caller is holding up to the camera. Returns what the document is, what to do, and each field with whether it is filled. Call it when a page is shown and again after the caller writes something.',
        parameters: z.object({}),
        execute: async () => {
          if (MOCK) {
            doc = JSON.parse(readFileSync(new URL('./forms/permiso.json', import.meta.url), 'utf8'));
            doc.summary_en = 'A school field trip permission slip. Sign it and return it by November 20. The trip costs $12.';
            return `${doc.summary_en}\nFields:\n${fieldList()}`;
          }
          // Always instant. If the page is already read and still in view, answer from the cache. Otherwise start reading in the
          // background and say so: a tool that waits leaves the voice silent in the middle of a sentence.
          const png = await currentPng();
          let fresh = doc && png && Date.now() - docAt < 180_000;
          if (fresh) fresh = hashDistance(await pageHash(png), docHash) <= PAGE_CHANGED_BITS && !lostSince && !(movedSince && Date.now() - movedSince > 600);
          if (!fresh) {
            forceBrief = !!mode; // when the read finishes, the director tells the caller what it found
            readAndTrack().catch(() => {});
            return 'The page is being read right now (it takes a few seconds). Say ONE short sentence like "One moment, I am looking at it", then stop and wait: the system will give you what it finds.';
          }
          if (mode) briefed = true; // the model has the information now: the director must not repeat it
          return describePage();
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
          const warn = f.uncertain ? ' CAUTION: the box on the caller\'s screen is only approximate. Say the field\'s printed words and where it is on the page (top/bottom/left/right) so there is no doubt which one you mean.' : '';
          return `Highlighted "${f.label_en}". Hint: ${language === 'es' ? f.hint_es : f.hint_en}${warn}`;
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
      llm: new realtime.RealtimeModel({ model: process.env.VOICE_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025', voice: 'Aoede' }),
    });
    session.on(voice.AgentSessionEventTypes.Error, e => console.error('session error', e?.error?.message ?? e));
    let tReady = 0;
    // Greeting bookkeeping. Other proactive speech (small-print heads-up, mistake corrections) waits until the greeting
    // is done: two replies at once make the later one cancel the earlier, so the caller never hears the greeting.
    let readyAt = 0, greeted = false, greetedAt = 0, everSpoke = false;
    const mayInterjectNow = () => greeted ? Date.now() - greetedAt > 1200 : readyAt && Date.now() - readyAt > 9000;
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, e => {
      agentState = e.newState;
      if (e.newState === 'speaking') everSpoke = true;
      if (tReady && e.newState === 'speaking') { console.log(`first audio ${Date.now() - tReady} ms after bridge ready`); tReady = 0; }
    });

    // ---- The director: decides when Notice speaks up on its own ----
    // 1) A page with strong signs of a scam gets a warning even before the caller chose anything (safety first).
    // 2) Once the caller has chosen what they need and the document is read, give the briefing for that mode.
    // It never talks over the model (agentState) and waits for the greeting to finish (mayInterjectNow).
    directorTick = () => {
      if (reading || !mayInterjectNow() || agentState === 'speaking' || agentState === 'thinking') return;
      // An answer to ask_document is ready: say it.
      if (pendingAnswer) {
        const p = pendingAnswer; pendingAnswer = null; ui.banner = '';
        console.log('speaking up: answer to', p.q);
        session.generateReply({ instructions: p.ok
          ? `The caller asked: "${p.q}". Looking at the document just now, the answer is: ${p.answer} Tell them this in the language they have been speaking, in at most three short sentences. If it says the part is not visible, kindly tell them what to scroll to or show. Do not call any tools.`
          : 'You could not look at the document just now. In ONE short sentence, in the language they have been speaking, ask the caller to hold the document steady in front of the camera and ask again. Do not call any tools.' });
        return;
      }
      // The caller is waiting for a page we cannot read: tell them what to change (at most every 15 s)
      if (mode && !doc && lastReadError && Date.now() - modeAt > 7000 && Date.now() - lastReadError.t < 10000 && Date.now() - lastErrorSpokenAt > 15000) {
        lastErrorSpokenAt = Date.now();
        console.log('speaking up: page not readable');
        session.generateReply({ instructions: `The system could not read the caller's page yet: ${lastReadError.msg} In ONE short sentence, in the language they have been speaking, tell them kindly what to do. Do not call any tools.` });
        return;
      }
      if (!doc) return;
      if (riskOf(fine) >= 3 && !scamWarned) {
        scamWarned = true; fineAnnounced = true;
        console.log('speaking up: scam warning');
        session.generateReply({ instructions: `You just finished checking the caller's page and it shows strong signs of a scam (${(fine.scam_check.signs_en ?? []).join('; ')}). In the language they have been speaking (Spanish if they have not spoken yet), say calmly in at most two sentences that this looks like a scam, that they should NOT pay or share personal information, and that they should contact the organization using a phone number or website they already trust. Do not call any tools.` });
        return;
      }
      if (mode && !briefed && (fineSettled || Date.now() - docAt > 6000)) {
        briefed = true; fineAnnounced = true;
        console.log(`speaking up: briefing (${mode})`);
        ui.banner = '';
        session.generateReply({ instructions: `The caller chose "${mode}" and their document is now ready. Reply in the language they have been speaking to you. ${DIRECTIVE[mode]}\n\n${describePage()}` });
      }
      // While filling out, the caller scrolled to another part of the form: carry on there.
      if (newSection && mode === 'fill' && briefed) {
        newSection = false; ui.currentField = undefined;
        console.log('speaking up: new part of the form');
        session.generateReply({ instructions: `The caller has moved to a different part of the document. Call highlight_field for the first empty field in the list below, then say in ONE short sentence that you can see this new part and what to write in that field.\n${fieldList()}` });
        return;
      }
      // The small print can finish after the briefing: if it holds something important that was not said yet, say it now.
      const fresh = (fine?.heads_up ?? []).filter(h => !toldHeads.has(h.plain_en)); // small print not said aloud yet
      if (mode && briefed && !fineAnnounced && fine && fineSettled && (fresh.some(h => h.importance === 'high') || (riskOf(fine) >= 2 && !scamWarned))) {
        fineAnnounced = true;
        console.log('speaking up: small print that arrived late');
        fresh.forEach(h => toldHeads.add(h.plain_en));
        const points = fresh.slice(0, 4).map(h => `- ${h.plain_en}${h.action_en ? ` (do: ${h.action_en})` : ''}`).join('\n');
        session.generateReply({ instructions: `You have just finished reading the small print on the caller's page. In the language they have been speaking, tell them the most important points in at most three short sentences, starting with something like "One more thing from the small print". Points:\n${points}\nDo not call any tools.` });
      }
    };
    const directorTimer = setInterval(() => directorTick(), 1500);

    // ---- The "it caught my mistake" moment ----
    // Every few seconds, once read_page has run, look at the handwriting. An issue must be seen on two checks in a
    // row (one blurry frame must not cause a false alarm) before we draw a red box and speak. It clears itself when fixed.
    const REVIEW_EVERY_MS = 3500;
    let reviewing = false;
    const reviewTimer = setInterval(async () => {
      if (reviewing || MOCK || mode !== 'fill' || !doc?.fields?.length || !latest || !visionProvider()) return;
      reviewing = true;
      try {
        const snap = await snapshot();
        const png = snap && (await toPng(snap));
        if (!png || (await sharpness(png)) < MIN_SHARPNESS) return;
        const result = await reviewDocument(png, doc);
        const ticked = [];
        for (const f of result.fields) {
          const d = findField(f.id);
          if (!d) continue;
          d.filled = f.filled; d.value = f.value;
          if (!isCheckbox(d)) continue;
          if (f.filled) { const n = (tickSeen.get(d.id) ?? 0) + 1; tickSeen.set(d.id, n); if (n >= 2 && !tickTold.has(d.id)) ticked.push(d); }
          else { tickSeen.delete(d.id); tickTold.delete(d.id); } // un-ticked: ask again if it is ticked later
        }
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
        // A ticked checkbox is an answer (Yes / No): read the chosen option back so a wrong box is caught at once.
        if (!toSay.length && ticked.length && agentState !== 'speaking' && agentState !== 'thinking' && mayInterjectNow()) {
          const d = ticked[0];
          tickTold.add(d.id);
          console.log('reading back tick:', d.label_en);
          session.generateReply({ instructions: `The caller just ticked a checkbox. Its printed words are: "${d.label_en}" (Spanish: "${d.label_es}"). In ONE short sentence, in the language they have been speaking, read that option aloud and ask them to confirm it is the answer they want. Do not call any tools.` });
        }
        // Speak only when the model is free; otherwise the red box stays and we try again next round.
        if (toSay.length && agentState !== 'speaking' && agentState !== 'thinking' && mayInterjectNow()) {
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
      clearInterval(directorTimer);
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
    await videoPublished;

    // ---- Lip sync ----
    // The mouth follows the REAL loudness of the voice, not the "speaking" flag (which turns on long before the sound reaches
    // the phone). Each audio frame we send is stamped with when it will play (frames queue up and play in real time), and the
    // mouth reads the loudness MOUTH_DELAY_MS later: roughly the time the sound needs to travel through LiveKit, the Mac and
    // FaceTime to the phone. Mouth ahead of the voice -> raise MOUTH_DELAY_MS; mouth behind -> lower it.
    const MOUTH_DELAY_MS = Number(process.env.MOUTH_DELAY_MS ?? 1000);
    const amps = [];
    let playoutEnd = 0, tapped = false;
    const tap = frame => {
      try {
        const ch = frame.channels || 1, n = frame.data.length;
        let sum = 0;
        for (let i = 0; i < n; i += ch) sum += frame.data[i] * frame.data[i];
        const rms = Math.sqrt(sum / Math.max(1, n / ch)) / 32768;
        const dur = (frame.samplesPerChannel / frame.sampleRate) * 1000;
        const start = Math.max(Date.now(), playoutEnd);
        playoutEnd = start + dur;
        amps.push({ t: start, dur, a: rms });
        tapped = true;
      } catch { /* never let the mouth break the voice */ }
    };
    mouthLevel = () => {
      if (!tapped) return null;
      const at = Date.now() - MOUTH_DELAY_MS;
      while (amps.length && amps[0].t + amps[0].dur < at - 300) amps.shift();
      let sum = 0, n = 0;
      for (const e of amps) if (e.t <= at && e.t + e.dur > at - 90) { sum += e.a; n++; }
      return n ? Math.min(1, (sum / n) * 7) : 0;
    };
    const patchAudio = () => { // wrap the output so every audio frame passes the tap first
      const out = session.output?.audio;
      if (!out || out.__tapped) return;
      const orig = out.captureFrame.bind(out);
      out.captureFrame = frame => { tap(frame); return orig(frame); };
      out.__tapped = true;
      console.log(`lip sync: following the voice with a ${MOUTH_DELAY_MS} ms delay`);
    };
    patchAudio();
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, patchAudio); // reapply if the output was replaced

    // Anything that blocks the program for long enough also stalls the voice: report it.
    let lastBeat = performance.now();
    const lagTimer = setInterval(() => {
      const now = performance.now(), lag = now - lastBeat - 100;
      lastBeat = now;
      if (lag > 120) console.log(`program was blocked for ${lag.toFixed(0)} ms`);
    }, 100);
    ctx.addShutdownCallback(async () => clearInterval(lagTimer));
    // Greet once when chert dev reports that FaceTime is ready (bridge_ready in the
    // room metadata): the Mac ends the call if it hears nothing within 10 seconds
    // of that. Participant arrival alone is not readiness, so there is no greeting
    // on it. Without the signal there is no greeting, and the caller speaks first.
    const sayGreeting = again => {
      const h = session.generateReply({ instructions: greeting, allowInterruptions: false });
      h.addDoneCallback(sh => {
        console.log(`greeting ${sh.interrupted ? 'was INTERRUPTED' : 'finished'} ${Date.now() - readyAt} ms after bridge ready${again ? ' (second try)' : ''}`);
        greeted = true; greetedAt = Date.now();
      });
    };
    let watchdog;
    const stopGreeting = greetOnBridgeReady(ctx.room, () => {
      tReady = readyAt = Date.now();
      console.log('bridge ready: greeting now');
      sayGreeting(false);
      // If nothing has been heard 5 s later, say it again: a silent call is hung up by the Mac after 10 s.
      watchdog = setTimeout(() => { if (!everSpoke) { console.log('no audio 5 s after bridge ready: greeting again'); sayGreeting(true); } }, 5000);
    });
    ctx.addShutdownCallback(async () => clearTimeout(watchdog));
    ctx.addShutdownCallback(async () => stopGreeting());
  },
});

export default agent;

// Your own LiveKit project when .env.local has its three LIVEKIT_ values; otherwise Chert rooms through chert dev.
runAgent(agent, { file: fileURLToPath(import.meta.url), agentName: process.env.AGENT_NAME || 'video-agent' });
