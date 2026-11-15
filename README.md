# Notice

**An AI helper on FaceTime that reads paperwork for people who struggle with English or Spanish.**
Hold a school notice, clinic form or work document up to your phone camera. Notice explains it in your language,
walks you through filling it in, warns you about small print and scams, and answers questions about it.
Built for the Chert × HackUTA "Best Use of FaceTime" track.

Notice is a **video** agent: it looks at your page through the call and draws on the picture it sends back
(boxes on the field you should write in, red marks on mistakes, a scam warning strip).

## What a call looks like

1. You FaceTime the line. A friendly animated face, **Notice**, greets you in Spanish and English and asks what you need.
2. You say it in your own words, in either language: fill the form out, understand it, check if it is a scam,
   or anything else about the document (translate a part, explain a word, "what does this deadline mean?").
3. Your camera view takes over, with a small Notice in the corner and a label for what it is helping with.
4. It briefs you in plain words, always including the **small print**: what to bring, costs, deadlines,
   and anything you give up by signing (liability waivers, photo permission, non-refundable fees).
5. While you fill in a form it guides you **field by field** with a box on the page, **catches mistakes**
   (a signature on the date line, a skipped field, two exclusive boxes ticked) and **reads back every box you tick**
   ("You ticked 'No, I do not authorize'. Is that what you want?").
6. A page with signs of a scam (gift cards, Zelle, an SSN or bank login request, 24-hour threats) gets a red
   **POSSIBLE SCAM** strip and a calm warning not to pay or share personal information.
7. Scroll or move to another part of the document and ask about it: Notice looks again instead of answering from memory.

It does not give legal or medical advice, and it says it is an AI.

## How it works

```
iPhone --FaceTime--> Chert Mac --LiveKit room--> Notice (this repo, run with `chert dev`)
                                                   |
   camera frames --> crop black bars --> tracker --+--> annotate (boxes, strips, character) --> video back
                                       \-> vision model reads page, small print, answers questions
   voice  <--> Gemini Live (tools: set_mode, ask_document, read_page, highlight_field, flag_issue, clear_marks)
```

| File | What it does |
|---|---|
| `agent.mjs` | The agent: conversation flow, tools, the "director" that decides when Notice speaks up, render loop, lip sync |
| `vision.mjs` | Reads a page (fields, small print, scam check), reviews handwriting, answers questions about the current view, aligns boxes to printed lines and checkbox squares |
| `tracker.mjs` | Keeps boxes on the page while the phone moves (pan, zoom, tilt) and notices scrolling; matches on printed structure, so lighting changes do not fool it |
| `frame.mjs` | Removes the black bars FaceTime puts around the phone's picture |
| `annotate.mjs` | Draws boxes, labels, the scam strip, the mode chip and the corner character onto the video |
| `character.mjs` | The animated face (SVG, no assets) |
| `calibrate.mjs` | A test pattern to see how the phone fits our video |
| `greet.mjs`, `chert-rooms.mjs` | Chert starter files: greet when FaceTime is ready, join the Chert room |
| `gen-forms.mjs`, `gen-filled.mjs`, `gen-fineprint.mjs` | Make the demo and test forms in `forms/` |
| `test-annotate.mjs`, `test-tracker.mjs`, `test-frame.mjs` | Offline tests (no keys needed) |

Safety choices worth knowing: a wrong checkbox changes the meaning of a form, so boxes are located from the printed squares in the
image, matched in reading order, and drawn **dashed** when position is uncertain (the agent then describes the option in words);
every tick is read back. Documents are never stored.

## Run it

Needs Node 22.23.2+ (24 or 26 work), a [Chert](https://app.trychert.com) account and line, a LiveKit Cloud project
(free tier is enough), and a Google AI Studio key (free). An iPhone is needed to make the call.

1. Get a Chert line: `npx --yes @trychert/facetime@0.1.0-beta.21 onboard --json --no-browser --plan trial --stack demo`
2. Install and configure:
   ```sh
   npm install
   cp .env.example .env.local && chmod 600 .env.local   # then fill in the keys
   chert login          # once per computer
   chert doctor --agent notice
   ```
3. Terminal 1: `npm start`
4. Terminal 2: `chert dev --agent notice`
5. When `chert dev` says FaceTime is ready, make a **FaceTime Video** call to your line from an iPhone.
   After you change the code, restart **both** terminals (a waiting room can hold the old code).

Try it with the pages in `forms/`: `permiso.png` (Spanish permission slip), `intake.png` (clinic form with a small
footer note), `camp.png` (fine print: waiver, fees, photo permission), `scam.png` (a fake toll notice). Print them, or show
them full-screen on a second screen, and hold the phone camera to the page.

## Tuning and debugging

- **Lip sync:** `MOUTH_DELAY_MS` (default 1400). During a call you can also say "the mouth is early" or "the mouth is late" to shift it by a quarter second. The mouth follows the real loudness of the voice, shifted by this delay to match what the phone hears.
  Mouth ahead of the voice: raise it. Mouth behind: lower it. The delay differs a little from call to call.
- **Picture size:** FaceTime fits our video into a 16:9 window; the default is 1280x720 (`OUT_W`, `OUT_H`). `NOTICE_CALIBRATE=1` sends a test pattern so you can see how your phone fits it.
- **Offline tests:** `node test-annotate.mjs`, `node test-tracker.mjs`, `node test-frame.mjs` (write images to `out/`, which is git-ignored).
- **Logs** show what happened on a call: `page read in N ms`, `aligned N of M boxes…`, `mode chosen: …`, `speaking up: …`, `reading back tick: …`, `first audio N ms after bridge ready`, `program was blocked for N ms`.

## Limits

- Real phone photos are messier than the test pages (curved paper, shadows, perspective): boxes can be a few pixels off, and some checkboxes may be marked uncertain.
- The voice model needs about 2 seconds to start each reply.
- Reading a page takes about 3 to 4 seconds; the small print arrives a moment later.
- The Chert trial limits calls to 5 minutes and has a fixed pool of FaceTime minutes.
- Notice is an AI helper, not a lawyer or a doctor. Check important documents with the organization that sent them.

## Chert notes

The Mac that answers FaceTime takes audio from the **one** participant that publishes audio and shows video **only from that same
participant**, so the agent publishes its own voice and its own camera track. The Mac ends a call that hears nothing within 10 seconds of
FaceTime being ready, so the agent greets once on the `chert_bridge_ready` signal (see `greet.mjs`). Run `chert guide` for the full handbook.

Never commit or share `.env.local`. LiveKit and model usage may cost money.
