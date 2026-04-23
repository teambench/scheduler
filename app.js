// ─── TeamBench Scheduler ────────────────────────────────────────────────
// Single-file app: renders an availability grid for 30-minute Team-mode
// sessions, lets visitors sign up for a specific role, forms teams of
// three, and optionally notifies the team via EmailJS when full.
//
// Time model:
//   - Every slot key is an absolute UTC instant: "YYYY-MM-DDTHH:MM" UTC.
//   - The timezone picker only affects rendering — the underlying data is
//     timezone-agnostic. Two visitors in different zones see the same slot
//     (via the same UTC key) rendered in their own local time.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getDatabase, ref, push, set, get, update, onValue,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { firebaseConfig } from "./firebase-config.js";
import { emailjsConfig } from "./emailjs-config.js";

// ─── Setup ───────────────────────────────────────────────────────────────
const firebaseReady = firebaseConfig.apiKey && firebaseConfig.apiKey !== "__FIREBASE_API__";
let db = null;
if (firebaseReady) {
  const app = initializeApp(firebaseConfig);
  db = getDatabase(app);
}

const ROLES = ["planner", "executor", "verifier"];
const ROLE_DESCRIPTIONS = {
  planner:
    "Creates the plan and decides the approach. <strong>Does not edit code.</strong> " +
    "Communicates the plan to the Executor via chat and adjusts strategy based on " +
    "what the Verifier reports.",
  executor:
    "<strong>The only role that edits code and runs commands in the terminal.</strong> " +
    "Implements the Planner's instructions and responds to fix-requests from the Verifier.",
  verifier:
    "Reviews the Executor's code, runs tests, and decides whether the solution is " +
    "correct. Can send the work back to the Executor for fixes until the criteria " +
    "are met.",
};
const SESSION_MINUTES = 30;
const HOURS_START = 9;    // 9:00 local-day start
const HOURS_END = 24;     // up to (but not including) 24:00 → last slot 23:30
const SLOT_MINUTES = 30;
const DAYS_AHEAD = 62;    // ≈ 2 months

// Timezones the user can pick. We use IANA names + a short label.
const TIMEZONES = [
  { label: "Pacific (Seattle)",     tz: "America/Los_Angeles" },
  { label: "Mountain (Denver)",     tz: "America/Denver" },
  { label: "Central (Chicago)",     tz: "America/Chicago" },
  { label: "Eastern (New York)",    tz: "America/New_York" },
  { label: "UTC",                   tz: "UTC" },
  { label: "London",                tz: "Europe/London" },
  { label: "Berlin",                tz: "Europe/Berlin" },
  { label: "Korea (Seoul)",         tz: "Asia/Seoul" },
  { label: "Japan (Tokyo)",         tz: "Asia/Tokyo" },
  { label: "India (Kolkata)",       tz: "Asia/Kolkata" },
  { label: "Sydney",                tz: "Australia/Sydney" },
];

// ─── State ───────────────────────────────────────────────────────────────
const state = {
  // Currently selected IANA timezone for rendering.
  tz: detectInitialTz(),
  // Selected local date in the chosen timezone (YYYY-MM-DD).
  selectedLocalDate: null,
  // Window of dates shown in the top strip — starts on the first date shown.
  stripStart: null,
  // Full data snapshot: { slotKeyUTC: { teams: { teamId: {...} } } }
  slots: {},
  // Modal context: { slotKeyUTC, role, teamId|null }
  pendingSignup: null,
  pendingCancel: null,
};

function cachedEmail() {
  try {
    const cached = JSON.parse(localStorage.getItem("scheduler_profile") || "null");
    return cached?.email || null;
  } catch { return null; }
}

// ─── DOM handles ─────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const el = {
  tz: $("#tz-select"),
  dateTrack: $("#date-track"),
  datePrev: $("#date-prev"),
  dateNext: $("#date-next"),
  grid: $("#day-grid"),
  footTz: $("#foot-tz"),
  rolesHelp: $("#roles-help"),
  rolesModal: $("#roles-modal"),
  regModal: $("#register-modal"),
  regForm: $("#register-form"),
  regSummary: $("#reg-summary"),
  regRoleDesc: $("#reg-role-desc"),
  regMsg: $("#reg-msg"),
  regSubmit: $("#reg-submit"),
  cancelModal: $("#cancel-modal"),
  cancelForm: $("#cancel-form"),
  cancelSummary: $("#cancel-summary"),
  cancelMsg: $("#cancel-msg"),
  cancelSubmit: $("#cancel-submit"),
  toast: $("#toast"),
};

