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
        read the (mostly Hebrew) text and return a JSON object shaped
        {raw_text, events:[{title, location, day/month/year, hour/minute}]}
        - one events entry per distinct date, with the full transcription
        kept ONCE at the top level, not repeated per date (see
        EXTRACTION_PROMPT; repeating it per date overran the token budget
        and truncated the JSON). A single screenshot can advertise more
        than one date - the same show on several nights, a multi-day
        event, or a few events stacked in one flyer - so processImageFile()
        turns each events entry into its own dashboard record + calendar
        event, all sharing the source image's fileId/createdAt as a
        "batch". Israeli screenshots write dates as day.month (e.g.
        "14.9"), never month.day - the prompt says so explicitly.
     4. resolveEventDateTime() fills in a missing year (assumes "next
        occurrence" of that day/month) and decides all-day vs timed, once
        per extracted date.
     5. Each event is inserted straight into the user's Google Calendar
        (primary) via the Calendar API. An .ics file is ALSO always
        generated and stored in KV, so there is a manual fallback if the
        auto-insert fails, the extraction needs a human glance, or the user
        just wants to hand a specific event's .ics to their phone.
     6. Once every date found in the image resolved successfully (so each
        has an .ics fallback already), the source screenshot is moved to
        Drive's trash (trashDriveFile) - it did its job and just clutters
        the folder otherwise. Left in place when any date still needs
        review, since it's the only copy a human can still check. Two
        plain-text logs are kept up to date in the same Drive folder (see
        refreshDriveLogs, rebuilt from the KV events index on every run
        that processes at least one file): calendar-it-log.txt (what got
        added to/removed from the calendar, and whether the image was kept
        or trashed) and calendar-it-errors.txt (everything the AI couldn't
        extract cleanly, WITH the raw model output, for debugging without
        re-fetching the image).
     7. GET / is a small dashboard (this IS the "known URL": open it,
        tap "Sync now" or tap an event's "Add to calendar" button to pull
        a fresh .ics onto the phone) - covers both flows from the brief.
        It also lists recent events with a filter bar (all / last 7 days /
        needs review) and a delete button per added event, which calls
        DELETE on the Calendar API (see /delete-event, deleteCalendarEvent)
        and updates both the dashboard and the Drive logs to match. Each
        card under the "בעיות" (failures) tab also gets its own "נסה שוב"
        retry button (see /retry-event, retryRecord) - it re-runs
        processImageFile() on that same source image and replaces every
        record from that original batch, so a partial multi-date failure
        can be retried without creating duplicate calendar events for the
        dates that had already succeeded.

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

// "Connected" only tells us a refresh_token exists - it says nothing about which scopes it was
// actually granted with. Reconnecting after OAUTH_SCOPES changed silently keeps the OLD scope
// if the new one was never added to the OAuth consent screen's scope list in Cloud Console (a
// one-time step Google requires for restricted scopes like full Drive access, separate from
// clicking "connect" again) - which is exactly what caused Drive trash/log writes to keep
// failing after a "successful" reconnect. Checking the live token's scope, instead of trusting
// that a reconnect fixed things, is what actually catches that.
async function getGrantedScopes(accessToken) {
  try {
    const resp = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data.scope || '').split(' ').filter(Boolean);
  } catch {
    return null;
  }
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

const EXTRACTION_PROMPT = `You are reading a screenshot from a social-media feed (usually Facebook) that advertises one or more events. The text is mostly Hebrew, sometimes mixed with English or numbers.

Some screenshots show a single date. Others show MULTIPLE dates - e.g. the same show repeated on several nights, a multi-day event, or a few distinct events stacked in one flyer. Look carefully and find EVERY distinct date shown, not just the first one.

Respond with ONLY a single valid JSON object (no markdown fences, no explanation), with exactly this shape:
{"raw_text": string, "events": [{"title": string|null, "location": string|null, "day": number|null, "month": number|null, "year": number|null, "hour": number|null, "minute": number|null}]}

Rules:
- "raw_text" appears ONCE, at the top level - all readable text from the image, so a human can double-check the extraction against the whole image. Do NOT repeat it inside the events.
- Write "raw_text" as ONE line: replace every line break with a single space, and replace every double-quote character (") with a single quote ('), so the JSON stays valid. Keep everything else as written.
- "events" has one entry per distinct date. If the image has only one date, return exactly one entry.
- If several dates belong to the same event (same show, different nights), repeat that event's title/location in every entry and only change day/month/year/hour/minute.
- If the image shows several different events, give each its own title/location.
- Dates are written in Israeli day.month order (e.g. "14.9" means day=14, month=9) - NEVER month.day.
- "title" is the performer/show/event name only - do not include the date, time or venue in it.
- "location" is the venue/place name. Strip a leading Hebrew "ב" prefix meaning "at" (e.g. "בבית החייל" -> "בית החייל").
- If no year is shown in the image, set "year" to null (do not guess a year).
- If no time is shown, set "hour" and "minute" to null.
- If you cannot find any date at all in the image, return one events entry with "day" and "month" set to null.
Respond with the JSON object only.`;

// Workers AI's vision model occasionally throws a transient "capacity temporarily exceeded"
// error (observed directly while building this, code 3040) that has nothing to do with the
// image itself - a couple of short retries clears most of them up.
async function runVisionModelWithRetry(env, image, maxAttempts = 3, maxTokens = 2048) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await env.AI.run(VISION_MODEL, { image, prompt: EXTRACTION_PROMPT, max_tokens: maxTokens, temperature: 0 });
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}

