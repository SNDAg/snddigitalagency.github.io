/* ============================================================================
   CALENDAR-IT — Cloudflare Worker

   Turns Facebook-feed screenshots into calendar events, with zero typing.

   Flow:
     1. User screenshots an event post on their phone, shares it into a
        Google Drive folder (default name "CalendarIt", see DRIVE_FOLDER_NAME
        in wrangler.toml) - a normal Android/iOS share-sheet action.
     2. A cron trigger (every 5 min, see [triggers] in wrangler.toml) polls
        that Drive folder for new images via syncOnce().
     3. Each new image is sent to a Workers AI vision model
        (@cf/meta/llama-3.2-11b-vision-instruct) with a prompt asking it to
        read the (mostly Hebrew) text and return structured JSON: title,
        location, day/month/year, hour/minute. Israeli screenshots write
        dates as day.month (e.g. "14.9"), never month.day - the prompt says
        so explicitly.
     4. resolveEventDateTime() fills in a missing year (assumes "next
        occurrence" of that day/month) and decides all-day vs timed.
     5. The event is inserted straight into the user's Google Calendar
        (primary) via the Calendar API. An .ics file is ALSO always
        generated and stored in KV, so there is a manual fallback if the
        auto-insert fails, the extraction needs a human glance, or the user
        just wants to hand a specific event's .ics to their phone.
     6. Once extraction succeeds (so the .ics fallback already exists), the
        source screenshot is moved to Drive's trash (trashDriveFile) - it
        did its job and just clutters the folder otherwise. Left in place
        when extraction fails/needs review, since it's the only copy a
        human can still check. Two plain-text logs are kept up to date in
        the same Drive folder (see refreshDriveLogs, rebuilt from the KV
        events index on every run that processes at least one file):
        calendar-it-log.txt (what got added to/removed from the calendar,
        and whether the image was kept or trashed) and
        calendar-it-errors.txt (everything the AI couldn't extract
        cleanly, WITH the raw model output, for debugging without
        re-fetching the image).
     7. GET / is a small dashboard (this IS the "known URL": open it,
        tap "Sync now" or tap an event's "Add to calendar" button to pull
        a fresh .ics onto the phone) - covers both flows from the brief.
        It also lists recent events with a filter bar (all / last 7 days /
        needs review) and a delete button per added event, which calls
        DELETE on the Calendar API (see /delete-event, deleteCalendarEvent)
        and updates both the dashboard and the Drive logs to match.

   Auth model:
     - Google Drive (full - see OAUTH_SCOPES, needed to trash files and
       write the log) + Google Calendar (events) access uses a standard
       OAuth "installed app" flow that the Worker itself hosts at
       /auth/start and /auth/callback - no separate script to run. The
       resulting refresh_token lives in KV (key "oauth:tokens") and access
       tokens are refreshed on demand (see getAccessToken).
     - The dashboard itself (everything except /ics/:id, which uses an
       unguessable id so a phone can open it with zero login friction) is
       gated behind a single shared secret, DASHBOARD_KEY (wrangler secret
       put DASHBOARD_KEY), remembered via an HttpOnly cookie after the first
       ?key=... visit. This is a personal single-user tool, not a multi-
       tenant product - one shared key is intentionally the whole auth
       model.

   KV layout (single namespace, binding CAL_KV):
     oauth:tokens        -> { access_token, refresh_token, expires_at }
     drive:folder_id      -> cached Drive folder id (found by name once)
     sync:last_check       -> ISO timestamp watermark, syncOnce() only looks
                              at files modified after (this - 10min overlap)
     seen:<driveFileId>    -> "1", marks a Drive file already processed so a
                              cron overlap never double-inserts a calendar
                              event (expires after 90 days - Drive file ids
                              are never reused, so this only bounds KV size)
     events:index          -> JSON array of the last 100 processed events,
                              newest first, for the dashboard list
     ics:<eventId>          -> raw .ics text served by /ics/:id
     drive:log_file_id      -> cached id of calendar-it-log.txt (found/created once)
     drive:error_log_file_id -> cached id of calendar-it-errors.txt (found/created once)
   ============================================================================ */

const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // vision input is sent as a JSON number array - keep this modest
// Full (not readonly) Drive scope - needed to trash the source screenshot after it becomes an
// event and to create/update the activity log file, both written into the same Drive folder.
// If you connected before this scope changed, reconnect once via "התחבר עם Google" to upgrade.
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ');
const EVENTS_INDEX_CAP = 100;
const SYNC_OVERLAP_MS = 10 * 60 * 1000; // re-check the last 10min of Drive listings every run, dedup via seen:*

// ============================================================================
// Small utilities
// ============================================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// ============================================================================
// Access gate (single shared-secret cookie, see header comment)
// ============================================================================

function isAuthorized(request, env) {
  if (!env.DASHBOARD_KEY) return true; // no key configured - open access (local dev convenience)
  const url = new URL(request.url);
  if (url.searchParams.get('key') === env.DASHBOARD_KEY) return true;
  return getCookie(request, 'cal_key') === env.DASHBOARD_KEY;
}