// ─── Timezone helpers ────────────────────────────────────────────────────

function detectInitialTz() {
  const auto = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (TIMEZONES.some(t => t.tz === auto)) return auto;
  return "America/Los_Angeles"; // Seattle default
}

// Return the local-time parts of a Date `d` in timezone `tz`.
//   → { y, m, dd, h, mm, dow } with zero-padded string fields where useful.
function partsInTz(d, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
  });
  const parts = {};
  for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
  return {
    y: parts.year,
    m: parts.month,
    dd: parts.day,
    h: parts.hour === "24" ? "00" : parts.hour, // some engines emit "24:00"
    mm: parts.minute,
    dow: parts.weekday,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

// Given local parts (year, month, day, hour, minute) in tz, return the
// UTC Date representing that wall-clock instant. Implementation: we compute
// the offset of `tz` at that approximate instant and apply it.
function localToUtc(y, m, d, h, min, tz) {
  // Start from the naive UTC interpretation of the wall clock.
  const utcGuess = Date.UTC(y, m - 1, d, h, min, 0);
  // What does that instant *look like* in the target zone?
  const p = partsInTz(new Date(utcGuess), tz);
  const asIfLocal = Date.UTC(+p.y, +p.m - 1, +p.dd, +p.h, +p.mm, 0);
  const offsetMs = utcGuess - asIfLocal;  // tz's offset east of UTC at that instant
  return new Date(utcGuess + offsetMs);
}

// Format a Date for display in the chosen timezone.
function formatTime(d, tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit",
  }).format(d);
}
function formatDateHuman(d, tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric",
    year: "numeric",
  }).format(d);
}
function formatTzShort(tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, timeZoneName: "short", hour: "numeric",
    }).formatToParts(new Date());
    return parts.find(p => p.type === "timeZoneName")?.value || tz;
  } catch { return tz; }
}

// YYYY-MM-DD in the current timezone for a given Date.
function dateKey(d, tz) { return partsInTz(d, tz).dateKey; }

// UTC slot key, e.g. "2026-05-02T21:00"
function utcSlotKey(utcDate) {
  const pad = n => String(n).padStart(2, "0");
  return `${utcDate.getUTCFullYear()}-${pad(utcDate.getUTCMonth() + 1)}-${pad(utcDate.getUTCDate())}T${pad(utcDate.getUTCHours())}:${pad(utcDate.getUTCMinutes())}`;
}
function utcSlotKeyToDate(key) {
  return new Date(`${key}:00Z`);
}

// ─── TZ picker ───────────────────────────────────────────────────────────

function renderTzSelect() {
  el.tz.innerHTML = "";
  for (const { tz, label } of TIMEZONES) {
    const opt = document.createElement("option");
    opt.value = tz;
    opt.textContent = `${label} (${formatTzShort(tz)})`;
    if (tz === state.tz) opt.selected = true;
    el.tz.appendChild(opt);
  }
  el.footTz.textContent = formatTzShort(state.tz);
}
el.tz.addEventListener("change", () => {
  state.tz = el.tz.value;
  // Preserve the user's rough date intent — snap to same calendar day in new tz.
  if (!state.selectedLocalDate) state.selectedLocalDate = dateKey(new Date(), state.tz);
  el.footTz.textContent = formatTzShort(state.tz);
  renderDateStrip();
  renderDay();
});

// ─── Date strip ──────────────────────────────────────────────────────────

