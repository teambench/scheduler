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
  // Month currently displayed in the calendar, as {y, m} (1-indexed).
  displayMonth: null,
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
  calGrid: $("#cal-grid"),
  calPrev: $("#cal-prev"),
  calNext: $("#cal-next"),
  calTitle: $("#cal-title"),
  grid: $("#day-grid"),
  footTz: $("#foot-tz"),
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
  renderCalendar();
  renderDay();
});

// ─── Month calendar ──────────────────────────────────────────────────────

const DOW_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

// Normalize a (y, m, d) triple after adding `delta` days in the local
// calendar — uses Date.UTC for the rollover math (noon to dodge DST).
function addLocalDays(y, m, d, delta) {
  const norm = new Date(Date.UTC(y, m - 1, d + delta, 12, 0, 0));
  return {
    y: norm.getUTCFullYear(),
    m: norm.getUTCMonth() + 1,
    d: norm.getUTCDate(),
  };
}

// Build a 6-row × 7-col calendar grid for the given month in the chosen tz.
// Returns 42 cells, some in the previous/next month (flagged inMonth:false).
function buildMonthView(year, month) {
  // Find the weekday of the 1st of the month in the chosen tz. Use midnight
  // as the canonical instant; partsInTz gives us the correct local weekday.
  const firstMidUtc = localToUtc(year, month, 1, 0, 0, state.tz);
  const firstDow = DOW_INDEX[partsInTz(firstMidUtc, state.tz).dow] ?? 0;

  const cells = [];
  let cur = addLocalDays(year, month, 1, -firstDow);
  for (let i = 0; i < 42; i++) {
    const midUtc = localToUtc(cur.y, cur.m, cur.d, 0, 0, state.tz);
    const p = partsInTz(midUtc, state.tz);
    cells.push({
      date: midUtc,
      key: p.dateKey,
      day: +p.dd,
      inMonth: +p.m === month,
    });
    cur = addLocalDays(cur.y, cur.m, cur.d, 1);
  }
  return cells;
}

// Default display: today's month in the chosen tz. Navigation is bounded so
// users can't wander away from the ~2-month booking window.
function defaultDisplayMonth() {
  const p = partsInTz(new Date(), state.tz);
  return { y: +p.y, m: +p.m };
}
function monthFloor(y, m) { return y * 12 + (m - 1); }
function monthsDiff(a, b) { return monthFloor(b.y, b.m) - monthFloor(a.y, a.m); }

function renderCalendar() {
  if (!state.displayMonth) state.displayMonth = defaultDisplayMonth();
  const todayParts = partsInTz(new Date(), state.tz);
  const todayKey = `${todayParts.y}-${todayParts.m}-${todayParts.dd}`;
  if (!state.selectedLocalDate) state.selectedLocalDate = todayKey;

  // Bounds: current month (can't go before it) up to the last month that
  // contains any day within DAYS_AHEAD of today.
  const thisMonth = defaultDisplayMonth();
  const lastValidDate = addLocalDays(+todayParts.y, +todayParts.m, +todayParts.dd, DAYS_AHEAD - 1);
  const maxMonth = { y: lastValidDate.y, m: lastValidDate.m };

  el.calTitle.textContent = `${MONTH_NAMES[state.displayMonth.m - 1]} ${state.displayMonth.y}`;
  el.calPrev.disabled = monthsDiff(thisMonth, state.displayMonth) <= 0;
  el.calNext.disabled = monthsDiff(state.displayMonth, maxMonth) <= 0;

  const cells = buildMonthView(state.displayMonth.y, state.displayMonth.m);
  el.calGrid.innerHTML = "";
  for (const c of cells) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cal-cell";
    if (!c.inMonth) btn.classList.add("is-out");
    const cellTs = c.date.getTime();
    // "Past" means before today's local date (not just earlier clock time).
    if (c.key < todayKey) btn.classList.add("is-past");
    if (c.key === todayKey) btn.classList.add("is-today");
    if (c.key === state.selectedLocalDate) btn.classList.add("is-selected");
    // Out-of-window days beyond DAYS_AHEAD are shown but not bookable.
    const outOfWindow = c.key > lastValidDate.y + "-"
      + String(lastValidDate.m).padStart(2, "0") + "-"
      + String(lastValidDate.d).padStart(2, "0");
    if (outOfWindow) btn.classList.add("is-past");

    btn.innerHTML = `${c.day}<span class="cal-today-mark">today</span>`;

    const clickable = !btn.classList.contains("is-out")
                   && !btn.classList.contains("is-past");
    if (clickable) {
      btn.addEventListener("click", () => {
        state.selectedLocalDate = c.key;
        // If the click was on a neighbouring-month day, slide the calendar
        // to that month so the selection is visible.
        const p = c.key.split("-").map(Number);
        if (p[1] !== state.displayMonth.m || p[0] !== state.displayMonth.y) {
          state.displayMonth = { y: p[0], m: p[1] };
        }
        renderCalendar();
        renderDay();
      });
    } else {
      btn.disabled = true;
    }
    el.calGrid.appendChild(btn);
  }
}

el.calPrev.addEventListener("click", () => {
  if (!state.displayMonth) return;
  const prev = addLocalDays(state.displayMonth.y, state.displayMonth.m, 1, -1);
  state.displayMonth = { y: prev.y, m: prev.m };
  renderCalendar();
});
el.calNext.addEventListener("click", () => {
  if (!state.displayMonth) return;
  // Jump to the 1st of next month.
  const next = addLocalDays(state.displayMonth.y, state.displayMonth.m, 28, 7);
  state.displayMonth = { y: next.y, m: next.m };
  renderCalendar();
});

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

// Google Calendar "TEMPLATE" URL — opens Google Calendar pre-filled so the
// recipient can click it in their email and add the session to their own
// calendar with one click. Dates must be UTC in YYYYMMDDTHHMMSSZ format.
function googleCalendarUrl(slotUtc, { role } = {}) {
  const pad = n => String(n).padStart(2, "0");
  const fmtUtc = (d) =>
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  const endUtc = new Date(slotUtc.getTime() + SESSION_MINUTES * 60 * 1000);
  const title = role
    ? `TeamBench Team-mode — ${role}`
    : "TeamBench Team-mode session";
  const details = [
    role ? `Your role: ${role}` : "",
    "A 30-minute TeamBench team-mode collaboration session.",
    "Planner, Executor, and Verifier work together on one task.",
    `Join: ${emailjsConfig.sessionBaseUrl}${role ? `?role=${role}` : ""}`,
  ].filter(Boolean).join("\n\n");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${fmtUtc(slotUtc)}/${fmtUtc(endUtc)}`,
    details,
    location: emailjsConfig.sessionBaseUrl,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
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
    zoom_url: emailjsConfig.zoomUrl || "",
    slot_utc: slotUtc,
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
  // gcal_url is built per-recipient so the event title + description mention
  // the recipient's specific role when they "Add to calendar".
  const { slot_utc, ...commonRest } = common;
  const params = {
    ...commonRest,
    to_email: to.email,
    to_name: to.name,
    role,
    status_line: status,
    gcal_url: googleCalendarUrl(slot_utc, { role }),
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
renderCalendar();
renderDay();
subscribeToSlots();
