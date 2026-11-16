// The Pokedex agents server: the one process that changes the game. It listens on 127.0.0.1
// only; pokemon-rex and pokemon-herdr are clients:
//   GET  /state    { shared, notes, view }: the saved game, recent news, and what the apps draw that
//                  depends on the clock (today's quests, the live streak) with the rules' versions
//   GET  /events   the same, as server-sent events: one `state` event now and after each change
//   GET  /ws       the same, as WebSocket text messages (Herdr's fetch can't read a stream)
//   GET  /version  { rules, save }: the versions of the rules and the save this server runs
//   POST /call     { action, args, origin, session, at? } -> { ok, value } | { ok: false, error }
//                  `at`: when an agent event happened (ms), for one an app queued while this was down
//   POST /share    { sprites? } -> { ok, text, url, card, copied }: a post for X, its card on the clipboard
// The rules (game.js) run here and nowhere else.
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR, writeJson, locked, shared, setShared, sharedFile, allShared, notes, asCaller } from "./store.js";
import { game, throwBall, runAway, useItem, recordCatches, finishTask, finishSubTask, unblocked, migrateProject, checkBadges, migrateSave, digest, setOption, defaultPartner, chooseStarter, setParty, setLead, claimGift, result, markSeen, rerollQuest, quests, liveStreak, GAME, CAUGHT, PARTNERS, PROJECTS, SAVE_VERSION, RULES_VERSION } from "./game.js";
import { mergeSaves } from "./merge.js";
import { projectId as pid, hashOnly, hashSave } from "./keys.js";
import { shareText, intentUrl, renderCard, spriteDir, copyImage } from "./share.js";

export const SERVER_FILE = path.join(STATE_DIR, "server.json");
export const DEFAULT_PORT = 7151;
const SORTS = ["priority", "grouped"];
const dexId = (n) => {
  if (!Number.isInteger(n) || n < 1 || n > 151) throw new Error(`${n} is not a Kanto number (1 to 151)`);
  return n;
};
const caught = () => shared(CAUGHT) ?? [];
const queueIndex = (n) => (Number.isInteger(n) && n >= 0 ? n : 0);

// --- What the apps' agents report, and when. Limits keep a buggy or dishonest app from inflating
// the game: a turn counts for at most MAX_TURN_MS, each kind of report at most EVENTS[kind] times a
// minute, counted by when it happened (so a queue replayed at once isn't refused), and a report from
// more than MAX_LATE_MS ago no longer counts.
const EVENTS = { taskFinished: 30, subTaskFinished: 60, unblocked: 30, result: 60 };
export const MAX_TURN_MS = 6 * 3600000;
export const MAX_LATE_MS = 3 * 86400000;
const reported = new Map(); // kind -> recent event times
function eventTime(kind, at) {
  const now = Date.now();
  if (at === undefined || at === null) return now;
  if (!Number.isFinite(at)) throw new Error("at is a time in milliseconds");
  if (now - at > MAX_LATE_MS) throw new Error(`a ${kind} report from more than 3 days ago no longer counts`);
  return Math.min(at, now);
}
function admit(kind, at) {
  const near = (reported.get(kind) ?? []).filter((t) => Math.abs(t - at) < 60000);
  if (near.length >= EVENTS[kind]) throw new Error(`too many ${kind} reports in one minute`);
  const recent = (reported.get(kind) ?? []).filter((t) => Date.now() - t <= MAX_LATE_MS + 60000);
  reported.set(kind, [...recent, at].slice(-1000));
}
// Runs one step of the rules as if it were `at`: the rules read the clock (days, streaks, quests).
// Steps are synchronous and run one at a time, so swapping the global clock for the call is safe.
function atTime(at, fn) {
  const Real = Date;
  if (Math.abs(Real.now() - at) < 1000) return fn();
  globalThis.Date = class extends Real {
    constructor(...args) { if (args.length) super(...args); else super(at); }
    static now() { return at; }
  };
  try { return fn(); } finally { globalThis.Date = Real; }
}