// Returns an array of DAYS_AHEAD {date, key, dow, dd, m, y} entries, one per
// consecutive *local* calendar day in the chosen timezone. `date` is the
// UTC instant of midnight-local for that day. Advances by calendar day
// (not by a fixed 24-hour chunk) so DST boundaries don't duplicate or
// skip a date — on US fall-back days a naive `+24h` drifts into the
// previous day in the tz.
function buildDateList() {
  const out = [];
  const nowTzParts = partsInTz(new Date(), state.tz);
  let y = +nowTzParts.y, m = +nowTzParts.m, d = +nowTzParts.dd;
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const midnightUtc = localToUtc(y, m, d, 0, 0, state.tz);
    const p = partsInTz(midnightUtc, state.tz);
    out.push({ date: midnightUtc, key: p.dateKey, dow: p.dow, dd: p.dd, m: p.m, y: p.y });
    // Advance one local calendar day; normalize via Date.UTC to handle
    // month/year rollover (e.g. Dec 31 → Jan 1).
    d += 1;
    const norm = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    y = norm.getUTCFullYear();
    m = norm.getUTCMonth() + 1;
    d = norm.getUTCDate();
  }
  return out;
}

function renderDateStrip() {
  const dates = buildDateList();
  // Default selection: today.
  if (!state.selectedLocalDate) state.selectedLocalDate = dates[0].key;
  el.dateTrack.innerHTML = "";
  const todayKey = dates[0].key;
  for (const d of dates) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "date-pill";
    if (d.key === todayKey) pill.classList.add("is-today");
    if (d.key === state.selectedLocalDate) pill.classList.add("is-selected");
    pill.innerHTML = `
      <div class="dp-dow">${d.dow}</div>
      <div class="dp-day">${+d.dd}</div>
      <div class="dp-sub">${monthShort(+d.m)}</div>`;
    pill.addEventListener("click", () => {
      state.selectedLocalDate = d.key;
      renderDateStrip();
      renderDay();
    });
    el.dateTrack.appendChild(pill);
  }
  // Scroll the selected pill into view.
  const selected = el.dateTrack.querySelector(".is-selected");
  if (selected) selected.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
}
el.datePrev.addEventListener("click", () => { el.dateTrack.scrollBy({ left: -300, behavior: "smooth" }); });
el.dateNext.addEventListener("click", () => { el.dateTrack.scrollBy({ left: 300, behavior: "smooth" }); });

function monthShort(m) {
  return ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1];
}

// ─── Day grid ────────────────────────────────────────────────────────────

// Build the list of slot Date instants (UTC) that fall on the selected
// local date, between HOURS_START:00 and HOURS_END:00 local time.
function buildSlotsForSelectedDay() {
  if (!state.selectedLocalDate) return [];
  const [y, m, d] = state.selectedLocalDate.split("-").map(Number);
  const slots = [];
  for (let h = HOURS_START; h < HOURS_END; h++) {
    for (let mm = 0; mm < 60; mm += SLOT_MINUTES) {
      const utc = localToUtc(y, m, d, h, mm, state.tz);
      slots.push(utc);
    }
  }
  return slots;
}

function renderDay() {
  if (!firebaseReady) {
    el.grid.innerHTML = `
      <div class="config-banner">
        <b>Not yet configured.</b> Paste your Firebase Web API key into
        <code>firebase-config.js</code> to enable real-time availability.
        See <code>SETUP.md</code> for the 5-minute setup.
      </div>`;
    return;
  }
  const slots = buildSlotsForSelectedDay();
  el.grid.innerHTML = "";
  const headingDate = slots.length > 0 ? formatDateHuman(slots[0], state.tz) : "";
  const heading = document.createElement("div");
  heading.className = "day-heading";
  heading.innerHTML = `
    <h2>${headingDate}</h2>
    <div class="tz-note">Times in ${formatTzShort(state.tz)} · sessions are ${SESSION_MINUTES} min</div>`;
  el.grid.appendChild(heading);

  for (const slotDate of slots) {
    const key = utcSlotKey(slotDate);
    const slotEnd = new Date(slotDate.getTime() + SESSION_MINUTES * 60 * 1000);
    const row = document.createElement("div");
    row.className = "slot-row";

    const timeCell = document.createElement("div");
    timeCell.className = "slot-time";
    timeCell.innerHTML = `
      <span>${formatTime(slotDate, state.tz)}</span>
      <span class="stime-sep">–</span>
      <span>${formatTime(slotEnd, state.tz)}</span>`;
    row.appendChild(timeCell);

    const stack = document.createElement("div");
    stack.className = "team-stack";
    row.appendChild(stack);

    // Determine teams in this slot, or synthesize one empty team placeholder.
    const teams = state.slots[key]?.teams ?? {};
    const teamEntries = Object.entries(teams).sort((a, b) =>
      (a[1].createdAt || 0) - (b[1].createdAt || 0));

    // If there's an incomplete team (status=waiting), render that plus
    // (if all teams are full) an extra "+ start new team" stub. If no
    // teams yet, render one placeholder team.
    const display = teamEntries.length === 0
      ? [[null, null]]
      : [...teamEntries];

    const allComplete = teamEntries.length > 0
      && teamEntries.every(([, t]) => rolesFilledCount(t) === 3);
    if (allComplete) display.push([null, null]);

    display.forEach(([teamId, team], idx) => renderTeamRow(stack, {
      slotKey: key, slotUtc: slotDate, teamId, team,
      isNewTeamStub: team === null,
      teamIndex: idx,
      totalTeams: display.length,
    }));

    // Past-slot styling (disable sign-up).
    if (slotDate.getTime() < Date.now()) {
      row.style.opacity = "0.5";
      row.querySelectorAll(".role-slot.is-open").forEach(sl => {
        sl.classList.remove("is-open");
        sl.classList.add("is-filled");
      });
    }

    el.grid.appendChild(row);
  }
}

