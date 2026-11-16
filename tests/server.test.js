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
  expect(shared(PARTNERS)).toEqual({ "/code/app": 25 });
  expect((await call("catch", 4)).ok).toBe(true);
  expect(shared(CAUGHT)).toContain(4);
  expect((await call("release", 4)).ok).toBe(true);
  expect(shared(CAUGHT) ?? []).not.toContain(4);
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