// Everything a client may change, and only through these.
const ACTIONS = {
  // `index`: which Pokemon in the tall grass queue, the oldest (0) by default.
  throwBall: (ball = "poke", index = 0) => throwBall(["poke", "great", "ultra"].includes(ball) ? ball : "poke", queueIndex(index)),
  runAway: (index = 0) => runAway(queueIndex(index)),
  // The "welcome back" summary, for a client that sees the person return.
  digest: () => digest(),
  // { alert: "off" | "on" | "smart" } or { hardMode: true | false }.
  setOption: (key, value) => setOption(String(key), value),
  useItem: (id, item) => useItem(dexId(Number(id)), String(item)),
  // The party (the first leads): pick the starter once, then reorder or swap any time.
  chooseStarter: (id) => chooseStarter(dexId(id)),
  setParty: (ids) => setParty((Array.isArray(ids) ? ids : []).map(dexId)),
  setLead: (id) => setLead(dexId(id)),
  claimGift: (tr, id) => claimGift(Number(tr), dexId(id)),
  // What a finished turn produced: "commit", "green" (tests or CI) or "merged".
  result: (project, kind) => result(pid(project), String(kind)),
  // "phase2": the New Pokedex explainer was dismissed; "trainer": the trainer card opened.
  seen: (key) => markSeen(String(key)),
  // Swaps one of today's quests for another (once a day): its id, like "d-catch".
  rerollQuest: (id) => rerollQuest(String(id)),
  // A project's mascot, drawn on its cards (cosmetic).
  setPartner: (project, id) => setShared(PARTNERS, { ...(shared(PARTNERS) ?? {}), [pid(project)]: dexId(id) }),
  // Debug only: set POKEDEX_DEBUG=1 when starting the server.
  catch: (id) => {
    dexId(id);
    if (process.env.POKEDEX_DEBUG !== "1") throw new Error("catch is a debug action: start the server with POKEDEX_DEBUG=1");
    return recordCatches([dexId(id)]);
  },
  release: (id) => setShared(CAUGHT, caught().filter((n) => n !== dexId(id))),
  setSort: (sort) => setShared("agents.sort", SORTS.includes(sort) ? sort : "priority"),
  // What an app sees its agents do (Herdr's pokedex-agents, Rex's daemon).
  // `branch`: the git branch the turn ran on, when the app knows it.
  taskFinished: (project, partner, ms, app = null, branch = null) => finishTask(pid(project), dexId(partner), Math.min(MAX_TURN_MS, Number(ms) || 0), app, branch ? hashOnly(branch) : null),
  subTaskFinished: (project, partner) => finishSubTask(pid(project), dexId(partner)),
  unblocked: (project, ms) => unblocked(pid(project), Math.min(86400000, Number(ms) || 0)),
  // Opening an agent no longer catches its partner; kept so older clients don't error.
  met: () => null,
  // A project's key, found from its repo: progress kept under its old name moves to the key. The
  // space name -> repo map stays on this machine (local.json).
  resolveProject: (name, key) => {
    migrateProject(pid(name), pid(key));
    setShared(PROJECTS, { ...(shared(PROJECTS) ?? {}), [String(name)]: String(key) });
  },
  // Default partners for projects that have none yet; a saved partner is never replaced.
  savePartners: (missing) => {
    const partners = shared(PARTNERS) ?? {};
    const fresh = Object.fromEntries(Object.entries(missing ?? {}).map(([k, id]) => [pid(k), id]).filter(([k]) => partners[k] === undefined).map(([k, id]) => [k, defaultPartner(dexId(id))]));
    if (Object.keys(fresh).length) setShared(PARTNERS, { ...partners, ...fresh });
  },
  // Another save joined into this one, once (see merge.js); `id` names it so a second try does nothing.
  merge: (id, theirs) => {
    const done = shared("pokedex.merged") ?? [];
    if (done.includes(id)) return "already merged";
    if (fs.existsSync(sharedFile)) fs.copyFileSync(sharedFile, `${sharedFile}.bak-${Date.now()}`);
    const mine = Object.fromEntries([GAME, CAUGHT, PARTNERS, PROJECTS].map((k) => [k, shared(k)]));
    for (const [k, v] of Object.entries(mergeSaves(mine, theirs ?? {}))) setShared(k, v);
    setShared("pokedex.merged", [...done, id]);
    migrateSave();
    hashSave();
    checkBadges();
    return "merged";
  },
  // Progress brought over from another save: { [GAME|CAUGHT|PARTNERS]: value }. Keeps a backup.
  import: (values) => {
    const keys = [GAME, CAUGHT, PARTNERS].filter((k) => values?.[k] !== undefined);
    if (!keys.length) throw new Error("nothing to import");
    if (fs.existsSync(sharedFile)) fs.copyFileSync(sharedFile, `${sharedFile}.bak-${Date.now()}`);
    for (const k of keys) setShared(k, k === GAME ? { ...values[k], encounter: null } : values[k]);
    migrateSave();
    hashSave();
    checkBadges();
    return keys;
  },
};

// What the apps draw that the clock changes (today's quests, the live streak), computed here so an
// app never shows it from an older or newer copy of the rules; the versions let it warn about one.
const view = () => {
  const g = game();
  return { rules: RULES_VERSION, save: SAVE_VERSION, quests: quests(g), streak: liveStreak(g) };
};
const snapshot = () => ({ shared: allShared(), notes: notes(), view: view() });