function rolesFilledCount(team) {
  if (!team) return 0;
  return ROLES.reduce((n, r) => n + (team[r] ? 1 : 0), 0);
}

function renderTeamRow(parent, { slotKey, slotUtc, teamId, team, isNewTeamStub, teamIndex, totalTeams }) {
  const row = document.createElement("div");
  row.className = "team-row";
  const filled = rolesFilledCount(team);
  if (filled === 3) row.classList.add("is-complete");

  for (const role of ROLES) {
    const cell = document.createElement("div");
    cell.className = `role-slot role-${role}`;
    const person = team && team[role];
    const label = document.createElement("span");
    label.className = "role-label";
    label.textContent = role;
    cell.appendChild(label);

    if (person) {
      cell.classList.add("is-filled");
      // If the current visitor's cached email matches, highlight the cell so
      // they know they can cancel this signup specifically.
      const mine = cachedEmail()
        && person.email
        && person.email.toLowerCase() === cachedEmail().toLowerCase();
      if (mine) cell.classList.add("is-mine");

      const line = document.createElement("span");
      line.className = "person-line";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = person.name;
      line.appendChild(nameSpan);
      if (person.institution) {
        const inst = document.createElement("span");
        inst.className = "person-inst";
        inst.textContent = ` · ${person.institution}`;
        line.appendChild(inst);
      }
      cell.appendChild(line);

      const lock = document.createElement("span");
      lock.className = "lock-ico";
      lock.setAttribute("aria-hidden", "true");
      lock.textContent = mine ? "✎" : "🔒"; // ✎ for own, 🔒 for others
      cell.title = mine
        ? "You signed up for this — click to cancel"
        : "This seat is taken — click to cancel (email verification required)";
      cell.appendChild(lock);

      cell.addEventListener("click", () =>
        openCancel({ slotKey, slotUtc, role, teamId, person }));
    } else {
      cell.classList.add("is-open");
      const action = document.createElement("span");
      action.className = "role-action";
      action.textContent = "Sign up";
      cell.appendChild(action);
      cell.addEventListener("click", () =>
        openRegister({ slotKey, slotUtc, role, teamId: isNewTeamStub ? null : teamId }));
    }
    row.appendChild(cell);
  }

  // Status pill column.
  const status = document.createElement("div");
  status.className = "team-status";
  if (totalTeams > 1) {
    const c = document.createElement("span");
    c.className = "team-count";
    c.textContent = `#${teamIndex + 1}`;
    status.appendChild(c);
  }
  const pill = document.createElement("span");
  pill.className = "status-pill";
  if (isNewTeamStub) {
    pill.classList.add("is-new");
    pill.textContent = totalTeams > 1 ? "New team" : "Open";
  } else if (filled === 3) {
    pill.classList.add("is-complete");
    pill.textContent = "Full";
  } else {
    pill.classList.add("is-waiting");
    pill.textContent = `${filled}/3`;
  }
  status.appendChild(pill);
  row.appendChild(status);
  parent.appendChild(row);
}

// ─── Registration modal ──────────────────────────────────────────────────

