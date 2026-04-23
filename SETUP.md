# Setup

The scheduler ships with a GitHub Actions workflow that injects API keys
from repository secrets at deploy time — same pattern as
`teambench/human-eval`. No keys are ever committed to the repo.

## 1. Firebase (required)

The scheduler uses Firebase Realtime Database to sync availability across
participants in real time. It stores everything under the `scheduler/`
subtree, so you can safely share a Firebase project with the TeamBench
human-eval app (which uses `teambench/`).

1. Go to https://console.firebase.google.com and either:
   - **Reuse** the existing `ivory-plane-406700` project used by
     `teambench/human-eval`, or
   - **Create a new project** and enable **Realtime Database** (any region
     is fine; pick one near your participants for lower latency).

2. In **Project settings → General → Your apps → Web**, register a web app
   if you haven't already, then copy the **Web API Key**.

3. If you created a new project, update the non-secret fields in
   `firebase-config.js` (`authDomain`, `databaseURL`, `projectId`, etc.)
   with the values from the SDK config panel. The `apiKey` field stays as
   the `__FIREBASE_API__` placeholder — the workflow fills it in.

4. In **Realtime Database → Rules**, paste the following. This opens
   `scheduler/` for public read/write (and nothing else).

   ```json
   {
     "rules": {
       "scheduler": {
         ".read": true,
         ".write": true
       }
     }
   }
   ```

   **If you are reusing the same Firebase project as `teambench/human-eval`**,
   merge the `scheduler` block into your existing rules so the `teambench`
   subtree retains its own permissions. For example:

   ```json
   {
     "rules": {
       "teambench": { ".read": true, ".write": true },
       "scheduler": { ".read": true, ".write": true }
     }
   }
   ```

   Click **Publish** after pasting. Without this step every sign-up will
   fail with a `PERMISSION_DENIED` error in the browser console.

## 2. EmailJS (optional but recommended)

Without EmailJS the scheduler still works — participants see "Team formed"
in the UI, but nobody gets an email. To enable automatic emails:

1. Create a free account at https://www.emailjs.com.
2. **Email Services → Add New Service** — link a Gmail, Outlook, SendGrid,
   Mailgun, or raw SMTP account. Note the **Service ID**.
3. **Email Templates → Create New Template** — paste the template below.
   Note the **Template ID**.
4. **Integration → Public Key** — note this key.

### Suggested EmailJS template

Subject: `TeamBench — {{session_when}} ({{role}})`

Body:

```
Hi {{to_name}},

{{status_line}}

  When:       {{session_when}}  ({{session_when_utc}})
  Your role:  {{role}}

Team:
  Planner:  {{planner_name}}  <{{planner_email}}>
  Executor: {{executor_name}} <{{executor_email}}>
  Verifier: {{verifier_name}} <{{verifier_email}}>

Join the session at:
  {{session_url}}?role={{role}}

Sessions are 30 minutes. Please arrive a few minutes early so all three
roles can sync up before the timer starts.

— TeamBench
```

In the template settings, set **To Email** to `{{to_email}}` and **From
Name** to something like `TeamBench Scheduler`.

**Template variables used:**

| Variable | Filled with |
|---|---|
| `{{to_email}}`, `{{to_name}}` | Recipient |
| `{{role}}` | `planner` / `executor` / `verifier` |
| `{{status_line}}` | e.g. `"You're signed up as planner. Waiting on 2 more people..."` or `"Your team of three is complete — you're all set!"` |
| `{{session_when}}`, `{{session_when_utc}}` | Human-readable start time in the visitor's tz and UTC |
| `{{session_url}}` | Base URL from `emailjs-config.js` (e.g. the human-eval app) |
| `{{planner_name}}` / `{{planner_email}}` (+ executor / verifier) | Each teammate's name/email, or `(pending)` if that seat isn't filled yet |

### When emails are sent

1. **Every sign-up** — the person who just signed up gets a confirmation
   email immediately. If they're the first or second to join, it says
   "waiting on X more." If they complete the team, it says the team is
   complete.
2. **Team completion** — the two teammates who joined earlier *also* get
   a team-complete email at that moment (the person who completed the
   team already got theirs in step 1).
3. **Cancellation** — no email is sent. The UI shows a toast; the person
   who cancelled knows, and the remaining teammates just see the seat
   re-open on their next page load.

## 3. Add the secrets to GitHub

Open your repository on GitHub →
**Settings → Secrets and variables → Actions → New repository secret**.

| Name | Required | Value |
|---|---|---|
| `FIREBASE_API` | **yes** | Web API Key from Firebase step 2 |
| `EMAILJS_PUBLIC_KEY` | optional | EmailJS step 4 |
| `EMAILJS_SERVICE_ID` | optional | EmailJS step 2 |
| `EMAILJS_TEMPLATE_ID` | optional | EmailJS step 3 |

If any of the three EmailJS secrets is missing, the workflow leaves those
placeholders in the file and the app detects them at runtime (`/^__[A-Z_]+__$/`)
and skips email sending. Firebase is required; the workflow fails fast if
`FIREBASE_API` is not set.

## 4. Enable GitHub Pages

Repository → **Settings → Pages**:
- **Source**: GitHub Actions

Then push to `main`:

```bash
git add .
git commit -m "Initial scheduler"
git push origin main
```

The `Deploy to GitHub Pages` workflow will run, substitute the secrets,
and publish to `https://teambench.github.io/scheduler/` within a minute.

## Local development

Running `python3 -m http.server 8000` in the repo root will serve the page
with the `__FIREBASE_API__` placeholder still in place. The app detects
this and shows a yellow configuration banner instead of talking to
Firebase. To test the full flow locally, either:

- **Temporarily** paste your API key into `firebase-config.js` (do not
  commit that change), or
- Use a separate file `firebase-config.local.js` and swap the import —
  whatever works for your workflow.

## Data model

```
scheduler/slots/{YYYY-MM-DDTHH:MM}/teams/{teamId}/
  createdAt:  epoch ms
  status:     "waiting" | "notified"
  notifiedAt: epoch ms          (present once emails have been sent)
  planner:  { name, email, institution, joinedAt }
  executor: { name, email, institution, joinedAt }
  verifier: { name, email, institution, joinedAt }
```

Every slot key is **UTC**. The timezone selector only affects display, so
participants in different zones always see the same underlying slot.