function loginPage(error) {
  return html(`<!doctype html><html lang="he" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Calendar-It — התחברות</title>
${FAVICON_LINK}
${BASE_STYLE}
</head><body><div class="wrap"><div class="card" style="max-width:360px;margin:15vh auto">
<h1 style="margin-top:0">🗓️ Calendar-It</h1>
${error ? `<p class="badge badge-warn">קוד שגוי, נסה שוב</p>` : ''}
<form method="POST" action="/login">
<input type="password" name="key" placeholder="קוד גישה" autofocus required
  style="width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid var(--border);font-size:16px;margin-bottom:12px;background:var(--bg)">
<button class="btn btn-primary" style="width:100%" type="submit">כניסה</button>
</form>
</div></div></body></html>`, error ? 401 : 200);
}

// ============================================================================
// Google OAuth (Worker hosts the whole flow - no separate script to run)
// ============================================================================

async function getStoredTokens(env) {
  return (await env.CAL_KV.get('oauth:tokens', 'json')) || null;
}

async function saveTokens(env, tokens) {
  await env.CAL_KV.put('oauth:tokens', JSON.stringify(tokens));
}

async function getAccessToken(env) {
  const tokens = await getStoredTokens(env);
  if (!tokens || !tokens.refresh_token) {
    const err = new Error('not_connected');
    err.code = 'not_connected';
    throw err;
  }
  if (tokens.expires_at - Date.now() > 60_000) {
    return tokens.access_token;
  }
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(`token_refresh_failed: ${text}`);
    err.code = 'not_connected';
    throw err;
  }
  const data = await resp.json();
  const updated = {
    access_token: data.access_token,
    refresh_token: tokens.refresh_token, // refresh responses never include a new refresh_token
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };
  await saveTokens(env, updated);
  return updated.access_token;
}

function oauthRedirectUri(url) {
  return `${url.origin}/auth/callback`;
}

async function handleAuthStart(request, env) {
  const url = new URL(request.url);
  if (!env.GOOGLE_CLIENT_ID) {
    return html('<p style="font-family:sans-serif;padding:2rem">חסר GOOGLE_CLIENT_ID — הרץ <code>wrangler secret put GOOGLE_CLIENT_ID</code> קודם.</p>', 500);
  }
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: oauthRedirectUri(url),
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: OAUTH_SCOPES,
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
}

async function handleAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const oauthError = url.searchParams.get('error');
  if (oauthError) return html(`<p style="font-family:sans-serif;padding:2rem">Google דחה את ההרשאה: ${escapeHtml(oauthError)}</p>`, 400);
  if (!code) return html('<p style="font-family:sans-serif;padding:2rem">חסר קוד הרשאה בבקשה החוזרת.</p>', 400);

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: oauthRedirectUri(url),
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    return html(`<p style="font-family:sans-serif;padding:2rem">חיבור ל-Google נכשל:<br><pre>${escapeHtml(text)}</pre></p>`, 400);
  }
  const data = await resp.json();
  const existing = await getStoredTokens(env);
  await saveTokens(env, {
    access_token: data.access_token,
    refresh_token: data.refresh_token || existing?.refresh_token, // Google only re-sends it sometimes
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  });
  return Response.redirect(`${url.origin}/`, 302);
}

// ============================================================================
// Google Drive
// ============================================================================

async function driveApi(accessToken, path, opts = {}) {
  const resp = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`drive_api_${resp.status}: ${text}`);
  }
  return resp;
}