function openRegister({ slotKey, slotUtc, role, teamId }) {
  state.pendingSignup = { slotKey, slotUtc, role, teamId };
  const when = `${formatDateHuman(slotUtc, state.tz)} · ${formatTime(slotUtc, state.tz)} ${formatTzShort(state.tz)}`;
  el.regSummary.innerHTML = `
    <div><div class="role-chip role-${role}">${role}</div></div>
    <div class="reg-when">${when}</div>`;
  el.regRoleDesc.className = `reg-role-desc role-${role}`;
  el.regRoleDesc.innerHTML = ROLE_DESCRIPTIONS[role];
  el.regMsg.textContent = "";
  el.regMsg.classList.remove("ok");
  el.regForm.reset();
  prefillFromStorage();
  showModal(el.regModal);
  setTimeout(() => el.regForm.querySelector("[name=name]").focus(), 30);
}

function openCancel({ slotKey, slotUtc, role, teamId, person }) {
  state.pendingCancel = { slotKey, slotUtc, role, teamId };
  const when = `${formatDateHuman(slotUtc, state.tz)} · ${formatTime(slotUtc, state.tz)} ${formatTzShort(state.tz)}`;
  el.cancelSummary.innerHTML = `
    <div><div class="role-chip role-${role}">${role}</div> ${escapeHtml(person.name)}${person.institution ? ` · ${escapeHtml(person.institution)}` : ""}</div>
    <div class="reg-when">${when}</div>`;
  el.cancelMsg.textContent = "";
  el.cancelMsg.classList.remove("ok");
  el.cancelForm.reset();
  // Pre-fill if the visitor's cached email matches — saves one step.
  try {
    const cached = JSON.parse(localStorage.getItem("scheduler_profile") || "null");
    if (cached?.email) {
      el.cancelForm.querySelector("[name=email]").value = cached.email;
    }
  } catch { /* ignore */ }
  showModal(el.cancelModal);
  setTimeout(() => el.cancelForm.querySelector("[name=email]").focus(), 30);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function prefillFromStorage() {
  try {
    const cached = JSON.parse(localStorage.getItem("scheduler_profile") || "null");
    if (!cached) return;
    for (const k of ["name", "email", "institution"]) {
      const input = el.regForm.querySelector(`[name=${k}]`);
      if (input && cached[k]) input.value = cached[k];
    }
  } catch { /* ignore */ }
}

function showModal(m) { m.hidden = false; document.body.style.overflow = "hidden"; }
function hideModal(m) { m.hidden = true; document.body.style.overflow = ""; }

for (const m of [el.regModal, el.rolesModal, el.cancelModal]) {
  m.addEventListener("click", (ev) => {
    if (ev.target.hasAttribute("data-close")) hideModal(m);
  });
}
el.rolesHelp.addEventListener("click", () => showModal(el.rolesModal));

el.regForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!state.pendingSignup) return;
  const fd = new FormData(el.regForm);
  const profile = {
    name: String(fd.get("name") || "").trim(),
    email: String(fd.get("email") || "").trim(),
    institution: String(fd.get("institution") || "").trim(),
  };
  if (!profile.name || !profile.email || !profile.institution) {
    el.regMsg.textContent = "Please fill in all fields.";
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) {
    el.regMsg.textContent = "That email doesn't look right.";
    return;
  }

  el.regSubmit.disabled = true;
  el.regMsg.textContent = "Saving…";
  el.regMsg.classList.remove("ok");

  try {
    const result = await claimSlot(state.pendingSignup, profile);
    localStorage.setItem("scheduler_profile", JSON.stringify(profile));
    el.regMsg.classList.add("ok");
    if (result.teamFormed) {
      el.regMsg.textContent = "Team formed! Email confirmations are on the way.";
    } else {
      el.regMsg.textContent = `Got it — you're in as ${state.pendingSignup.role}. We'll email everyone when the team of 3 is complete.`;
    }
    setTimeout(() => hideModal(el.regModal), 1400);
    showToast(result.teamFormed ? "Team formed — emails sent" : "Sign-up confirmed", "ok");
  } catch (err) {
    console.error(err);
    el.regMsg.classList.remove("ok");
    el.regMsg.textContent = err.message || "Something went wrong. Please try again.";
  } finally {
    el.regSubmit.disabled = false;
  }
});

