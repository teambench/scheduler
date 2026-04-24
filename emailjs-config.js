// ─── EmailJS config ─────────────────────────────────────────────────────
// Used to send a "Team formed" email when all three roles for a slot are
// filled. EmailJS is a free/cheap service that sends emails directly from
// the browser using a public key — no backend required.
//
// Setup (≈5 min):
//   1. Create an account at https://www.emailjs.com
//   2. Add an email service (Gmail, SendGrid, Mailgun, or SMTP)
//   3. Create an email template. Expected template variables:
//        {{to_email}}        — recipient (EmailJS sends once per recipient)
//        {{to_name}}         — recipient's name
//        {{session_when}}    — e.g. "Fri, May 2 · 2:00 PM PDT"
//        {{session_when_utc}}— e.g. "2026-05-02 21:00 UTC"
//        {{role}}            — planner | executor | verifier
//        {{planner_name}}, {{planner_email}}
//        {{executor_name}}, {{executor_email}}
//        {{verifier_name}}, {{verifier_email}}
//        {{session_url}}     — link to the actual session (see below)
//   4. Copy the Service ID, Template ID, and Public Key into this file.
//
// If you leave `enabled` as false (or any of the IDs blank), sign-ups still
// work — the scheduler just skips the email step. This is fine for testing.

// The placeholders below are replaced at deploy time by the GitHub Actions
// workflow (.github/workflows/deploy.yml) from repository secrets. If any
// placeholder is left in the string (e.g. during local development), that
// section is treated as disabled and the scheduler skips sending email.
export const emailjsConfig = {
  publicKey:  "__EMAILJS_PUBLIC_KEY__",
  serviceId:  "__EMAILJS_SERVICE_ID__",
  templateId: "__EMAILJS_TEMPLATE_ID__",

  // Link inserted as {{session_url}} in the email. Participants visit this
  // URL at the scheduled time with role=planner|executor|verifier to join
  // the actual team-mode session.
  sessionBaseUrl: "https://teambench.github.io/human-eval/",

  // Personal Zoom (or other video call) link inserted as {{zoom_url}} in
  // the email so teammates can jump on a call together. Leave blank to
  // skip it — the template will render an empty string.
  zoomUrl: "https://mit.zoom.us/j/91350274472",
};