async function findFolderId(env, accessToken) {
  const cached = await env.CAL_KV.get('drive:folder_id');
  if (cached) return cached;

  const folderName = env.DRIVE_FOLDER_NAME || 'CalendarIt';
  const q = `name='${folderName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const resp = await driveApi(accessToken, `files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=5`);
  const data = await resp.json();
  if (!data.files || data.files.length === 0) return null;
  const id = data.files[0].id;
  await env.CAL_KV.put('drive:folder_id', id);
  return id;
}

async function listNewImages(accessToken, folderId, sinceISO) {
  const q = `'${folderId}' in parents and trashed=false and mimeType contains 'image/' and modifiedTime > '${sinceISO}'`;
  const fields = 'files(id,name,mimeType,modifiedTime,webViewLink)';
  const resp = await driveApi(accessToken, `files?q=${encodeURIComponent(q)}&fields=${fields}&orderBy=modifiedTime&pageSize=50`);
  const data = await resp.json();
  return data.files || [];
}

async function downloadFile(accessToken, fileId) {
  const resp = await driveApi(accessToken, `files/${fileId}?alt=media`);
  return resp.arrayBuffer();
}

// Moves the source screenshot to Drive's trash (recoverable for ~30 days) rather than a
// permanent files.delete - this is a new AI feature acting on a single vision-model read of
// the image, so keeping a recovery window for a bad extraction/wrong-file case felt safer
// than an irreversible delete. Ask to switch to permanent delete if you'd rather not keep it.
async function trashDriveFile(accessToken, fileId) {
  await driveApi(accessToken, `files/${fileId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}

// Two separate log files, both in the same Drive folder as the screenshots:
//   calendar-it-log.txt    - what made it into (or out of) the calendar: added/deleted, when,
//                            title/date/location, whether the source image was kept or trashed.
//   calendar-it-errors.txt - everything the AI extraction couldn't handle cleanly, WITH the raw
//                            model output/error, so you (or I, debugging later) can see exactly
//                            why without needing to reprocess the image.
const SUCCESS_LOG_NAME = 'calendar-it-log.txt';
const ERROR_LOG_NAME = 'calendar-it-errors.txt';

async function findOrCreateNamedFile(env, kvKey, accessToken, folderId, fileName, initialText) {
  const cached = await env.CAL_KV.get(kvKey);
  if (cached) return cached;

  const q = `'${folderId}' in parents and name='${fileName}' and trashed=false`;
  const resp = await driveApi(accessToken, `files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`);
  const data = await resp.json();
  let id = data.files?.[0]?.id;

  if (!id) {
    const boundary = `calit_${crypto.randomUUID()}`;
    const metadata = { name: fileName, parents: [folderId], mimeType: 'text/plain' };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
      + `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${initialText}\r\n--${boundary}--`;
    const createResp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'content-type': `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!createResp.ok) throw new Error(`drive_file_create_failed_${createResp.status}: ${await createResp.text()}`);
    id = (await createResp.json()).id;
  }
  await env.CAL_KV.put(kvKey, id);
  return id;
}

async function writeLogFile(accessToken, fileId, text) {
  const resp = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'text/plain; charset=UTF-8' },
    body: text,
  });
  if (!resp.ok) throw new Error(`drive_log_write_failed_${resp.status}: ${await resp.text()}`);
}

function formatWhen(record) {
  return record.startDate
    ? `${record.startDate.split('-').reverse().join('.')}${record.allDay ? '' : ' ' + pad(record.startHour) + ':' + pad(record.startMinute)}`
    : '—';
}

function formatSuccessLogLine(record) {
  const ts = (record.createdAt || '').replace('T', ' ').slice(0, 16);
  const statusText = {
    added: 'נוסף ליומן אוטומטית',
    ics_only: 'חולץ בהצלחה, ICS מוכן (ההוספה האוטומטית ליומן נכשלה)',
    deleted_from_calendar: `נמחק מהיומן ידנית${record.deletedAt ? ' ב-' + record.deletedAt.replace('T', ' ').slice(0, 16) : ''}`,
  }[record.status] || record.status;
  const imgNote = record.imageDeleted ? 'התמונה הועברה לפח בתיקייה' : 'התמונה נשארה בתיקייה';
  return [
    `[${ts}]`, statusText, '|', record.title || record.fileName, '|', formatWhen(record), '|', record.location || '—',
    '|', `מקור: ${record.fileName}`, '|', imgNote,
  ].join(' ');
}

function buildSuccessLogText(events) {
  const header = 'Calendar-It — אירועים שנוספו/נמחקו מהיומן (הכי חדש למעלה)\r\n' + '='.repeat(60) + '\r\n\r\n';
  if (events.length === 0) return header + '(עדיין אין אירועים)\r\n';
  return header + events.map(formatSuccessLogLine).join('\r\n') + '\r\n';
}

function formatErrorLogLine(record) {
  const ts = (record.createdAt || '').replace('T', ' ').slice(0, 16);
  const statusText = record.status === 'error' ? 'שגיאת עיבוד' : 'דורש בדיקה ידנית';
  const imgNote = record.imageDeleted ? 'התמונה הועברה לפח' : 'התמונה עדיין בתיקייה';
  const lines = [
    `[${ts}] ${statusText} | קובץ: ${record.fileName} | ${imgNote} | קישור לתמונה: ${record.driveLink}`,
    `  סיבה: ${record.error || 'לא ידועה'}`,
  ];
  if (record.rawText) lines.push(`  פלט גולמי מה-AI: ${record.rawText.replace(/\r?\n/g, ' \\n ')}`);
  return lines.join('\r\n');
}

function buildErrorLogText(events) {
  const header = 'Calendar-It — כשלונות חילוץ (הכי חדש למעלה)\r\n' + '='.repeat(60) + '\r\n\r\n';
  if (events.length === 0) return header + '(אין כשלונות רשומים)\r\n';
  return header + events.map(formatErrorLogLine).join('\r\n\r\n') + '\r\n';
}

const SUCCESS_STATUSES = new Set(['added', 'ics_only', 'deleted_from_calendar']);
const FAILURE_STATUSES = new Set(['needs_review', 'error']);

async function refreshDriveLogs(env, accessToken, folderId) {
  const allEvents = await getEventsIndex(env);
  const successLogId = await findOrCreateNamedFile(
    env, 'drive:log_file_id', accessToken, folderId, SUCCESS_LOG_NAME, 'Calendar-It — אירועים שנוספו/נמחקו מהיומן\r\n\r\n',
  );
  await writeLogFile(accessToken, successLogId, buildSuccessLogText(allEvents.filter((r) => SUCCESS_STATUSES.has(r.status))));

  const errorLogId = await findOrCreateNamedFile(
    env, 'drive:error_log_file_id', accessToken, folderId, ERROR_LOG_NAME, 'Calendar-It — כשלונות חילוץ\r\n\r\n',
  );
  await writeLogFile(accessToken, errorLogId, buildErrorLogText(allEvents.filter((r) => FAILURE_STATUSES.has(r.status))));
}

// ============================================================================
// Google Calendar
// ============================================================================

// Google Calendar's 11 fixed event colors are a stable, undocumented-by-id-name-in-the-API-
// response palette (colorId "5" = "Banana", the yellow one in Calendar's own color picker).
const EVENT_COLOR_ID_YELLOW = '5';

async function insertCalendarEvent(accessToken, ev) {
  const body = {
    summary: ev.title,
    location: ev.location || undefined,
    description: ev.description,
    colorId: EVENT_COLOR_ID_YELLOW,
    start: ev.allDay ? { date: ev.startDate } : { dateTime: `${ev.startDate}T${pad(ev.startHour)}:${pad(ev.startMinute)}:00`, timeZone: 'Asia/Jerusalem' },
    end: ev.allDay ? { date: ev.endDate } : { dateTime: `${ev.endDate}T${pad(ev.endHour)}:${pad(ev.endMinute)}:00`, timeZone: 'Asia/Jerusalem' },
  };
  const resp = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`calendar_insert_failed_${resp.status}: ${text}`);
  }
  return resp.json();
}

async function deleteCalendarEvent(accessToken, calendarEventId) {
  const resp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${calendarEventId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  // 410/404 means it's already gone (e.g. deleted by hand in Google Calendar already) - treat as success.
  if (!resp.ok && resp.status !== 410 && resp.status !== 404) {
    throw new Error(`calendar_delete_failed_${resp.status}: ${await resp.text()}`);
  }
}

// ============================================================================
// Vision extraction (Workers AI)
// ============================================================================

const EXTRACTION_PROMPT = `You are reading a screenshot from a social-media feed (usually Facebook) that advertises an event. The text is mostly Hebrew, sometimes mixed with English or numbers.

Respond with ONLY a single valid JSON object (no markdown fences, no explanation) in exactly this shape:
{"title": string|null, "location": string|null, "day": number|null, "month": number|null, "year": number|null, "hour": number|null, "minute": number|null, "raw_text": string}

Rules:
- Dates are written in Israeli day.month order (e.g. "14.9" means day=14, month=9) - NEVER month.day.
- "title" is the performer/show/event name only - do not include the date, time or venue in it.
- "location" is the venue/place name. Strip a leading Hebrew "ב" prefix meaning "at" (e.g. "בבית החייל" -> "בית החייל").
- If no year is shown in the image, set "year" to null (do not guess a year).
- If no time is shown, set "hour" and "minute" to null.
- "raw_text" must contain all readable text from the image, unmodified, so a human can double check your extraction.
- If you cannot find any date in the image, set "day" and "month" to null.
Respond with the JSON object only.`;

async function extractEventFromImage(env, arrayBuffer) {
  if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
    return { error: 'image_too_large' };
  }
  const image = Array.from(new Uint8Array(arrayBuffer));
  let result;
  try {
    result = await env.AI.run(VISION_MODEL, {
      image,
      prompt: EXTRACTION_PROMPT,
      max_tokens: 512,
      temperature: 0,
    });
  } catch (err) {
    return { error: 'ai_call_failed', detail: String(err) };
  }
  const text = result?.response || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { error: 'no_json_in_response', raw: text };
  try {
    // The model sometimes writes zero-padded numbers (e.g. "minute": 09), which is a real
    // event - Hebrew screenshots often show times like 17:09 - but invalid JSON (a number
    // literal can't have a leading zero). Strip the padding before parsing: "09" -> "9".
    const sanitized = match[0].replace(/:(\s*)0+(\d)/g, ':$1$2');
    const parsed = JSON.parse(sanitized);
    return { data: parsed };
  } catch (err) {
    return { error: 'json_parse_failed', raw: text };
  }
}

// ============================================================================
// Date resolution + ICS generation
// ============================================================================

function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function addHoursWallClock(dateStr, hour, minute, hoursToAdd) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, hour, minute));
  dt.setUTCHours(dt.getUTCHours() + hoursToAdd);
  return {
    dateStr: `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`,
    hour: dt.getUTCHours(),
    minute: dt.getUTCMinutes(),
  };
}

// Fills in a missing year (assumes the next upcoming occurrence of that day/month) and
// decides all-day vs timed based on whether the model found a clock time.
function resolveEventDateTime(fields, now = new Date()) {
  const day = Number(fields.day);
  const month = Number(fields.month);
  if (!Number.isInteger(day) || !Number.isInteger(month) || day < 1 || day > 31 || month < 1 || month > 12) {
    return null;
  }
  let year = Number.isInteger(Number(fields.year)) ? Number(fields.year) : null;
  if (!year) {
    const candidateUTC = Date.UTC(now.getUTCFullYear(), month - 1, day);
    const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    year = candidateUTC < todayUTC - 24 * 3600 * 1000 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  }
  const startDate = `${year}-${pad(month)}-${pad(day)}`;
  const hasTime = Number.isInteger(Number(fields.hour));
  if (!hasTime) {
    return { allDay: true, startDate, endDate: addDaysToDateStr(startDate, 1) };
  }
  const startHour = Math.min(23, Math.max(0, Number(fields.hour)));
  const startMinute = Number.isInteger(Number(fields.minute)) ? Math.min(59, Math.max(0, Number(fields.minute))) : 0;
  const end = addHoursWallClock(startDate, startHour, startMinute, 2); // default 2h duration - screenshots rarely state an end time
  return {
    allDay: false,
    startDate, startHour, startMinute,
    endDate: end.dateStr, endHour: end.hour, endMinute: end.minute,
  };
}

function escapeIcsText(str) {
  return String(str ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function foldIcsLine(line) {
  if (line.length <= 74) return line;
  let out = line.slice(0, 74);
  let rest = line.slice(74);
  while (rest.length > 0) {
    out += `\r\n ${rest.slice(0, 73)}`;
    rest = rest.slice(73);
  }
  return out;
}

function buildIcs({ uid, title, location, description, dt }) {
  const now = new Date();
  const dtstamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Calendar-It//HE', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT'];
  lines.push(`UID:${uid}@calendar-it`);
  lines.push(`DTSTAMP:${dtstamp}`);
  if (dt.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${dt.startDate.replace(/-/g, '')}`);
    lines.push(`DTEND;VALUE=DATE:${dt.endDate.replace(/-/g, '')}`);
  } else {
    lines.push(`DTSTART;TZID=Asia/Jerusalem:${dt.startDate.replace(/-/g, '')}T${pad(dt.startHour)}${pad(dt.startMinute)}00`);
    lines.push(`DTEND;TZID=Asia/Jerusalem:${dt.endDate.replace(/-/g, '')}T${pad(dt.endHour)}${pad(dt.endMinute)}00`);
  }
  lines.push(`SUMMARY:${escapeIcsText(title)}`);
  if (location) lines.push(`LOCATION:${escapeIcsText(location)}`);
  if (description) lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

// ============================================================================
// Sync orchestrator
// ============================================================================

async function getEventsIndex(env) {
  return (await env.CAL_KV.get('events:index', 'json')) || [];
}

async function pushEventRecord(env, record) {
  const index = await getEventsIndex(env);
  index.unshift(record);
  await env.CAL_KV.put('events:index', JSON.stringify(index.slice(0, EVENTS_INDEX_CAP)));
}

async function updateEventRecord(env, id, patch) {
  const index = await getEventsIndex(env);
  const i = index.findIndex((r) => r.id === id);
  if (i === -1) return null;
  index[i] = { ...index[i], ...patch };
  await env.CAL_KV.put('events:index', JSON.stringify(index));
  return index[i];
}

async function syncOnce(env) {
  let accessToken;
  try {
    accessToken = await getAccessToken(env);
  } catch (err) {
    return { ok: false, reason: 'not_connected' };
  }

  const folderId = await findFolderId(env, accessToken);
  if (!folderId) {
    return { ok: false, reason: 'folder_not_found', folderName: env.DRIVE_FOLDER_NAME || 'CalendarIt' };
  }

  const lastCheck = (await env.CAL_KV.get('sync:last_check')) || new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const since = new Date(new Date(lastCheck).getTime() - SYNC_OVERLAP_MS).toISOString();
  const files = await listNewImages(accessToken, folderId, since);

  const processed = [];
  for (const file of files) {
    const seenKey = `seen:${file.id}`;
    if (await env.CAL_KV.get(seenKey)) continue;
    await env.CAL_KV.put(seenKey, '1', { expirationTtl: 90 * 24 * 3600 });

    const record = {
      id: crypto.randomUUID(),
      fileId: file.id,
      fileName: file.name,
      driveLink: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
      createdAt: new Date().toISOString(),
    };

    try {
      const bytes = await downloadFile(accessToken, file.id);
      const extraction = await extractEventFromImage(env, bytes);

      if (extraction.error) {
        record.status = 'needs_review';
        record.error = extraction.error;
        record.rawText = extraction.raw || null;
      } else {
        const fields = extraction.data;
        const dt = resolveEventDateTime(fields);
        record.title = fields.title || file.name;
        record.location = fields.location || null;
        record.rawText = fields.raw_text || null;

        if (!dt) {
          record.status = 'needs_review';
          record.error = 'no_date_found';
        } else {
          Object.assign(record, dt);
          const description = `נוצר אוטומטית ע"י Calendar-It מתוך צילום מסך.\n\n${fields.raw_text || ''}`;
          const ics = buildIcs({ uid: record.id, title: record.title, location: record.location, description, dt });
          await env.CAL_KV.put(`ics:${record.id}`, ics);
          record.icsAvailable = true;

          try {
            const inserted = await insertCalendarEvent(accessToken, {
              title: record.title, location: record.location, description, allDay: dt.allDay,
              startDate: dt.startDate, startHour: dt.startHour, startMinute: dt.startMinute,
              endDate: dt.endDate, endHour: dt.endHour, endMinute: dt.endMinute,
            });
            record.status = 'added';
            record.calendarLink = inserted.htmlLink;
            record.calendarEventId = inserted.id;
          } catch (err) {
            record.status = 'ics_only';
            record.error = String(err.message || err);
          }

          // Extraction succeeded (we have a date + a saved .ics fallback either way) - the
          // screenshot did its job, so clear it out of the folder. Left in place on
          // needs_review/error below, since that's the only copy a human can still check.
          try {
            await trashDriveFile(accessToken, file.id);
            record.imageDeleted = true;
          } catch (err) {
            record.imageDeleted = false;
            record.deleteError = String(err.message || err);
          }
        }
      }
    } catch (err) {
      record.status = 'error';
      record.error = String(err.message || err);
    }

    await pushEventRecord(env, record);
    processed.push(record);
  }

  if (processed.length > 0) {
    try {
      await refreshDriveLogs(env, accessToken, folderId);
    } catch (err) {
      console.error('calendar-it log files update failed:', err);
    }
  }

  await env.CAL_KV.put('sync:last_check', new Date().toISOString());
  return { ok: true, processed: processed.length, records: processed };
}

// ============================================================================
// Dashboard UI
// ============================================================================

// Calendar-with-checkmark mark, in the app's own accent/good colors (see BASE_STYLE)
// - a browser-tab favicon, served as a real file so it's cacheable instead of inlined per page.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><linearGradient id="g" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
<stop offset="0" stop-color="#6b9bff"/><stop offset="1" stop-color="#3b5fdb"/>
</linearGradient></defs>
<rect width="64" height="64" rx="14" fill="url(#g)"/>
<rect x="9" y="13" width="46" height="40" rx="7" fill="#ffffff"/>
<path d="M9 27h46v-7a7 7 0 0 0-7-7H16a7 7 0 0 0-7 7z" fill="#ff5b6b"/>
<circle cx="21" cy="13" r="3.4" fill="#ffffff"/>
<circle cx="43" cy="13" r="3.4" fill="#ffffff"/>
<circle cx="46" cy="47" r="13" fill="#2fbf71" stroke="#ffffff" stroke-width="3.2"/>
<path d="M39.5 47l4.3 4.3 8-8.6" stroke="#ffffff" stroke-width="3.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
const FAVICON_LINK = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';

const BASE_STYLE = `<style>
:root { --bg:#0f1420; --card:#171d2b; --border:#2a3244; --text:#e8ecf4; --muted:#8b95ab; --accent:#5b8cff; --good:#3ecf8e; --warn:#f5a623; --bad:#f45b69; }
@media (prefers-color-scheme: light) {
  :root { --bg:#f5f6f9; --card:#ffffff; --border:#e2e5ec; --text:#1b2130; --muted:#6b7386; --accent:#3b6fe0; --good:#1f9d68; --warn:#c9790f; --bad:#d63849; }
}
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif; }
.wrap { max-width:640px; margin:0 auto; padding:20px 16px 60px; }
h1 { font-size:1.4rem; display:flex; align-items:center; gap:8px; }
.card { background:var(--card); border:1px solid var(--border); border-radius:16px; padding:18px; margin-bottom:16px; }
.row { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.muted { color:var(--muted); font-size:.9rem; }
.btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:11px 18px; border-radius:10px; border:1px solid var(--border); background:var(--card); color:var(--text); text-decoration:none; font-size:.95rem; cursor:pointer; font-weight:600; }
.btn-primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.btn-sm { padding:7px 12px; font-size:.85rem; }
.filter-btn.active { background:var(--accent); border-color:var(--accent); color:#fff; }
.badge { display:inline-block; padding:3px 10px; border-radius:999px; font-size:.78rem; font-weight:700; }
.badge-good { background:color-mix(in srgb, var(--good) 18%, transparent); color:var(--good); }
.badge-warn { background:color-mix(in srgb, var(--warn) 18%, transparent); color:var(--warn); }
.badge-bad { background:color-mix(in srgb, var(--bad) 18%, transparent); color:var(--bad); }
.event { border-top:1px solid var(--border); padding:14px 0; }
.event:first-child { border-top:none; padding-top:0; }
.event-title { font-weight:700; font-size:1.02rem; }
.event-meta { color:var(--muted); font-size:.88rem; margin:2px 0 8px; }
.actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
a { color:var(--accent); }
.spin { animation:spin 1s linear infinite; display:inline-block; }
@keyframes spin { to { transform:rotate(360deg); } }
.footer-note { text-align:center; color:var(--muted); font-size:.8rem; margin-top:24px; }
</style>`;

function statusBadge(record) {
  switch (record.status) {
    case 'added': return `<span class="badge badge-good">✓ נוסף ליומן</span>`;
    case 'ics_only': return `<span class="badge badge-warn">קובץ ICS מוכן</span>`;
    case 'needs_review': return `<span class="badge badge-warn">דורש בדיקה ידנית</span>`;
    case 'deleted_from_calendar': return `<span class="badge badge-bad">🗑️ נמחק מהיומן</span>`;
    default: return `<span class="badge badge-bad">שגיאה</span>`;
  }
}

function formatEventMeta(record) {
  if (!record.startDate) return record.location ? escapeHtml(record.location) : '';
  const [y, m, d] = record.startDate.split('-');
  const dateStr = `${d}.${m}.${y}`;
  const timeStr = record.allDay ? 'כל היום' : `${pad(record.startHour)}:${pad(record.startMinute)}`;
  return `${dateStr} · ${timeStr}${record.location ? ' · ' + escapeHtml(record.location) : ''}`;
}

function renderEventCard(record) {
  const title = escapeHtml(record.title || record.fileName || 'אירוע');
  const actions = [];
  if (record.icsAvailable) {
    actions.push(`<a class="btn btn-sm" href="/ics/${record.id}">📄 הוסף ליומן (ICS)</a>`);
  }
  if (record.status === 'added' && record.calendarLink) {
    actions.push(`<a class="btn btn-sm" href="${escapeHtml(record.calendarLink)}" target="_blank" rel="noopener">פתח ביומן</a>`);
    actions.push(`<button class="btn btn-sm" style="color:var(--bad)" onclick="deleteEvent('${record.id}', this)">🗑️ מחק מהיומן</button>`);
  }
  if (record.imageDeleted) {
    actions.push(`<span class="muted">🗑️ התמונה הועברה לפח ב-Drive</span>`);
  } else {
    actions.push(`<a class="btn btn-sm" href="${escapeHtml(record.driveLink)}" target="_blank" rel="noopener">🖼️ התמונה המקורית</a>`);
  }

  return `<div class="event" data-status="${escapeHtml(record.status)}" data-created="${escapeHtml(record.createdAt || '')}">
    <div class="row"><span class="event-title">${title}</span>${statusBadge(record)}</div>
    <div class="event-meta">${formatEventMeta(record)}</div>
    ${record.error ? `<div class="muted">${escapeHtml(record.error)}</div>` : ''}
    <div class="actions">${actions.join('')}</div>
  </div>`;
}

async function renderDashboard(env) {
  const tokens = await getStoredTokens(env);
  const connected = !!tokens?.refresh_token;
  const folderName = env.DRIVE_FOLDER_NAME || 'CalendarIt';
  let folderStatus = null;
  if (connected) {
    try {
      const accessToken = await getAccessToken(env);
      folderStatus = await findFolderId(env, accessToken);
    } catch { /* ignore, connection card below already explains */ }
  }
  const logFileId = await env.CAL_KV.get('drive:log_file_id');
  const errorLogFileId = await env.CAL_KV.get('drive:error_log_file_id');
  const events = await getEventsIndex(env);
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const addedThisWeek = events.filter((r) => SUCCESS_STATUSES.has(r.status) && r.status !== 'deleted_from_calendar' && new Date(r.createdAt).getTime() >= weekAgo).length;

  return html(`<!doctype html><html lang="he" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Calendar-It</title>
${FAVICON_LINK}
${BASE_STYLE}
</head><body><div class="wrap">
<h1>🗓️ Calendar-It</h1>
<p class="muted">מצלמים מסך של אירוע, משתפים לתיקייה ב-Drive, וזהו — האירוע קופץ ליומן.</p>

<div class="card">
  <div class="row">
    <div>
      <div><strong>חיבור ל-Google</strong></div>
      <div class="muted">${connected ? '✅ מחובר (Drive + Calendar)' : '❌ עדיין לא מחובר'}</div>
    </div>
    ${connected ? '' : '<a class="btn btn-primary" href="/auth/start">התחבר עם Google</a>'}
  </div>
  ${connected ? `<div class="row" style="margin-top:12px">
    <div>
      <div><strong>תיקיית Drive</strong></div>
      <div class="muted">${folderStatus ? `✅ נמצאה: "${escapeHtml(folderName)}"` : `⚠️ לא נמצאה תיקייה בשם "${escapeHtml(folderName)}" — צור אותה ב-Drive (בתיקיית הבסיס) ושתף אליה צילומי מסך`}</div>
    </div>
  </div>` : ''}
  ${logFileId || errorLogFileId ? `<div class="row" style="margin-top:12px;gap:8px">
    ${logFileId ? `<a class="btn btn-sm" href="https://drive.google.com/file/d/${logFileId}/view" target="_blank" rel="noopener">📋 לוג אירועים</a>` : ''}
    ${errorLogFileId ? `<a class="btn btn-sm" href="https://drive.google.com/file/d/${errorLogFileId}/view" target="_blank" rel="noopener">⚠️ לוג כשלונות</a>` : ''}
  </div>` : ''}
</div>

<div class="card">
  <div class="row">
    <strong>סנכרון</strong>
    <button class="btn btn-primary btn-sm" id="syncBtn" onclick="doSync()">🔄 סנכרן עכשיו</button>
  </div>
  <div class="muted" id="syncResult" style="margin-top:8px"></div>
</div>

<div class="card">
  <div class="row" style="flex-wrap:wrap;gap:8px;margin-bottom:6px">
    <strong>אירועים</strong>
    <span class="muted">${addedThisWeek} נוספו בשבוע האחרון</span>
  </div>
  <div class="actions" style="margin-bottom:10px">
    <button class="btn btn-sm filter-btn active" data-filter="all" onclick="setFilter('all', this)">הכל</button>
    <button class="btn btn-sm filter-btn" data-filter="week" onclick="setFilter('week', this)">השבוע האחרון</button>
    <button class="btn btn-sm filter-btn" data-filter="failed" onclick="setFilter('failed', this)">דורש בדיקה</button>
  </div>
  <div id="eventsList">
    ${events.length ? events.map(renderEventCard).join('') : '<p class="muted">עדיין אין אירועים. שתף צילום מסך לתיקייה ולחץ סנכרן.</p>'}
  </div>
  <p class="muted" id="filterEmpty" style="display:none">אין אירועים שתואמים לסינון הזה.</p>
</div>

<div class="footer-note">הריצה האוטומטית בודקת קבצים חדשים כל 5 דקות · <a href="/logout">התנתקות מהדשבורד</a></div>
</div>
<script>
async function doSync() {
  const btn = document.getElementById('syncBtn');
  const out = document.getElementById('syncResult');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin">⏳</span> מסנכרן...';
  try {
    const res = await fetch('/sync');
    const data = await res.json();
    if (!data.ok) {
      out.textContent = data.reason === 'not_connected' ? 'צריך להתחבר ל-Google קודם.' :
        data.reason === 'folder_not_found' ? 'לא נמצאה תיקיית "' + (data.folderName||'') + '" ב-Drive.' :
        'הסנכרון נכשל.';
    } else {
      out.textContent = data.processed > 0 ? ('נמצאו ' + data.processed + ' צילומים חדשים!') : 'אין צילומים חדשים.';
      if (data.processed > 0) setTimeout(() => location.reload(), 900);
    }
  } catch (e) {
    out.textContent = 'שגיאת רשת בסנכרון.';
  }
  btn.disabled = false;
  btn.innerHTML = '🔄 סנכרן עכשיו';
}

function setFilter(mode, btn) {
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  let shown = 0;
  document.querySelectorAll('#eventsList .event').forEach((el) => {
    const status = el.dataset.status;
    const created = new Date(el.dataset.created).getTime();
    let show = true;
    if (mode === 'week') show = created >= weekAgo;
    if (mode === 'failed') show = (status === 'needs_review' || status === 'error');
    el.style.display = show ? '' : 'none';
    if (show) shown++;
  });
  document.querySelectorAll('.filter-btn').forEach((b) => b.classList.toggle('active', b === btn));
  document.getElementById('filterEmpty').style.display = shown === 0 ? '' : 'none';
}

async function deleteEvent(id, btn) {
  if (!confirm('למחוק את האירוע הזה מהיומן? (התמונה בדרייב, אם עדיין קיימת, לא תושפע)')) return;
  btn.disabled = true;
  btn.textContent = 'מוחק...';
  try {
    const res = await fetch('/delete-event?id=' + encodeURIComponent(id), { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      location.reload();
    } else {
      alert('המחיקה נכשלה: ' + (data.detail || data.reason || 'שגיאה לא ידועה'));
      btn.disabled = false;
      btn.textContent = '🗑️ מחק מהיומן';
    }
  } catch (e) {
    alert('שגיאת רשת במחיקה.');
    btn.disabled = false;
    btn.textContent = '🗑️ מחק מהיומן';
  }
}
</script>
</body></html>`);
}

// ============================================================================
// Fetch handler
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/favicon.svg' || path === '/favicon.ico') {
      return new Response(FAVICON_SVG, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=604800' } });
    }

    if (path.startsWith('/ics/')) {
      const id = path.slice('/ics/'.length);
      const ics = await env.CAL_KV.get(`ics:${id}`);
      if (!ics) return new Response('לא נמצא', { status: 404 });
      return new Response(ics, {
        headers: {
          'content-type': 'text/calendar; charset=utf-8',
          'content-disposition': `attachment; filename="event-${id}.ics"`,
        },
      });
    }

    if (path === '/login') {
      if (request.method === 'POST') {
        const form = await request.formData();
        const key = form.get('key');
        if (key === env.DASHBOARD_KEY) {
          const headers = new Headers({ Location: '/' });
          headers.append('Set-Cookie', `cal_key=${encodeURIComponent(key)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`);
          return new Response(null, { status: 302, headers });
        }
        return loginPage(true);
      }
      return loginPage(false);
    }

    if (path === '/logout') {
      const headers = new Headers({ Location: '/login' });
      headers.append('Set-Cookie', 'cal_key=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
      return new Response(null, { status: 302, headers });
    }

    if (!isAuthorized(request, env)) {
      if (url.searchParams.get('key')) {
        const headers = new Headers({ Location: path });
        headers.append('Set-Cookie', `cal_key=${encodeURIComponent(url.searchParams.get('key'))}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`);
        return new Response(null, { status: 302, headers });
      }
      return loginPage(false);
    }

    if (path === '/auth/start') return handleAuthStart(request, env);
    if (path === '/auth/callback') return handleAuthCallback(request, env);

    if (path === '/sync') {
      try {
        const result = await syncOnce(env);
        return json(result);
      } catch (err) {
        return json({ ok: false, reason: 'error', detail: String(err.message || err) }, 500);
      }
    }

    if (path === '/delete-event' && request.method === 'POST') {
      const id = url.searchParams.get('id');
      const index = await getEventsIndex(env);
      const record = index.find((r) => r.id === id);
      if (!record) return json({ ok: false, reason: 'not_found' }, 404);
      if (!record.calendarEventId) return json({ ok: false, reason: 'no_calendar_event' }, 400);
      try {
        const accessToken = await getAccessToken(env);
        await deleteCalendarEvent(accessToken, record.calendarEventId);
        const updated = await updateEventRecord(env, id, {
          status: 'deleted_from_calendar', calendarLink: null, deletedAt: new Date().toISOString(),
        });
        try {
          const folderId = await findFolderId(env, accessToken);
          if (folderId) await refreshDriveLogs(env, accessToken, folderId);
        } catch (err) {
          console.error('calendar-it log refresh after delete failed:', err);
        }
        return json({ ok: true, record: updated });
      } catch (err) {
        return json({ ok: false, reason: 'error', detail: String(err.message || err) }, 500);
      }
    }

    if (path === '/' || path === '') return renderDashboard(env);

    return new Response('לא נמצא', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncOnce(env).catch((err) => console.error('scheduled syncOnce failed:', err)));
  },
};
