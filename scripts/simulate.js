#!/usr/bin/env bun
// Pacing simulator: plays the real rules (src/game.js) for the roadmap's three personas over a
// year and prints when each milestone lands. Everything runs in memory with a simulated clock and
// a seeded random source; no save is touched.
//   bun scripts/simulate.js                 the three personas, 365 days
//   bun scripts/simulate.js --days 90 --seed 7 --json
//   bun scripts/simulate.js --check         exit 1 when a shipped phase's target is missed
// Also importable: simulate(persona, options) and neutrality(persona, options).

// --- An in-memory stand-in for the `herdr` module, so game.js runs without a save file.
const mem = { state: {}, notes: 0 };
Bun.plugin({
  name: "herdr-in-memory",
  setup(build) {
    build.module("herdr", () => ({
      loader: "object",
      exports: {
        shared: (key) => mem.state[key],
        setShared: (key, value) => { mem.state[key] = structuredClone(value); },
        notify: () => { mem.notes++; return "note"; },
        playSound: () => null,
        settings: () => ({ sounds: { enabled: false } }),
      },
    }));
  },
});

// --- A simulated clock: `new Date()` and `Date.now()` read `clock`.
const RealDate = Date;
let clock = 0;
class SimDate extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(clock); }
  static now() { return clock; }
}
globalThis.Date = SimDate;

