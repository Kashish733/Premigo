# Notice: demo script (about 3.5 minutes live)

Judged **in person** on a **real FaceTime call**. Scoring: *fresh use of FaceTime video* (x2), *wow factor*, *usefulness*.
The Chert call cap is **5 minutes**, so this script targets 3.5 minutes and leaves a 90 second buffer.

**The story in one sentence:** a parent holds a form they can't read up to their phone; Notice *sees* it, explains it in their language,
catches their mistakes **on the video itself**, and warns them about scams and small print.

## Before you go on (checklist)

**30 minutes before**
- [ ] `npm start` running in `~/notice` and `chert dev --agent notice` connected ("is in a waiting room"). Run `chert doctor --agent notice`: line, agent and LiveKit all green.
- [ ] Trial minutes: `chert doctor` shows how many are left. **Do not burn them on tests.** One quick rehearsal (2 min max), then save the rest.
- [ ] Charge the iPhone. Turn off Do Not Disturb's *calls blocked*, silence notifications, volume up, **not** on speaker near a loud room.
- [ ] Wi-Fi: use the best network you have. If the agent's log shows `program was blocked` or dropped connections, move closer to the router.

**10 minutes before**
- [ ] Print the four pages in `forms/` (or open them full-screen on a second screen at full brightness): `permiso.png`, `intake.png`, `camp.png`, `scam.png`. Have a **pen with dark ink**.
- [ ] Good light on the page, no glare. Hold the **phone upright (portrait)** and **steady for about 3 seconds** whenever a new page appears.
- [ ] Decide who is the **caller** (holds the phone, speaks Spanish if you have a Spanish speaker) and who **narrates** (speaks to the judge).

**If the line is down** (Chert's Mac offline): don't call. Show the screenshots in `out/` (`flow-sheet.png`, `e2e-aligned-tilted.png`, `character-sheet.png`) and walk through the same beats from the architecture slide below. Ask a Chert organizer to bring the line up before your slot.

## The beats

| Time | Who | What happens | What to say / do |
|---|---|---|---|
| 0:00 | Narrator | **Hook** (before dialing, 20 s) | "Millions of parents get school and clinic forms in a language they don't read well. They usually guess. Notice is an AI helper on FaceTime: it *sees* the page through the call." |
| 0:20 | Caller | **Dial.** Notice answers with a friendly animated face | Wait for the greeting (about 12 s). *Don't talk over it.* It greets in Spanish and English and says it can help with documents. |
| 0:40 | Caller | **Ask for help filling a form out** | ES: "Hola. ¿Me ayudas a llenar este permiso?"  EN: "Hi, can you help me fill out this permission slip?" Hold up `permiso.png`, steady. |
| 0:55 | Notice | Camera view takes over, small Notice in the corner. It briefs the page in plain words and starts with the first field; **a box appears on that field** | Narrator: "Notice is *looking* at the page and drawing on the video it sends back." |
| 1:15 | Caller | **Make a deliberate mistake: sign on the date line**, leave the signature line empty | Narrator: "Watch what happens when she writes in the wrong place." |
| 1:30 | Notice | About 7 seconds later: **red box on the date field and a spoken correction** ("that's your name, not the date"). **Wow beat #1** | Caller fixes it; the red box clears by itself. |
| 1:50 | Caller | **Tick the "No" box** by mistake | Notice **reads the option back**: "You ticked 'No, I do not authorize'. Is that what you want?" Narrator: "A wrong checkbox changes the meaning of a form, so it always double-checks." Caller: "No, quiero marcar Sí" / "No, I meant yes." |
| 2:20 | Caller | **Switch tasks:** "¿Esto es una estafa?" / "Is this a scam?" and show `scam.png` | Within about 4 seconds: **red "POSSIBLE SCAM" strip across the video** and a calm warning: don't pay, don't share your SSN, call the agency on a number you trust. **Wow beat #2** |
| 2:50 | Caller | **Ask about something you scroll to:** show `intake.png`, then the footer: "¿Qué necesito llevar a la primera cita?" / "What do I need to bring to my first visit?" | Notice says "let me check", then answers from the *current* view: **insurance card and photo ID**. Narrator: "It isn't answering from memory. It looked again." |
| 3:20 | Caller | **Hang up.** | Narrator: closing line below. |

**Closing (20 s):** "Notice works on a phone people already have, in the language they speak, one form at a time. It sees the page, it
catches mistakes while you write, and it warns you about scams and small print. Next: schools and clinics put one phone number on their notices."

## Exact lines if the judge speaks Spanish / English only

- **No Spanish speaker on the team:** run the whole demo in English. The form is in Spanish and Notice explains it in English. This still shows the core value.
- **Spanish speaker:** use the ES lines. The agent answers in the language it hears. Switching language mid-call works.
- If Notice **doesn't pick a task**, say it plainly: "Help me fill this out" / "Explain this to me" / "Is this a scam?"
- If it **doesn't react to the page**: lower the page a little, hold it steady 3 seconds, make sure the whole page is in view.

## Timings to expect (measured)

| Step | Typical time |
|---|---|
| Greeting finishes | about 12 s |
| New page read (fields) | 3 to 4 s |
| Small print / scam check | 2 to 4 s after the page read |
| Mistake caught after you write it | about 7 s (two checks, 3.5 s apart) |
| Answer to a question about the current view | 4 to 6 s |
| Notice starts each spoken reply | about 2 s |

Fill the gaps with narration; never wait in silence.

## What can go wrong, and what to say

| Problem | Say / do |
|---|---|
| A box is slightly off the line | "The box is a visual aid; Notice always says the words too." (Checkboxes it isn't sure about are drawn dashed.) |
| It's slow to answer | Narrate: "It's reading the small print as well." Don't repeat the question for 5 s. |
| Mouth a little out of sync with the voice | Ignore it. It's tunable (`MOUTH_DELAY_MS`). |
| Call drops | Redial once. If it keeps failing, switch to the screenshots plan above. |
| Call hits 5 minutes | That's the Chert limit. Finish the closing line first. |

## Likely judge questions

- **Why FaceTime video, not just a voice call?** "A document is visual. The agent has to *see* the page, the pen and the boxes ticked, and it has to answer on the picture too: boxes on the right field, red marks on mistakes, a scam strip."
- **How does it work?** Chert bridges FaceTime into a LiveKit room. Our agent reads camera frames, a vision model reads the page, Gemini Live is the voice, and we draw on the video we send back. (Architecture is in the README.)
- **Is it safe?** It says it's an AI, gives no legal or medical advice, never stores documents, reads every ticked box back, says "signs to double check" about scams, and tells people to verify with a phone number they already trust.
- **What about accuracy?** "Real phone photos are messier than our test pages. We locate boxes from the printed lines and squares and mark anything uncertain; the words are what the caller relies on."
- **How would you scale it?** One agent process handles many calls; the limit today is Chert lines (one call per line). The path is partnerships with schools and clinics, one form type at a time, then more languages.
- **What's next?** A callback before deadlines found on the notice, more languages, and a text summary after each call.

## Quick facts to have ready

- Languages: Spanish and English (voice and on-screen labels).
- Built on: Chert FaceTime API, LiveKit, Gemini Live (voice), Gemini or Claude for reading pages, Node.js.
- Offline tests and demo pages are in the repo (`forms/`, `test-*.mjs`).
