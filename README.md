# Live Q&A

Audience questions + votes, moderator queue, projector view. No dependencies, no database, no build step.

| Page | Who | What |
|---|---|---|
| `/` | audience (QR code) | see questions, sort Popular / Recent, vote (tap again to un-vote), ask a question |
| `/mod` | you | password-protected. Approve / reject pending questions, mark answered, remove, feature one question big on screen, add a question from the room, export CSV |
| `/screen` | projector | live list of the top questions, or one featured question in large type |

**Polls.** At the bottom of `/mod`, *Create a poll*: a question and 2 to 8 answers (one per line), optionally allowing several answers. Then:
- **Launch**: the poll appears at the top of every phone and takes over the projector screen with live bars. Launching another poll closes the previous one.
- **Close voting**: results stay visible, no more votes. (Until then, people can change their vote.)
- **Hide from screen & phones**: back to the questions.
- *Export polls CSV* saves the results.

Language: French or English automatically from the phone's language. Force with `?lang=fr` or `?lang=en`.

Projector options: `/screen?sort=time` (newest first instead of most votes), `/screen?n=4` (number of questions shown, default 6), `/screen?url=https://short.link/x` (join address shown on screen).

By default new questions are held in the **Pending** queue until you approve them. Untick "Approve questions before they appear" on `/mod` to let everything through and remove problems afterwards.

---

## Option A: deploy online on Render (recommended)

1. **GitHub**: create a new repository (e.g. `live-qa`), then *Add file → Upload files* and drag in the contents of this folder. Keep the `public` folder as a folder (`server.js`, `package.json`, `render.yaml`, `public/index.html`, `public/mod.html`, `public/screen.html`). Commit.
2. **Render**: sign up at render.com with your GitHub account → *New → Web Service* → pick the repo.
   - Runtime: Node
   - Build command: leave empty (or `echo ok`)
   - Start command: `node server.js`
   - Instance type: **Free**
   - Environment variable: `MOD_PASSWORD` = a password of your choice
3. Wait for the first deploy. Your address is `https://<name>.onrender.com`. Open `/mod`, log in, open `/screen` on the projector laptop.

Things to know:
- Free instances go to sleep when idle, and the first visit then takes about a minute. **Open the site a few minutes before you start** and again before the session, so it is awake.
- The free instance has no permanent disk: a restart or redeploy erases the questions. Don't redeploy during the event, and use *Export CSV* afterwards if you want a record.
- Check Render's current free-plan terms when you sign up. I could not verify them today.

## Option B: your laptop + free Cloudflare tunnel (backup)

1. Install Node 18+ (nodejs.org) and `cloudflared` (developers.cloudflare.com → Cloudflare Tunnel → downloads).
2. Terminal 1: `MOD_PASSWORD=yourpassword node server.js` (Windows cmd: `set MOD_PASSWORD=yourpassword && node server.js`)
3. Terminal 2: `cloudflared tunnel --url http://localhost:3000`. It prints an `https://something.trycloudflare.com` address.
4. That address changes every time you restart the tunnel, so make the QR code after it is running.

Disable sleep/hibernation and stay on power. If the laptop drops, so does the Q&A.

## Test with two phones

Open the address on phone 1 (audience) and phone 2 (audience), and `/mod` on your computer. Ask, approve, vote from both phones, mark answered, feature one on `/screen`, and try *Export CSV*.

## Limits (by design)

- One vote per browser per question. Someone clearing their browser data could vote again; fine for a conference.
- A person can post one question every 8 seconds. Questions are plain text, up to 300 characters.
- Load-tested locally with 300 simultaneous connected devices and 300 simultaneous votes.