export function startServer({ port = DEFAULT_PORT, log = console.log } = {}) {
  const streams = new Set();
  const sockets = new Set();
  const enc = new TextEncoder();
  const send = (c, text) => { try { c.enqueue(enc.encode(text)); } catch { streams.delete(c); } };
  let pending = null;
  const broadcast = () => {
    if (pending || !(streams.size || sockets.size)) return;
    // Writes come in bursts (game, then news); one event per burst.
    pending = setTimeout(() => {
      pending = null;
      const data = JSON.stringify(snapshot());
      for (const c of streams) send(c, `event: state\ndata: ${data}\n\n`);
      for (const ws of sockets) ws.send(data);
    }, 30);
  };
  // The rules write shared.json and notes.json; either changing is news for every client.
  const WATCHED = new Set(["shared.json", "notes.json", "local.json"]);
  const watcher = fs.watch(STATE_DIR, (_ev, name) => { if (!name || WATCHED.has(name)) broadcast(); });
  const ping = setInterval(() => { for (const c of streams) send(c, ": ping\n\n"); }, 15000);
  // A new day changes the quests and the streak with no save written: send the state again then.
  let lastView = JSON.stringify(view());
  const dayWatch = setInterval(() => {
    const now = JSON.stringify(view());
    if (now !== lastView) { lastView = now; broadcast(); }
  }, 60000);

  const json = (value, status = 200) => Response.json(value, { status });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0, // event streams stay open
    routes: {
      "/health": () => json({ ok: true, pid: process.pid }),
      "/version": () => json({ rules: RULES_VERSION, save: SAVE_VERSION }),
      "/state": () => json(snapshot()),
      "/events": (req) => {
        let ctl;
        const body = new ReadableStream({
          start(c) {
            ctl = c;
            streams.add(c);
            send(c, `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
          },
          cancel() { streams.delete(ctl); },
        });
        req.signal.addEventListener("abort", () => streams.delete(ctl));
        return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
      },
      "/share": {
        POST: async (req) => {
          const body = await req.json().catch(() => ({}));
          try {
            const g = game(), have = caught();
            const text = shareText(g, have);
            const card = path.join(STATE_DIR, "share-card.png");
            fs.writeFileSync(card, renderCard(g, have, shared(PARTNERS), spriteDir(body?.sprites)));
            return json({ ok: true, text, url: intentUrl(text), card, copied: await copyImage(card) });
          } catch (error) {
            return json({ ok: false, error: error?.message ?? String(error) }, 500);
          }
        },
      },
      "/call": {
        POST: async (req) => {
          let body;
          try { body = await req.json(); } catch { return json({ ok: false, error: "body must be JSON" }, 400); }
          const fn = ACTIONS[body?.action];
          if (!fn) return json({ ok: false, error: `unknown action ${body?.action}` }, 404);
          try {
            const args = Array.isArray(body.args) ? body.args : [];
            const kind = body.action in EVENTS ? body.action : null;
            const at = kind ? eventTime(kind, body.at) : null;
            if (kind) admit(kind, at);
            const value = locked(() => asCaller(body, () => (kind ? atTime(at, () => fn(...args)) : fn(...args))));
            broadcast();
            return json({ ok: true, value: value ?? null });
          } catch (error) {
            return json({ ok: false, error: error?.message ?? String(error) }, 400);
          }
        },
      },
    },
    fetch: (req, srv) => {
      if (new URL(req.url).pathname === "/ws" && srv.upgrade(req)) return;
      return json({ ok: false, error: "not found" }, 404);
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify(snapshot()));
      },
      message() {},
      close(ws) { sockets.delete(ws); },
    },
  });
  // Only once the port is ours: a second copy (the port taken) must not touch the save another server
  // owns, and may be running other rules. A save edited while the server was down (restored, copied in)
  // is upgraded, its project keys hashed, and it gets the badges it has earned. This runs before any
  // request is handled: those wait for the event loop.
  locked(() => { migrateSave(); hashSave(); checkBadges(); });
  writeJson(SERVER_FILE, { port: server.port, pid: process.pid });
  log(`pokedex server on http://127.0.0.1:${server.port}`);
  return {
    port: server.port,
    stop() {
      clearInterval(ping);
      clearInterval(dayWatch);
      watcher.close();
      for (const c of streams) try { c.close(); } catch {}
      for (const ws of sockets) ws.close();
      streams.clear();
      sockets.clear();
      server.stop(true);
    },
  };
}