// --- A seeded random source (mulberry32), shared by the rules and the players.
let seedState = 1;
const rand = () => {
  seedState = (seedState + 0x6d2b79f5) >>> 0;
  let t = seedState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
Math.random = rand;

const G = await import("../src/game.js");

// The roadmap's personas. `branches`: how many branches each repo's turns go round. `checks`: how many times a day they open the tall grass and throw at
// everything waiting (spread over the day; the last one at the end of it). `turnMin`: median turn length in minutes. `block`: share of turns where the agent
// asks them something; `answerMin`: mean time to answer it. `commit`, `green`, `merged`: share of
// turns that end with a commit, green tests/CI, a merged MR.
export const PERSONAS = {
  casual: { repos: 1, turns: 5, weekdays: [1, 3, 6], agents: 1, branches: 2, checks: 1, turnMin: 3, block: 0.3, answerMin: 15, commit: 0.3, green: 0.2, merged: 0.02 },
  regular: { repos: 2, turns: 30, weekdays: [1, 2, 3, 4, 5], agents: 2, branches: 3, checks: 3, turnMin: 4, block: 0.3, answerMin: 4, commit: 0.3, green: 0.2, merged: 0.02 },
  // 5-6 active days a week: weekdays, plus every other Saturday.
  pro: { repos: 10, turns: 150, weekdays: [1, 2, 3, 4, 5], altSaturday: true, agents: 3, branches: 3, checks: 4, turnMin: 5, block: 0.3, answerMin: 6, commit: 0.3, green: 0.2, merged: 0.02 },
};
// Default partners, as the clients pick them: one base form per repo.
const BASES = [1, 4, 7, 25, 133, 10, 16, 92, 63, 66, 74, 129, 147, 60, 81];
const KANTO = ["boulder", "cascade", "thunder", "rainbow", "soul", "marsh", "volcano", "earth"];

const exp = (mean) => -mean * Math.log(1 - rand());
// Lognormal around a median, sigma 0.8: mostly short turns, a few long ones.
const turnMs = (medianMin) => {
  const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  return Math.round(medianMin * 60000 * Math.exp(0.8 * z));
};
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const isActive = (p, d) => p.weekdays.includes(d.getDay()) || (p.altSaturday && d.getDay() === 6 && Math.floor(d.getDate() / 7) % 2 === 0);

// Plays one persona for `days` days from `start`. `repos` overrides the persona's repo count.
export function simulate(persona, { days = 365, seed = 1, repos, start = "2027-01-04" } = {}) {
  const p = { ...(typeof persona === "string" ? PERSONAS[persona] : persona) };
  if (repos) p.repos = repos;
  mem.state = {};
  mem.notes = 0;
  seedState = seed >>> 0;
  const projects = Array.from({ length: p.repos }, (_, i) => `repo-${i + 1}`);
  const apps = Array.from({ length: p.agents }, (_, i) => `agent-${i + 1}`);
  const partners = () => mem.state[G.PARTNERS] ?? {};
  const first = new RealDate(`${start}T00:00:00`);
  const out = { persona: p, days, milestones: {}, daily: [], snapshots: {} };
  const appeared = new Set(), shown = new Set();
  const mark = (key, d) => { if (out.milestones[key] === undefined) out.milestones[key] = d; };

  for (let d = 1; d <= days; d++) {
    const date = new RealDate(first.getFullYear(), first.getMonth(), first.getDate() + d - 1);
    const today = { day: d, active: false, turns: 0, seen: 0, caught: 0, fled: 0, quests: 0, gold: 0, interruptions: 0 };
    if (isActive(p, date)) {
      today.active = true;
      // Everyone picks a starter on their first day; a gift waiting for a choice takes its first option.
      if (!G.game().party.length) G.chooseStarter(4);
      // Turns spread over a 9-hour day from 9:00.
      const gap = (9 * 3600000) / p.turns;
      clock = date.getTime() + 9 * 3600000;
      const before = G.game();
      for (let t = 0; t < p.turns; t++) {
        const project = projects[t % projects.length];
        // A repo's default partner, as the clients save it (no catch).
        if (partners()[project] === undefined) mem.state[G.PARTNERS] = { ...partners(), [project]: G.defaultPartner(BASES[projects.indexOf(project) % BASES.length]) };
        const ms = turnMs(p.turnMin);
        if (rand() < p.block) G.unblocked(project, exp(p.answerMin) * 60000);
        G.finishTask(project, partners()[project], ms, apps[t % apps.length], `b${Math.floor(t / projects.length) % p.branches}`);
        for (const kind of ["commit", "green", "merged"]) if (rand() < p[kind]) G.result(project, kind);
        for (const tr of G.game().gifts.pending) G.claimGift(tr, G.GIFTS.find((x) => x.tr === tr).ids[0]);
        // A new wild Pokemon interrupts only when the alert option allows it (agents are busy all day).
        const fresh = G.game().wild.at(-1);
        if (fresh && fresh.at === clock) {
          appeared.add(`${fresh.at}:${fresh.id}`);
          if (G.shouldAlert(p.agents)) today.interruptions++;
        }
        // Checking the tall grass: every waiting Pokemon gets balls until it's caught or gone.
        if ((t + 1) % Math.ceil(p.turns / p.checks) === 0 || t === p.turns - 1) {
          while (G.game().wild.length) {
            const e = G.game().wild[0];
            shown.add(`${e.at}:${e.id}`);
            const g = G.game();
            const r = G.throwBall(e.balls > 0 ? "poke" : (g.bag.great ?? 0) > 0 ? "great" : (g.bag.ultra ?? 0) > 0 ? "ultra" : "poke");
            if (r === "empty") G.runAway();
          }
        }
        // Stones and Link Cables are used as soon as a partner can take one.
        for (const id of G.game().party) for (const it of G.itemsFor(id)) if (it.have > 0) { G.useItem(id, it.item); break; }
        clock += gap;
      }
      const after = G.game();
      today.turns = p.turns;
      today.seen = after.encounters.seen - before.encounters.seen;
      today.caught = after.encounters.caught - before.encounters.caught;
      today.fled = after.encounters.fled - before.encounters.fled;
      const stats = after.stats.days[dayKey(date)] ?? {};
      today.quests = stats.quests ?? 0;
      today.gold = stats.gold ?? 0;
    }
    const g = G.game();
    const caught = (mem.state[G.CAUGHT] ?? []).length;
    const top = Math.max(1, ...G.partyOf(g).map((x) => x.level));
    if (g.evolutions >= 1) mark("firstEvolution", d);
    for (const b of g.badges) mark(`badge:${b}`, d);
    if (KANTO.filter((b) => g.badges.includes(b)).length >= 4) mark("fourBadges", d);
    if (top >= 100) mark("lv100", d);
    if (caught >= 151) mark("fullDex", d);
    today.caughtTotal = caught;
    out.daily.push(today);
    if ([7, 30, 90, 180, 365].includes(d)) {
      out.snapshots[d] = { trainer: G.trainerLevel(g), topLevel: top, caught, badges: g.badges.length, xp: g.lifetime };
    }
  }
  const g = G.game();
  const active = out.daily.filter((x) => x.active);
  const per = (key) => active.reduce((n, x) => n + x[key], 0) / Math.max(1, active.length);
  out.final = {
    xp: g.lifetime, trainer: G.trainerLevel(g), caught: (mem.state[G.CAUGHT] ?? []).length,
    badges: g.badges.length, tasks: g.tasks, evolutions: g.evolutions, notes: mem.notes,
  };
  out.perActiveDay = {
    encounters: per("seen"), caught: per("caught"), fled: per("fled"), interruptions: per("interruptions"),
    questDays: active.filter((x) => x.quests > 0).length / Math.max(1, active.length),
    goldDays: active.filter((x) => x.gold > 0).length / Math.max(1, active.length),
    // Share of wild Pokemon the person got to see before they left (vs fleeing unseen).
    seenShare: appeared.size ? [...appeared].filter((k) => shown.has(k)).length / appeared.size : 1,
  };
  out.stats = G.localStats(g, new Date(clock));
  return out;
}

// Repo neutrality: the same turns in 1 repo vs `repos` repos. Passes when XP, catches and badges
// stay within +/-10%.
export function neutrality(persona = "pro", { repos = 10, days = 90, seed = 1, tolerance = 0.1 } = {}) {
  const one = simulate(persona, { days, seed, repos: 1 }).final;
  const many = simulate(persona, { days, seed, repos }).final;
  const rows = ["xp", "trainer", "caught", "badges"].map((key) => {
    const ratio = many[key] / Math.max(1, one[key]);
    return { key, one: one[key], many: many[key], ratio, pass: Math.abs(ratio - 1) <= tolerance };
  });
  return { persona, repos, days, rows, pass: rows.every((r) => r.pass) };
}

// --- CLI
const when = (d) => (d === undefined ? "never" : `day ${d} (${d <= 14 ? `week ${Math.ceil(d / 7)}` : `month ${Math.ceil(d / 30.4)}`})`);
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

// Targets of the phases shipped so far.
// Phase 1: no forced interruption for anyone by default, the casual player sees >= 90%.
// Phase 2: repo neutrality, the regular player's first evolution on days 2-3, the pro's first Lv100
// no sooner than day 60.
// Phase 3: the casual player completes a quest on >= 80% of active days, the pro reaches Gold on
// <= 40% of them; Rested XP brings the casual player's first evolution into week 1.
// Phase 4: Champion in months 9-12 for the casual player and months 2-3 for the pro, and the pro's
// full Kanto Dex in about 3 months (the casual player's needs Phase 5's Lures: see the roadmap).
export function targets(runs, checks) {
  const by = Object.fromEntries(runs.map((r) => [r.name, r]));
  const rows = [
    ...checks.map((c) => ({ key: `neutrality ${c.persona} 1 vs ${c.repos}`, value: Math.max(...c.rows.map((r) => Math.abs(r.ratio - 1))), pass: c.pass })),
    { key: "regular first evolution (day)", value: by.regular.milestones.firstEvolution ?? -1, pass: [2, 3].includes(by.regular.milestones.firstEvolution) },
    { key: "pro first Lv100 (day)", value: by.pro.milestones.lv100 ?? -1, pass: !(by.pro.milestones.lv100 < 60) },
    ...runs.map((r) => ({ key: `${r.name} forced interruptions/day`, value: r.perActiveDay.interruptions, pass: r.perActiveDay.interruptions === 0 })),
    { key: "casual encounters seen", value: by.casual.perActiveDay.seenShare, pass: by.casual.perActiveDay.seenShare >= 0.9 },
    { key: "casual quest days", value: by.casual.perActiveDay.questDays, pass: by.casual.perActiveDay.questDays >= 0.8 },
    { key: "pro Gold days", value: by.pro.perActiveDay.goldDays, pass: by.pro.perActiveDay.goldDays <= 0.4 },
    { key: "casual first evolution (day)", value: by.casual.milestones.firstEvolution ?? -1, pass: by.casual.milestones.firstEvolution <= 7 },
    { key: "casual Champion (day)", value: by.casual.milestones["badge:champion"] ?? -1, pass: by.casual.milestones["badge:champion"] >= 274 && by.casual.milestones["badge:champion"] <= 365 },
    { key: "pro Champion (day)", value: by.pro.milestones["badge:champion"] ?? -1, pass: by.pro.milestones["badge:champion"] >= 61 && by.pro.milestones["badge:champion"] <= 92 },
    { key: "pro full Kanto Dex (day)", value: by.pro.milestones.fullDex ?? -1, pass: by.pro.milestones.fullDex <= 106 },
  ];
  return { rows, pass: rows.every((r) => r.pass) };
}

function report(runs, checks, targets) {
  const lines = [];
  for (const r of runs) {
    const p = r.persona;
    lines.push(`\n== ${r.name}: ${p.repos} repo(s), ${p.turns} turns/day, ${p.weekdays.length + (p.altSaturday ? 0.5 : 0)} days/week, ${r.days} days`);
    lines.push(`  first evolution   ${when(r.milestones.firstEvolution)}`);
    lines.push(`  4 Kanto badges    ${when(r.milestones.fourBadges)}`);
    for (const b of [...KANTO, "elite", "champion"]) lines.push(`  ${b.padEnd(16)}  ${when(r.milestones[`badge:${b}`])}`);
    lines.push(`  a partner Lv100   ${when(r.milestones.lv100)}`);
    lines.push(`  full Kanto Dex    ${when(r.milestones.fullDex)}`);
    lines.push(`  per active day    ${fmt(r.perActiveDay.encounters)} encounters, ${fmt(r.perActiveDay.caught)} caught, ${fmt(r.perActiveDay.fled)} fled, ${fmt(r.perActiveDay.interruptions)} forced interruptions`);
    lines.push(`  quest days        ${Math.round(r.perActiveDay.questDays * 100)}% of active days, Gold on ${Math.round(r.perActiveDay.goldDays * 100)}%`);
    lines.push(`  encounters seen   ${Math.round(r.perActiveDay.seenShare * 100)}% before they left`);
    lines.push(`  snapshots         ${Object.entries(r.snapshots).map(([d, s]) => `d${d}: TR${s.trainer} top Lv${s.topLevel} ${s.caught} caught ${s.badges} badges`).join(" | ")}`);
  }
  lines.push("\n== Repo neutrality (same turns, 1 repo vs many; +/-10%)");
  for (const c of checks) {
    lines.push(`  ${c.persona}, 1 vs ${c.repos} repos over ${c.days} days: ${c.pass ? "PASS" : "FAIL"}`);
    for (const r of c.rows) lines.push(`    ${r.key.padEnd(8)} ${String(r.one).padStart(7)} -> ${String(r.many).padStart(7)}  x${r.ratio.toFixed(2)} ${r.pass ? "ok" : "off"}`);
  }
  lines.push(`\n== Targets (phases 1-4): ${targets.pass ? "PASS" : "FAIL"}`);
  for (const r of targets.rows) lines.push(`    ${r.key.padEnd(34)} ${fmt(r.value)} ${r.pass ? "ok" : "off"}`);
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : fallback; };
  const days = opt("--days", 365), seed = opt("--seed", 1);
  const runs = Object.keys(PERSONAS).map((name) => ({ name, ...simulate(name, { days, seed }) }));
  const checks = [neutrality("pro", { repos: 10, seed }), neutrality("regular", { repos: 2, seed })];
  const goals = targets(runs, checks);
  if (args.includes("--json")) console.log(JSON.stringify({ runs: runs.map(({ daily, ...r }) => r), checks, targets: goals }, null, 2));
  else console.log(report(runs, checks, goals));
  // --check gates on the targets of the phases shipped so far.
  if (args.includes("--check") && !goals.pass) process.exit(1);
}