el.cancelForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!state.pendingCancel) return;
  const fd = new FormData(el.cancelForm);
  const email = String(fd.get("email") || "").trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    el.cancelMsg.textContent = "Please enter the email you signed up with.";
    return;
  }
  el.cancelSubmit.disabled = true;
  el.cancelMsg.textContent = "Removing your sign-up…";
  el.cancelMsg.classList.remove("ok");
  try {
    await releaseSlot(state.pendingCancel, email);
    el.cancelMsg.classList.add("ok");
    el.cancelMsg.textContent = "Done — you've been removed from this team.";
    setTimeout(() => hideModal(el.cancelModal), 1200);
    showToast("Sign-up cancelled", "ok");
  } catch (err) {
    console.error(err);
    el.cancelMsg.classList.remove("ok");
    el.cancelMsg.textContent = err.message || "Could not cancel — please try again.";
  } finally {
    el.cancelSubmit.disabled = false;
  }
});

async function releaseSlot({ slotKey, role, teamId }, email) {
  const teamRef = ref(db, `scheduler/slots/${slotKey}/teams/${teamId}`);
  const snap = await get(teamRef);
  if (!snap.exists()) throw new Error("This sign-up no longer exists.");
  const team = snap.val();
  const p = team[role];
  if (!p) throw new Error("That role is already empty.");
  if (p.email.toLowerCase() !== email.toLowerCase()) {
    throw new Error("That email doesn't match the sign-up on file.");
  }

  // If the team had been marked complete/notified, cancelling one seat means
  // it's no longer full — revert status so the remaining two can be joined
  // by someone else.
  const newStatus = ROLES.every(r => r === role ? false : !!team[r])
    ? "waiting"  // was full, becomes 2-of-3
    : team.status || "waiting";

  // Null out the role slot. If the team has no members left after removal,
  // delete the whole team entry to keep the grid tidy.
  const remainingRoles = ROLES.filter(r => r !== role && team[r]);
  if (remainingRoles.length === 0) {
    await set(teamRef, null);
  } else {
    await update(teamRef, { [role]: null, status: newStatus, notifiedAt: null });
  }
}

// ─── Claim logic (with a light read-then-write race check) ───────────────

async function claimSlot({ slotKey, role, teamId }, profile) {
  const snap = await get(ref(db, `scheduler/slots/${slotKey}/teams`));
  const teams = snap.exists() ? snap.val() : {};

  // Prevent a person signing up twice for the same slot.
  for (const [tid, t] of Object.entries(teams)) {
    for (const r of ROLES) {
      if (t[r] && t[r].email.toLowerCase() === profile.email.toLowerCase()) {
        throw new Error(`This email is already signed up for this slot (as ${r}).`);
      }
    }
  }

  let targetTeamId = teamId;

  // If the caller provided a teamId but that role is already taken
  // (race: someone else claimed it between render and click), fall back to
  // the generic "find first waiting team that needs this role" search.
  if (targetTeamId && teams[targetTeamId]?.[role]) targetTeamId = null;

  if (!targetTeamId) {
    for (const [tid, t] of Object.entries(teams)) {
      if (!t[role] && rolesFilledCount(t) < 3) { targetTeamId = tid; break; }
    }
  }

  const person = { ...profile, joinedAt: Date.now() };

  let created = false;
  if (!targetTeamId) {
    const newRef = push(ref(db, `scheduler/slots/${slotKey}/teams`));
    targetTeamId = newRef.key;
    await set(newRef, {
      createdAt: Date.now(),
      status: "waiting",
      [role]: person,
    });
    created = true;
  } else {
    await update(ref(db, `scheduler/slots/${slotKey}/teams/${targetTeamId}`), {
      [role]: person,
    });
  }

  // Re-read the team to decide if it's now full.
  const teamSnap = await get(ref(db, `scheduler/slots/${slotKey}/teams/${targetTeamId}`));
  const team = teamSnap.val() || {};
  const isFull = ROLES.every(r => team[r]);

  if (isFull && team.status !== "notified") {
    await update(ref(db, `scheduler/slots/${slotKey}/teams/${targetTeamId}`), {
      status: "notified",
      notifiedAt: Date.now(),
    });
  }

  // Fire notification emails. Errors are non-fatal — participants still see
  // their UI confirmation; the console logs the reason.
  try {
    await notifySignup({ slotKey, team, role, person, isFull });
    if (isFull) {
      // Also tell the other two (the one who just filled the team already
      // got the team-complete message inside notifySignup above).
      await notifyTeammatesOfCompletion({ slotKey, team, excludeEmail: person.email });
    }
  } catch (e) {
    console.warn("Email notification failed:", e);
  }

  return { teamFormed: isFull, created, teamId: targetTeamId };
}

