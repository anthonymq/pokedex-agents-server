// The Pokedex agents server (src/server.js) over real HTTP, on a free port, with its state in a temp folder.
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.POKEDEX_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "pokedex-server-"));
process.env.POKEDEX_NO_CLIPBOARD = "1";
const { startServer } = await import("../src/server.js");
const { setShared, shared } = await import("../src/store.js");
const { GAME, CAUGHT, PARTNERS } = await import("../src/game.js");

let server, base;
beforeAll(() => {
  server = startServer({ port: 0, log: () => {} });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  server.stop();
  fs.rmSync(process.env.POKEDEX_STATE, { recursive: true, force: true });
});

const call = (action, ...args) =>
  fetch(`${base}/call`, { method: "POST", body: JSON.stringify({ action, args }) }).then((r) => r.json());
// An agent event an app queued while the server was down, sent with the time it happened.
const callAt = (at, action, ...args) =>
  fetch(`${base}/call`, { method: "POST", body: JSON.stringify({ action, args, at }) }).then((r) => r.json());
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const saveFile = () => fs.readFileSync(path.join(process.env.POKEDEX_STATE, "shared.json"), "utf8");

// Reads server-sent `state` events until one passes `test`.
async function nextState(reader, test) {
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended");
    buf += decoder.decode(value, { stream: true });
    let end;
    while ((end = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, end);
      buf = buf.slice(end + 2);
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      if (data && test(JSON.parse(data.slice(6)))) return JSON.parse(data.slice(6));
    }
  }
}

test("changes go through named actions and land in the saved game", async () => {
  expect(await call("setPartner", "/code/app", 25)).toEqual({ ok: true, value: null });
  expect(Object.values(shared(PARTNERS))).toEqual([25]);
  expect((await call("catch", 4)).ok).toBe(false); // a debug action
  process.env.POKEDEX_DEBUG = "1";
  try {
    expect((await call("catch", 4)).ok).toBe(true);
  } finally {
    delete process.env.POKEDEX_DEBUG;
  }
  expect(shared(CAUGHT)).toContain(4);
  expect((await call("release", 4)).ok).toBe(true);
  expect(shared(CAUGHT) ?? []).not.toContain(4);
});

test("project names are hashed in the save and kept readable only on this machine", async () => {
  await call("setPartner", "/work/secret-client-repo", 7);
  await call("resolveProject", "client space", "/work/secret-client-repo");
  const [key] = Object.entries(shared(PARTNERS)).find(([, id]) => id === 7);
  expect(key).toMatch(/^p:[0-9a-f]{16}$/);
  expect(saveFile()).not.toContain("secret-client");
  expect(saveFile()).not.toContain("client space");
  const state = await (await fetch(`${base}/state`)).json();
  expect(state.shared["pokedex.labels"][key]).toBe("secret-client-repo");
  expect(state.shared["pokedex.keys"]["/work/secret-client-repo"]).toBe(key);
  expect(state.shared["pokedex.projects"]["client space"]).toBe("/work/secret-client-repo");
});

test("a save with readable project keys is hashed when it comes in", async () => {
  const game = { version: 5, party: [4], pokemon: { 4: 100 }, dex: { 4: { at: 1, project: "/old/repo", how: "wild" } }, happy: { "/old/repo": true } };
  expect((await call("import", { [GAME]: game, [PARTNERS]: { "/old/repo": 4 } })).ok).toBe(true);
  const key = (await (await fetch(`${base}/state`)).json()).shared["pokedex.keys"]["/old/repo"];
  expect(shared(PARTNERS)[key]).toBe(4);
  expect(shared(GAME).dex[4].project).toBe(key);
  expect(shared(GAME).happy).toEqual({ [key]: true });
  expect(saveFile()).not.toContain("/old/repo");
});

test("the state carries what the apps draw from the clock, and the rules' versions", async () => {
  const version = await (await fetch(`${base}/version`)).json();
  expect(version).toEqual({ rules: expect.any(Number), save: expect.any(Number) });
  const { view } = await (await fetch(`${base}/state`)).json();
  expect(view).toMatchObject({ rules: version.rules, save: version.save, streak: expect.any(Number), week: expect.any(Number) });
  expect(view.quests.some((q) => q.id === "d-tasks")).toBe(true);
});

