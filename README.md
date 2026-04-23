# TeamBench Scheduler

A lightweight, when2meet-style scheduler for booking 30-minute TeamBench
team-mode sessions across institutions.

- **Roles.** Every team needs three participants: a **Planner**, an
  **Executor**, and a **Verifier**. Visitors see which roles are already
  claimed at each 30-minute slot and can sign up for the remaining roles.
- **Auto-grouping.** Once a role is filled, the next sign-up at that slot
  joins the same waiting team. When the third role is filled, the team is
  locked and (optionally) notified via email.
- **Overflow.** If three people have already formed a team at a slot, the
  next sign-up starts a fresh waiting team at the same time — unlimited
  teams per slot.
- **Timezone-aware.** Data is stored in UTC. Each visitor picks a display
  timezone (Seattle/PT default, plus ET, KST, and several others).
- **Static site.** No backend to run. Hosted on GitHub Pages; real-time
  availability via Firebase Realtime DB; emails via EmailJS.

See [SETUP.md](./SETUP.md) for setup — Firebase + EmailJS credentials are
injected at deploy time from GitHub Actions secrets (same pattern as
`teambench/human-eval`), so no keys are committed to the repo.

## Local preview

```bash
# From this directory
python3 -m http.server 8000
# → open http://localhost:8000
```

Without a Firebase key the page will show a configuration banner but the
layout and styling will render.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page skeleton and modals. |
| `styles.css` | Full stylesheet. |
| `app.js` | All app logic — date strip, slot grid, claim flow, EmailJS. |
| `firebase-config.js` | Paste your Web API key here. |
| `emailjs-config.js` | Optional — EmailJS IDs for the team-formed email. |
| `SETUP.md` | Firebase rules, EmailJS template, deploy steps. |