// ─── EmailJS notification ────────────────────────────────────────────────

async function ensureEmailJsLoaded() {
  if (window.emailjs) return window.emailjs;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("EmailJS SDK failed to load"));
    document.head.appendChild(s);
  });
  window.emailjs.init({ publicKey: emailjsConfig.publicKey });
  return window.emailjs;
}

function emailjsReady() {
  // Deploy-time placeholders look like "__EMAILJS_*__"; treat any remaining
  // placeholder (or an empty string) as "not configured" so sign-ups still
  // succeed during local dev before secrets have been injected.
  const isPlaceholder = (v) => !v || /^__[A-Z_]+__$/.test(v);
  return !isPlaceholder(emailjsConfig.publicKey)
      && !isPlaceholder(emailjsConfig.serviceId)
      && !isPlaceholder(emailjsConfig.templateId);
}

function buildEmailCommon(slotKey, team) {
  const slotUtc = utcSlotKeyToDate(slotKey);
  const whenLocal = `${formatDateHuman(slotUtc, state.tz)} · ${formatTime(slotUtc, state.tz)} ${formatTzShort(state.tz)}`;
  const whenUtc = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(slotUtc) + " UTC";

  // For roles that aren't filled yet we ship "(pending)" so the template
  // can render the current state even for mid-team signup emails without
  // needing conditional logic.
  const pending = "(pending)";
  return {
    session_when: whenLocal,
    session_when_utc: whenUtc,
    session_url: emailjsConfig.sessionBaseUrl,
    planner_name:  team.planner?.name  || pending,
    planner_email: team.planner?.email || "",
    executor_name:  team.executor?.name  || pending,
    executor_email: team.executor?.email || "",
    verifier_name:  team.verifier?.name  || pending,
    verifier_email: team.verifier?.email || "",
  };
}

async function sendOne({ to, role, common, status }) {
  const emailjs = await ensureEmailJsLoaded();
  const params = {
    ...common,
    to_email: to.email,
    to_name: to.name,
    role,
    status_line: status,
  };
  await emailjs.send(emailjsConfig.serviceId, emailjsConfig.templateId, params);
}

async function notifySignup({ slotKey, team, role, person, isFull }) {
  if (!emailjsReady()) {
    console.info("EmailJS not configured — skipping signup confirmation.");
    return;
  }
  const common = buildEmailCommon(slotKey, team);
  const filled = rolesFilledCount(team);
  const remaining = 3 - filled;
  const status = isFull
    ? "Your team of three is complete — you're all set!"
    : `You're signed up as ${role}. Waiting on ${remaining} more ${remaining === 1 ? "person" : "people"} to complete the team.`;
  await sendOne({ to: person, role, common, status });
}

async function notifyTeammatesOfCompletion({ slotKey, team, excludeEmail }) {
  if (!emailjsReady()) return;
  const common = buildEmailCommon(slotKey, team);
  const status = "Your team of three is now complete!";
  for (const r of ROLES) {
    const p = team[r];
    if (!p) continue;
    if (excludeEmail && p.email.toLowerCase() === excludeEmail.toLowerCase()) continue;
    await sendOne({ to: p, role: r, common, status });
  }
}

// ─── Toast ───────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, kind = "") {
  el.toast.textContent = msg;
  el.toast.className = "toast";
  if (kind) el.toast.classList.add(`is-${kind}`);
  el.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3200);
}

// ─── Live subscription ───────────────────────────────────────────────────

function subscribeToSlots() {
  if (!db) return;
  onValue(ref(db, "scheduler/slots"), (snap) => {
    state.slots = snap.exists() ? snap.val() : {};
    renderDay();
  });
}

// ─── Boot ────────────────────────────────────────────────────────────────

renderTzSelect();
renderDateStrip();
renderDay();
subscribeToSlots();