test("a queued turn counts on the day it happened; one older than 3 days is refused", async () => {
  const yesterday = new Date(Date.now() - 86400000);
  yesterday.setHours(10, 0, 0, 0);
  expect((await callAt(yesterday.getTime(), "taskFinished", "/q/repo", 4, 60000)).ok).toBe(true);
  expect(shared(GAME).stats.days[dayKey(yesterday)].turns).toBe(1);
  const old = await callAt(Date.now() - 4 * 86400000, "taskFinished", "/q/repo", 4, 60000);
  expect(old.ok).toBe(false);
});

test("a turn counts for at most 6 hours, and reports per minute are capped", async () => {
  await call("taskFinished", "/cap/repo", 4, 10 * 86400000);
  expect(shared(GAME).stats.lengths.at(-1)).toBe(6 * 3600000);
  const at = Date.now() - 3600000; // an hour ago: no turn reported yet in that minute
  const replies = [];
  for (let i = 0; i < 31; i++) replies.push(await callAt(at, "taskFinished", "/cap/repo", 4, 1000));
  expect(replies.slice(0, 30).every((r) => r.ok)).toBe(true);
  expect(replies[30]).toEqual({ ok: false, error: "too many taskFinished reports in one minute" });
});

test("bad input is refused without touching the game", async () => {
  expect(await call("catch", 152)).toEqual({ ok: false, error: "152 is not a Kanto number (1 to 151)" });
  expect((await call("eval", "anything")).ok).toBe(false);
  const res = await fetch(`${base}/call`, { method: "POST", body: "not json" });
  expect(res.status).toBe(400);
});

test("a thrown ball plays the encounter on the server and returns the outcome", async () => {
  setShared(GAME, { encounter: { id: 143, at: Date.now(), balls: 1 } });
  const realRandom = Math.random;
  Math.random = () => 0; // always caught
  try {
    expect(await call("throwBall", "poke")).toEqual({ ok: true, value: "caught" });
  } finally {
    Math.random = realRandom;
  }
  expect(shared(GAME).encounter).toBeNull();
  expect(shared(CAUGHT)).toContain(143);
});

test("a merge awards the badges the joined progress has earned", async () => {
  setShared(GAME, { tasks: 40, badges: [] });
  setShared("pokedex.merged", []);
  expect(await call("merge", "other", { [GAME]: { tasks: 20 } })).toEqual({ ok: true, value: "merged" });
  expect(shared(GAME).tasks).toBe(60);
  expect(shared(GAME).badges).toContain("cascade");
});

test("/share returns an X post with the totals and writes a readable card", async () => {
  setShared(CAUGHT, [1, 4, 7, 25]);
  setShared(GAME, { tasks: 12, badges: ["boulder"], shiny: [25] });
  const r = await fetch(`${base}/share`, { method: "POST", body: "{}" }).then((res) => res.json());
  expect(r.ok).toBe(true);
  expect(r.text).toContain("4/151 caught (1 shiny");
  expect(r.text).toContain("1/8 badges · 12 tasks");
  expect(new URL(r.url).searchParams.get("text")).toBe(r.text);
  expect(r.copied).toBe(false);
  const { decodePng } = await import("../src/share.js");
  const card = decodePng(fs.readFileSync(r.card));
  expect(card.width).toBe(1200);
  expect(card.height).toBe(675);
});

test("/events sends the state at once, then again after a change", async () => {
  const res = await fetch(`${base}/events`);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const reader = res.body.getReader();
  const first = await nextState(reader, () => true);
  expect(first).toHaveProperty("shared");
  expect(first).toHaveProperty("notes");
  const changed = nextState(reader, (s) => s.shared["agents.sort"] === "grouped");
  await call("setSort", "grouped");
  expect((await changed).shared["agents.sort"]).toBe("grouped");
  await reader.cancel();
});

test("/ws sends the state on open, then again after a change", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const states = [];
  let wake = null;
  ws.onmessage = (e) => { states.push(JSON.parse(e.data)); wake?.(); };
  const until = (test) => new Promise((resolve) => {
    const check = () => { const hit = states.find(test); if (hit) resolve(hit); };
    wake = check;
    check();
  });
  expect(await until(() => true)).toHaveProperty("shared");
  await new Promise((r) => (ws.readyState === 1 ? r() : (ws.onopen = r)));
  await call("setSort", "priority");
  expect((await until((s) => s.shared["agents.sort"] === "priority")).shared["agents.sort"]).toBe("priority");
  ws.close();
});