// Best-effort repair of the two ways this weak model produces invalid JSON in a string value:
// a raw line break, and an unescaped double-quote (the prompt says swap " for ' inside
// raw_text, but Hebrew acronyms - ת"א, עו"ד, ד"ר - slip through). Walks the text tracking
// string state; a '"' while inside a string counts as the terminator only when the next
// non-space char is JSON-structural (: , } ] or end), otherwise it's an inner quote and gets
// escaped. Only ever run as a fallback after a clean JSON.parse already failed.
function repairJsonStrings(s) {
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inString) {
      out += c;
      if (c === '"') inString = true;
      continue;
    }
    if (c === '\\') { // preserve escapes already in the text
      out += c + (s[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '\n') { out += '\\n'; continue; }
    if (c === '\r') { out += '\\r'; continue; }
    if (c === '\t') { out += '\\t'; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && ' \t\r\n'.includes(s[j])) j++;
      if (j >= s.length || ':,}]'.includes(s[j])) {
        out += '"';
        inString = false;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += c;
  }
  return out;
}

// Coerces whatever the model returned into an array of per-date field objects, each carrying
// its own `raw_text` (the shared top-level one is copied onto every entry so downstream code
// stays per-record). Accepts the documented { raw_text, events:[...] } wrapper, a bare
// [{...}] array, and a single bare {...} object. Returns null if `parsed` isn't a usable shape.
function normalizeEvents(parsed) {
  let events;
  let sharedRawText = '';
  if (Array.isArray(parsed)) {
    events = parsed;
  } else if (parsed && Array.isArray(parsed.events)) {
    events = parsed.events;
    sharedRawText = typeof parsed.raw_text === 'string' ? parsed.raw_text : '';
  } else if (parsed && typeof parsed === 'object') {
    events = [parsed];
  } else {
    return null;
  }
  return events.map((e) => ({
    ...(e && typeof e === 'object' ? e : {}),
    raw_text: (e && typeof e.raw_text === 'string' && e.raw_text) ? e.raw_text : sharedRawText,
  }));
}

// Pulls the events out of a raw model response string. Returns { data:[fields,...] } or
// { error, raw }. Tries both the `{...}` and `[...]` greedy slices and keeps whichever actually
// parses into usable events (so a prose prefix containing a stray bracket no longer decides it
// by position), each slice attempted first as-is then through repairJsonStrings(). Unbalanced
// brackets in a slice that never parsed => the answer was cut off (ai_response_truncated),
// which the caller retries with a bigger token budget rather than parking the image.
function parseModelJson(text) {
  const candidates = [];
  const objMatch = text.match(/\{[\s\S]*\}/);
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (objMatch) candidates.push(objMatch[0]);
  if (arrMatch) candidates.push(arrMatch[0]);
  if (candidates.length === 0) {
    if (/[[{]\s*"/.test(text)) return { error: 'ai_response_truncated', raw: text };
    return { error: 'no_json_in_response', raw: text };
  }

  let sawUnbalanced = false;
  for (const candidate of candidates) {
    // "minute": 09 -> 9 (a leading zero is invalid JSON). Numeric keys only, so clock times
    // sitting inside raw_text ("20:05") are left alone.
    const zeroFixed = candidate.replace(/("(?:day|month|year|hour|minute)"\s*:\s*)0+(\d)/g, '$1$2');
    const opens = (candidate.match(/[[{]/g) || []).length;
    const closes = (candidate.match(/[\]}]/g) || []).length;
    if (opens > closes) sawUnbalanced = true;

    for (const attempt of [zeroFixed, repairJsonStrings(zeroFixed)]) {
      let parsed;
      try {
        parsed = JSON.parse(attempt);
      } catch {
        continue;
      }
      const events = normalizeEvents(parsed);
      if (!events) continue;
      if (events.length === 0) return { error: 'no_date_found', raw: text };
      return { data: events };
    }
  }
  if (sawUnbalanced) return { error: 'ai_response_truncated', raw: text };
  return { error: 'json_parse_failed', raw: text };
}

// Returns { data: [fields, ...] } - one entry per date - or { error, raw? }. Sends the image at
// a 2048-token budget; if the model still cut the JSON off, retries ONCE at 4096 (temperature
// is 0, so only a bigger budget changes the outcome - a plain retry reproduces the same cut).
async function extractEventsFromImage(env, arrayBuffer) {
  if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
    return { error: 'image_too_large' };
  }
  const image = Array.from(new Uint8Array(arrayBuffer));

  let parsed;
  for (const maxTokens of [2048, 4096]) {
    let result;
    try {
      result = await runVisionModelWithRetry(env, image, 3, maxTokens);
    } catch (err) {
      return { error: 'ai_call_failed', raw: String(err.message || err) };
    }
    parsed = parseModelJson(result?.response || '');
    if (parsed.error !== 'ai_response_truncated') break;
  }
  return parsed;
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

// Downloads and extracts ONE Drive image, turning it into one dashboard record PER DATE found
// (see EXTRACTION_PROMPT - a single screenshot can advertise more than one date). All records
// from one call share fileId/fileName/driveLink/createdAt, which is how latestPerFile() and
// retryRecord() later recognize them as one batch. Always returns a non-empty array, even for a
// total failure (image_too_large/ai_call_failed/no_date_found/etc - a single needs_review or
// error record in that case).
async function processImageFile(env, accessToken, file) {
  const baseRecord = {
    id: crypto.randomUUID(),
    fileId: file.id,
    fileName: file.name,
    driveLink: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
    createdAt: new Date().toISOString(),
  };

  let bytes;
  try {
    bytes = await downloadFile(accessToken, file.id);
  } catch (err) {
    return [{ ...baseRecord, status: 'error', error: String(err.message || err) }];
  }

  let extraction;
  try {
    extraction = await extractEventsFromImage(env, bytes);
  } catch (err) {
    return [{ ...baseRecord, status: 'error', error: String(err.message || err) }];
  }

  if (extraction.error) {
    return [{ ...baseRecord, status: 'needs_review', error: extraction.error, rawText: extraction.raw || null }];
  }

  const subRecords = extraction.data.map((fields, i) => ({
    ...baseRecord,
    id: i === 0 ? baseRecord.id : crypto.randomUUID(),
    title: fields.title || file.name,
    location: fields.location || null,
    rawText: fields.raw_text || null,
    _dt: resolveEventDateTime(fields),
    _rawText: fields.raw_text || '',
  }));

  for (const sub of subRecords) {
    const dt = sub._dt;
    if (!dt) {
      sub.status = 'needs_review';
      sub.error = 'no_date_found';
    } else {
      Object.assign(sub, dt);
      const description = `נוצר אוטומטית ע"י Calendar-It מתוך צילום מסך.\n\n${sub._rawText}`;
      const ics = buildIcs({ uid: sub.id, title: sub.title, location: sub.location, description, dt });
      await env.CAL_KV.put(`ics:${sub.id}`, ics);
      sub.icsAvailable = true;
      try {
        const inserted = await insertCalendarEvent(accessToken, {
          title: sub.title, location: sub.location, description, allDay: dt.allDay,
          startDate: dt.startDate, startHour: dt.startHour, startMinute: dt.startMinute,
          endDate: dt.endDate, endHour: dt.endHour, endMinute: dt.endMinute,
        });
        sub.status = 'added';
        sub.calendarLink = inserted.htmlLink;
        sub.calendarEventId = inserted.id;
      } catch (err) {
        sub.status = 'ics_only';
        sub.error = String(err.message || err);
      }
    }
    delete sub._dt;
    delete sub._rawText;
  }

  // Extraction succeeded for every date found (each has a saved .ics fallback either way) - the
  // screenshot did its job, so clear it out of the folder. Left in place if ANY date still
  // needs review, since that's the only copy a human can still check.
  const allResolved = subRecords.every((r) => r.status !== 'needs_review');
  if (allResolved) {
    try {
      await trashDriveFile(accessToken, file.id);
      subRecords.forEach((r) => { r.imageDeleted = true; });
    } catch (err) {
      const deleteError = String(err.message || err);
      subRecords.forEach((r) => { r.imageDeleted = false; r.deleteError = deleteError; });
    }
  } else {
    subRecords.forEach((r) => { r.imageDeleted = false; });
  }

  return subRecords;
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

    const records = await processImageFile(env, accessToken, file);
    for (const record of [...records].reverse()) {
      await pushEventRecord(env, record);
    }
    processed.push(...records);
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

// Retries ONE failed record from the "בעיות" tab. Because extraction happens at the whole-image
// level (one screenshot -> possibly several dates, see processImageFile), a retry re-reads the
// entire source image again - not just the failed date - so it must replace every record that
// came out of that same original run (same fileId + createdAt), deleting any calendar events
// they'd already created, to avoid ending up with duplicates for dates that had succeeded.
async function retryRecord(env, id) {
  const index = await getEventsIndex(env);
  const target = index.find((r) => r.id === id);
  if (!target) return { ok: false, reason: 'not_found' };
  if (!FAILURE_STATUSES.has(target.status)) return { ok: false, reason: 'not_a_failure' };

  let accessToken;
  try {
    accessToken = await getAccessToken(env);
  } catch {
    return { ok: false, reason: 'not_connected' };
  }

  const batch = index.filter((r) => r.fileId === target.fileId && r.createdAt === target.createdAt);
  for (const r of batch) {
    if (r.calendarEventId) {
      try {
        await deleteCalendarEvent(accessToken, r.calendarEventId);
      } catch (err) {
        console.error('calendar-it retry: failed to remove stale calendar event', err);
      }
    }
  }

  const file = { id: target.fileId, name: target.fileName, webViewLink: target.driveLink };
  const newRecords = await processImageFile(env, accessToken, file);

  const batchIds = new Set(batch.map((r) => r.id));
  const next = [...newRecords, ...index.filter((r) => !batchIds.has(r.id))];
  await env.CAL_KV.put('events:index', JSON.stringify(next.slice(0, EVENTS_INDEX_CAP)));

  try {
    const folderId = await findFolderId(env, accessToken);
    if (folderId) await refreshDriveLogs(env, accessToken, folderId);
  } catch (err) {
    console.error('calendar-it log refresh after retry failed:', err);
  }

  return { ok: true, records: newRecords };
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
:root {
  --bg:#0d1117; --bg-elev:#11161f; --card:#171d29; --card-hover:#1c2333; --border:#2a3244;
  --text:#e8ecf4; --muted:#8b95ab; --accent:#5b8cff; --accent-soft:#5b8cff22;
  --good:#3ecf8e; --warn:#f5a623; --bad:#f45b69; --shadow:0 1px 2px rgba(0,0,0,.3), 0 8px 24px -12px rgba(0,0,0,.5);
}
@media (prefers-color-scheme: light) {
  :root {
    --bg:#f3f5f9; --bg-elev:#eef1f6; --card:#ffffff; --card-hover:#f7f9fc; --border:#e4e8f0;
    --text:#1b2130; --muted:#6b7386; --accent:#3b6fe0; --accent-soft:#3b6fe014;
    --good:#1f9d68; --warn:#c9790f; --bad:#d63849; --shadow:0 1px 2px rgba(20,30,60,.05), 0 8px 24px -12px rgba(20,30,60,.12);
  }
}
* { box-sizing:border-box; }
body {
  margin:0; background:
    radial-gradient(1200px 420px at 50% -120px, var(--accent-soft), transparent),
    var(--bg);
  color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.wrap { max-width:640px; margin:0 auto; padding:24px 16px 60px; }
.topbar { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:22px; }
.brand { display:flex; align-items:center; gap:12px; }
.brand-icon { font-size:1.5rem; width:44px; height:44px; flex:none; display:flex; align-items:center; justify-content:center; background:var(--card); border:1px solid var(--border); border-radius:13px; box-shadow:var(--shadow); }
h1 { font-size:1.2rem; margin:0; font-weight:800; letter-spacing:-.01em; }
.tagline { margin:2px 0 0; color:var(--muted); font-size:.85rem; }
.card { background:var(--card); border:1px solid var(--border); border-radius:16px; padding:18px; margin-bottom:16px; box-shadow:var(--shadow); }
.alert-card { border-color:color-mix(in srgb, var(--warn) 45%, var(--border)); background:linear-gradient(var(--card), var(--card)) padding-box, linear-gradient(135deg, color-mix(in srgb, var(--warn) 14%, transparent), transparent) border-box; }
.row { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.muted { color:var(--muted); font-size:.9rem; }
.btn {
  display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:11px 18px;
  border-radius:11px; border:1px solid var(--border); background:var(--card); color:var(--text);
  text-decoration:none; font-size:.95rem; cursor:pointer; font-weight:600;
  transition:transform .12s ease, background-color .15s ease, border-color .15s ease, box-shadow .15s ease;
}
.btn:hover { background:var(--card-hover); transform:translateY(-1px); }
.btn:active { transform:translateY(0); }
.btn:disabled { opacity:.6; cursor:default; transform:none; }
.btn-primary { background:var(--accent); border-color:var(--accent); color:#fff; box-shadow:0 4px 14px -4px var(--accent); }
.btn-primary:hover { filter:brightness(1.08); background:var(--accent); }
.btn-danger { color:var(--bad); border-color:color-mix(in srgb, var(--bad) 35%, var(--border)); }
.btn-danger:hover { background:color-mix(in srgb, var(--bad) 10%, var(--card)); }
.btn-sm { padding:7px 12px; font-size:.85rem; }
.filter-btn.active { background:var(--accent); border-color:var(--accent); color:#fff; }
.badge { display:inline-flex; align-items:center; padding:3px 10px; border-radius:999px; font-size:.78rem; font-weight:700; }
.badge-good { background:color-mix(in srgb, var(--good) 18%, transparent); color:var(--good); }
.badge-warn { background:color-mix(in srgb, var(--warn) 18%, transparent); color:var(--warn); }
.badge-bad { background:color-mix(in srgb, var(--bad) 18%, transparent); color:var(--bad); }
.event { border-top:1px solid var(--border); padding:14px 4px; margin:0 -4px; border-radius:10px; transition:background-color .15s ease; }
.event:hover { background:var(--card-hover); }
.event:first-child { border-top:none; padding-top:0; }
.event-title { font-weight:700; font-size:1.02rem; }
.event-meta { color:var(--muted); font-size:.88rem; margin:2px 0 8px; }
.actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
a { color:var(--accent); }
.spin { animation:spin 1s linear infinite; display:inline-block; }
@keyframes spin { to { transform:rotate(360deg); } }
.footer-note { text-align:center; color:var(--muted); font-size:.8rem; margin-top:24px; }

/* Settings gear + popover - the "connected, all good" state collapses to just this icon,
   see the PM's ask: two green checkmarks every visit is noise once nothing needs attention. */
.settings { position:relative; flex:none; }
.settings > summary { list-style:none; width:40px; height:40px; border-radius:12px; border:1px solid var(--border); background:var(--card); box-shadow:var(--shadow); display:flex; align-items:center; justify-content:center; font-size:1.1rem; cursor:pointer; }
.settings > summary::-webkit-details-marker, .settings > summary::marker { display:none; content:''; }
.settings[open] > summary { background:var(--card-hover); }
.settings-panel { position:absolute; inset-inline-start:0; top:48px; z-index:20; width:min(300px, 80vw); background:var(--card); border:1px solid var(--border); border-radius:14px; padding:14px; box-shadow:var(--shadow); }
.settings-row { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:6px 0; font-size:.9rem; }
.settings-links { display:flex; flex-direction:column; gap:6px; margin-top:6px; padding-top:10px; border-top:1px solid var(--border); }
.settings-links a { font-size:.85rem; }

.tabs { display:flex; gap:6px; margin-bottom:14px; background:var(--bg-elev); padding:4px; border-radius:12px; }
.tab-btn { flex:1; border:none; background:transparent; padding:9px 10px; border-radius:9px; font-weight:700; font-size:.88rem; cursor:pointer; color:var(--muted); transition:background-color .15s ease, color .15s ease; }
.tab-btn.active { background:var(--card); color:var(--text); box-shadow:var(--shadow); }
.btn-ghost { border-color:transparent; background:transparent; color:var(--muted); }
.btn-ghost:hover { background:var(--card-hover); color:var(--bad); }
.raw-details { margin-top:6px; font-size:.82rem; }
.raw-details summary { cursor:pointer; color:var(--muted); }
.raw-details pre { white-space:pre-wrap; word-break:break-word; background:var(--bg-elev); border:1px solid var(--border); border-radius:8px; padding:8px; margin-top:6px; font-size:.78rem; }
.empty-state { text-align:center; padding:28px 10px; color:var(--muted); }
.empty-state .emoji { font-size:2rem; display:block; margin-bottom:8px; }
@keyframes fadeInUp { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
.event { animation:fadeInUp .35s ease both; }
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

// An event with no resolved date (extraction failed) is never "in the past" - it still needs
// a look. A dated event drops off once its own calendar day has fully elapsed (compared as
// plain "YYYY-MM-DD" strings - deliberately day-granularity, not exact start/end time, since
// this is just decluttering the dashboard and isn't worth the UTC/Asia-Jerusalem precision).
function isPastEvent(record) {
  if (!record.startDate) return false;
  const todayStr = new Date().toISOString().slice(0, 10);
  return (record.endDate || record.startDate) < todayStr;
}

// Keeps only the most recently processed BATCH per Drive file - a batch being every record
// produced by the same processImageFile() call (same fileId + identical createdAt), which for a
// multi-date screenshot is more than one record. Collapsing to a single record here would hide
// legitimate extra dates, so the dedup key is the batch, not the individual record. This only
// discards anything when a file was reprocessed (retryRecord, or a cleared seen key while
// debugging), which otherwise leaves stale attempts sitting next to the eventual result.
function latestPerFile(events) {
  const byFile = new Map();
  for (const r of events) {
    if (!byFile.has(r.fileId)) byFile.set(r.fileId, []);
    byFile.get(r.fileId).push(r);
  }
  const kept = [];
  for (const records of byFile.values()) {
    const latestCreatedAt = records.reduce(
      (max, r) => (new Date(r.createdAt) > new Date(max) ? r.createdAt : max),
      records[0].createdAt,
    );
    kept.push(...records.filter((r) => r.createdAt === latestCreatedAt));
  }
  return kept.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
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
  if (FAILURE_STATUSES.has(record.status)) {
    actions.push(`<button class="btn btn-sm btn-primary" onclick="retryEvent('${record.id}', this)">🔁 נסה שוב</button>`);
  }
  if (record.icsAvailable) {
    actions.push(`<a class="btn btn-sm" href="/ics/${record.id}">📄 הוסף ליומן (ICS)</a>`);
  }
  if (record.status === 'added' && record.calendarLink) {
    actions.push(`<a class="btn btn-sm" href="${escapeHtml(record.calendarLink)}" target="_blank" rel="noopener">פתח ביומן</a>`);
  }
  if (record.status === 'added' && record.calendarEventId) {
    actions.push(`<button class="btn btn-sm btn-danger" onclick="deleteEvent('${record.id}', this)">🗑️ מחק מהיומן</button>`);
  }
  if (record.imageDeleted) {
    actions.push(`<span class="muted">🗑️ התמונה הועברה לפח ב-Drive</span>`);
  } else {
    actions.push(`<a class="btn btn-sm" href="${escapeHtml(record.driveLink)}" target="_blank" rel="noopener">🖼️ התמונה המקורית</a>`);
  }
  actions.push(`<button class="btn btn-sm btn-ghost" title="הסר מהרשימה בדשבורד (לא נוגע ביומן/בתמונה)" onclick="removeEvent('${record.id}', this)">✕ הסר מהרשימה</button>`);

  const rawTextBlock = record.rawText && FAILURE_STATUSES.has(record.status)
    ? `<details class="raw-details"><summary>פלט גולמי מה-AI</summary><pre>${escapeHtml(record.rawText)}</pre></details>`
    : '';

  return `<div class="event" data-status="${escapeHtml(record.status)}" data-created="${escapeHtml(record.createdAt || '')}">
    <div class="row"><span class="event-title">${title}</span>${statusBadge(record)}</div>
    <div class="event-meta">${formatEventMeta(record)}</div>
    ${record.error ? `<div class="muted">${escapeHtml(record.error)}</div>` : ''}
    ${rawTextBlock}
    <div class="actions">${actions.join('')}</div>
  </div>`;
}

async function renderDashboard(env) {
  const tokens = await getStoredTokens(env);
  const connected = !!tokens?.refresh_token;
  const folderName = env.DRIVE_FOLDER_NAME || 'CalendarIt';
  let folderStatus = null;
  let hasWriteScope = null; // null = unknown (couldn't check) - only nag when we're sure it's missing
  if (connected) {
    try {
      const accessToken = await getAccessToken(env);
      folderStatus = await findFolderId(env, accessToken);
      const scopes = await getGrantedScopes(accessToken);
      if (scopes) hasWriteScope = scopes.includes('https://www.googleapis.com/auth/drive');
    } catch { /* ignore, alert banner below already explains */ }
  }
  const logFileId = await env.CAL_KV.get('drive:log_file_id');
  const errorLogFileId = await env.CAL_KV.get('drive:error_log_file_id');
  const allEvents = await getEventsIndex(env);
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const addedThisWeek = allEvents.filter((r) => SUCCESS_STATUSES.has(r.status) && r.status !== 'deleted_from_calendar' && new Date(r.createdAt).getTime() >= weekAgo).length;
  // Dashboard view only: past dated events and superseded reprocessing attempts drop out here
  // (see isPastEvent/latestPerFile) - the full history still lives in events:index and the
  // Drive log files regardless, this is purely about what's worth looking at right now.
  const events = latestPerFile(allEvents).filter((r) => FAILURE_STATUSES.has(r.status) || !isPastEvent(r));
  const successEvents = events.filter((r) => SUCCESS_STATUSES.has(r.status) && r.status !== 'deleted_from_calendar');
  const failureEvents = events.filter((r) => FAILURE_STATUSES.has(r.status));
  const fullyOk = connected && !!folderStatus && hasWriteScope !== false;

  return html(`<!doctype html><html lang="he" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Calendar-It</title>
${FAVICON_LINK}
${BASE_STYLE}
</head><body><div class="wrap">

<div class="topbar">
  <div class="brand">
    <span class="brand-icon">🗓️</span>
    <div>
      <h1>Calendar-It</h1>
      <p class="tagline">צילום מסך → אירוע ביומן, אוטומטית</p>
    </div>
  </div>
  <details class="settings">
    <summary title="חיבור והגדרות">⚙️</summary>
    <div class="settings-panel">
      <div class="settings-row"><span>חיבור ל-Google</span>${connected ? '<span class="badge badge-good">✓ מחובר</span>' : '<span class="badge badge-bad">✗ מנותק</span>'}</div>
      ${connected ? `<div class="settings-row"><span>תיקיית Drive</span>${folderStatus ? '<span class="badge badge-good">✓ נמצאה</span>' : '<span class="badge badge-warn">לא נמצאה</span>'}</div>` : ''}
      ${connected ? `<div class="settings-row"><span>הרשאת כתיבה ל-Drive</span>${hasWriteScope === false ? '<span class="badge badge-bad">חסרה</span>' : hasWriteScope === true ? '<span class="badge badge-good">✓ יש</span>' : '<span class="badge badge-warn">לא ידוע</span>'}</div>` : ''}
      <a class="btn btn-sm btn-primary" style="width:100%;margin-top:10px" href="/auth/start">${connected ? '🔁 התחבר מחדש' : '🔌 התחבר עם Google'}</a>
      ${logFileId || errorLogFileId ? `<div class="settings-links">
        ${logFileId ? `<a href="https://drive.google.com/file/d/${logFileId}/view" target="_blank" rel="noopener">📋 לוג אירועים</a>` : ''}
        ${errorLogFileId ? `<a href="https://drive.google.com/file/d/${errorLogFileId}/view" target="_blank" rel="noopener">⚠️ לוג כשלונות</a>` : ''}
      </div>` : ''}
      <a class="muted" style="display:block;text-align:center;margin-top:12px;font-size:.8rem" href="/logout">התנתקות מהדשבורד</a>
    </div>
  </details>
</div>

${!fullyOk ? `<div class="card alert-card">
  ${!connected
    ? `<div class="row"><div><strong>עדיין לא מחובר ל-Google</strong><div class="muted">צריך להתחבר כדי לקרוא מהדרייב ולהוסיף ליומן.</div></div><a class="btn btn-primary btn-sm" href="/auth/start">התחבר</a></div>`
    : hasWriteScope === false
    ? `<div><strong>⚠️ חסרה הרשאת כתיבה ל-Drive</strong><div class="muted" style="margin-top:4px">בלי זה, מחיקת תמונות וקבצי הלוג ימשיכו להיכשל בשקט (האירועים עצמם כן ייכנסו ליומן כרגיל). לחיצה נוספת על "התחבר מחדש" <u>לא מספיקה</u> אם ה-scope הזה לא הוגדר קודם ב-Google Cloud Console:</div>
       <ol class="muted" style="margin:8px 0 10px;padding-inline-start:20px;line-height:1.7">
         <li>console.cloud.google.com → הפרויקט שלכם → <strong>APIs &amp; Services → OAuth consent screen</strong></li>
         <li><strong>Data Access → Add or Remove Scopes</strong></li>
         <li>סמנו את <code>.../auth/drive</code> ("See, edit, create, and delete all of your Google Drive files") ושמרו</li>
         <li>חזרו לכאן ולחצו "התחבר מחדש"</li>
       </ol>
       <a class="btn btn-primary btn-sm" href="/auth/start">🔁 התחבר מחדש</a></div>`
    : `<div><strong>⚠️ תיקייה "${escapeHtml(folderName)}" לא נמצאה</strong><div class="muted" style="margin-top:4px">צרו אותה ב-Drive (בתיקיית הבסיס) ושתפו אליה צילומי מסך.</div></div>`}
</div>` : ''}

<div class="card">
  <div class="row">
    <strong>סנכרון</strong>
    <button class="btn btn-primary btn-sm" id="syncBtn" onclick="doSync()">🔄 סנכרן עכשיו</button>
  </div>
  <div class="muted" id="syncResult" style="margin-top:8px"></div>
</div>

<div class="card">
  <div class="tabs">
    <button class="tab-btn active" data-tab="ok" onclick="setTab('ok', this)">✅ אירועים שנוספו</button>
    <button class="tab-btn" data-tab="fail" onclick="setTab('fail', this)">⚠️ בעיות${failureEvents.length ? ` (${failureEvents.length})` : ''}</button>
  </div>

  <div id="tabOk">
    <div class="row" style="flex-wrap:wrap;gap:8px;margin-bottom:10px">
      <span class="muted">${addedThisWeek} נוספו בשבוע האחרון</span>
      <div class="actions" style="margin:0">
        <button class="btn btn-sm filter-btn active" data-filter="all" onclick="setFilter('all', this)">הכל</button>
        <button class="btn btn-sm filter-btn" data-filter="week" onclick="setFilter('week', this)">השבוע האחרון</button>
      </div>
    </div>
    <div id="eventsList">
      ${successEvents.length ? successEvents.map(renderEventCard).join('') : `<div class="empty-state"><span class="emoji">📸</span>עדיין אין אירועים שנוספו.<br>שתפו צילום מסך לתיקייה ב-Drive ולחצו "סנכרן עכשיו".</div>`}
    </div>
    <p class="muted" id="filterEmpty" style="display:none">אין אירועים שתואמים לסינון הזה.</p>
  </div>

  <div id="tabFail" style="display:none">
    ${failureEvents.length ? failureEvents.map(renderEventCard).join('') : `<div class="empty-state"><span class="emoji">🎉</span>אין בעיות פתוחות כרגע.</div>`}
  </div>
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

function setTab(tab, btn) {
  document.getElementById('tabOk').style.display = tab === 'ok' ? '' : 'none';
  document.getElementById('tabFail').style.display = tab === 'fail' ? '' : 'none';
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
}

function setFilter(mode, btn) {
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  let shown = 0;
  document.querySelectorAll('#eventsList .event').forEach((el) => {
    const created = new Date(el.dataset.created).getTime();
    const show = mode === 'week' ? created >= weekAgo : true;
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

async function retryEvent(id, btn) {
  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = '<span class="spin">⏳</span> מנסה שוב...';
  try {
    const res = await fetch('/retry-event?id=' + encodeURIComponent(id), { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      location.reload();
    } else {
      alert('הניסיון החוזר נכשל: ' + (data.detail || data.reason || 'שגיאה לא ידועה'));
      btn.disabled = false;
      btn.innerHTML = original;
    }
  } catch (e) {
    alert('שגיאת רשת בניסיון החוזר.');
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

async function removeEvent(id, btn) {
  if (!confirm('להסיר את הפריט הזה מהרשימה בדשבורד? (לא נוגע ביומן או בתמונה בדרייב)')) return;
  btn.disabled = true;
  try {
    const res = await fetch('/remove-event?id=' + encodeURIComponent(id), { method: 'POST' });
    const data = await res.json();
    if (data.ok) location.reload();
    else alert('ההסרה נכשלה: ' + (data.reason || 'שגיאה לא ידועה'));
  } catch (e) {
    alert('שגיאת רשת.');
  }
  btn.disabled = false;
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

    if (path === '/retry-event' && request.method === 'POST') {
      const id = url.searchParams.get('id');
      try {
        const result = await retryRecord(env, id);
        if (!result.ok) {
          return json(result, result.reason === 'not_found' ? 404 : 400);
        }
        return json(result);
      } catch (err) {
        return json({ ok: false, reason: 'error', detail: String(err.message || err) }, 500);
      }
    }

    if (path === '/remove-event' && request.method === 'POST') {
      const id = url.searchParams.get('id');
      const index = await getEventsIndex(env);
      const next = index.filter((r) => r.id !== id);
      if (next.length === index.length) return json({ ok: false, reason: 'not_found' }, 404);
      await env.CAL_KV.put('events:index', JSON.stringify(next));
      try {
        const accessToken = await getAccessToken(env);
        const folderId = await findFolderId(env, accessToken);
        if (folderId) await refreshDriveLogs(env, accessToken, folderId);
      } catch (err) {
        console.error('calendar-it log refresh after remove failed:', err);
      }
      return json({ ok: true });
    }

    if (path === '/' || path === '') return renderDashboard(env);

    return new Response('לא נמצא', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncOnce(env).catch((err) => console.error('scheduled syncOnce failed:', err)));
  },
};
