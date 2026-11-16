// The Pokedex agents server: the one process that changes the game. It listens on 127.0.0.1
// only; pokemon-rex and pokemon-herdr are clients:
//   GET  /state    { shared, notes }: the saved game and recent news
//   GET  /events   the same, as server-sent events: one `state` event now and after each change
//   GET  /ws       the same, as WebSocket text messages (Herdr's fetch can't read a stream)
//   POST /call     { action, args, origin, session } -> { ok, value } | { ok: false, error }
//   POST /share    { sprites? } -> { ok, text, url, card, copied }: a post for X, its card on the clipboard
// The rules (game.js) run here and nowhere else.
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR, writeJson, locked, shared, setShared, sharedFile, allShared, notes, asCaller } from "./store.js";
import { game, throwBall, runAway, useItem, recordCatches, finishTask, finishSubTask, unblocked, migrateProject, checkBadges, migrateSave, digest, setOption, defaultPartner, GAME, CAUGHT, PARTNERS, PROJECTS } from "./game.js";
import { mergeSaves } from "./merge.js";
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

// Everything a client may change, and only through these.
const ACTIONS = {
  // `index`: which Pokemon in the tall grass queue, the oldest (0) by default.
  throwBall: (ball = "poke", index = 0) => throwBall(["poke", "great", "ultra"].includes(ball) ? ball : "poke", queueIndex(index)),
  runAway: (index = 0) => runAway(queueIndex(index)),
  // The "welcome back" summary, for a client that sees the person return.
  digest: () => digest(),
  // { alert: "off" | "on" | "smart" } or { hardMode: true | false }.
  setOption: (key, value) => setOption(String(key), value),
  useItem: (project, item) => useItem(String(project), String(item)),
  setPartner: (project, id) => setShared(PARTNERS, { ...(shared(PARTNERS) ?? {}), [String(project)]: dexId(id) }),
  // Debug only: set POKEDEX_DEBUG=1 when starting the server.
  catch: (id) => {
    dexId(id);
    if (process.env.POKEDEX_DEBUG !== "1") throw new Error("catch is a debug action: start the server with POKEDEX_DEBUG=1");
    return recordCatches([dexId(id)]);
  },
  release: (id) => setShared(CAUGHT, caught().filter((n) => n !== dexId(id))),
  setSort: (sort) => setShared("agents.sort", SORTS.includes(sort) ? sort : "priority"),
  // What an app sees its agents do (Herdr's pokedex-agents, Rex's daemon).
  taskFinished: (project, partner, ms, app = null) => finishTask(String(project), dexId(partner), Number(ms) || 0, app),
  subTaskFinished: (project, partner) => finishSubTask(String(project), dexId(partner)),
  unblocked: (project, ms) => unblocked(String(project), Number(ms) || 0),
  // Opening an agent no longer catches its partner; kept so older clients don't error.
  met: () => null,
  // A project's key, found from its repo: progress kept under its old name moves to the key.
  resolveProject: (name, key) => {
    migrateProject(String(name), String(key));
    setShared(PROJECTS, { ...(shared(PROJECTS) ?? {}), [name]: String(key) });
  },
  // Default partners for projects that have none yet; a saved partner is never replaced.
  savePartners: (missing) => {
    const partners = shared(PARTNERS) ?? {};
    const fresh = Object.fromEntries(Object.entries(missing ?? {}).filter(([k]) => partners[k] === undefined).map(([k, id]) => [k, defaultPartner(dexId(id))]));
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
    checkBadges();
    return keys;
  },
};

const snapshot = () => ({ shared: allShared(), notes: notes() });

export function startServer({ port = DEFAULT_PORT, log = console.log } = {}) {
  // A save edited while the server was down (restored, copied in) gets the badges it has earned.
  // An older save is upgraded first.
  locked(() => { migrateSave(); checkBadges(); });
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
  const WATCHED = new Set(["shared.json", "notes.json"]);
  const watcher = fs.watch(STATE_DIR, (_ev, name) => { if (!name || WATCHED.has(name)) broadcast(); });
  const ping = setInterval(() => { for (const c of streams) send(c, ": ping\n\n"); }, 15000);

  const json = (value, status = 200) => Response.json(value, { status });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0, // event streams stay open
    routes: {
      "/health": () => json({ ok: true, pid: process.pid }),
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
            const value = locked(() => asCaller(body, () => fn(...args)));
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
  writeJson(SERVER_FILE, { port: server.port, pid: process.pid });
  log(`pokedex server on http://127.0.0.1:${server.port}`);
  return {
    port: server.port,
    stop() {
      clearInterval(ping);
      watcher.close();
      for (const c of streams) try { c.close(); } catch {}
      for (const ws of sockets) ws.close();
      streams.clear();
      sockets.clear();
      server.stop(true);
    },
  };
}
