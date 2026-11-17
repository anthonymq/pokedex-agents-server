// Game rules (mods/pokedex-agents/game.js) against an in-memory stand-in for Herdr's `herdr` module.
// Run with `bun test`. Randomness is pinned per test; nothing touches a real Herdr.
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";

const herdr = { state: {}, notes: [], sounds: [], soundsEnabled: true };
mock.module("herdr", () => ({
  shared: (key) => herdr.state[key],
  setShared: (key, value) => { herdr.state[key] = structuredClone(value); },
  notify: (n) => { herdr.notes.push(n); return "note"; },
  playSound: (sound) => { herdr.sounds.push(sound); return null; },
  settings: () => ({ sounds: { enabled: herdr.soundsEnabled } }),
}));
const G = await import("../src/game.js");

const realRandom = Math.random;
const roll = (value) => { Math.random = () => value; };
const titles = () => herdr.notes.map((n) => n.title);
const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// The save's stats with each of the `n` days before today active, each like `day`.
const withHistory = (n, day) => {
  const now = new Date();
  const days = Object.fromEntries(Array.from({ length: n }, (_, i) => [key(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1 - i)), { turns: 1, ...day }]));
  herdr.state[G.GAME] = { ...herdr.state[G.GAME], stats: { days, lengths: [] } };
};
// Runs `fn` on each listed day of January 2027, at 10:00.
const onDays = (dates, fn) => { for (const d of dates) { setSystemTime(new Date(2027, 0, d, 10)); fn(d); } };

beforeEach(() => {
  herdr.state = {};
  herdr.notes = [];
  herdr.sounds = [];
  herdr.soundsEnabled = true;
  roll(0.99); // no encounter, no shiny unless a test says otherwise
});
afterEach(() => { Math.random = realRandom; });

// A save with a starter leading, so XP has somewhere to go.
const withParty = (party, pokemon = {}, extra = {}) => {
  herdr.state[G.CAUGHT] = [...new Set([...(herdr.state[G.CAUGHT] ?? []), ...party])].sort((x, y) => x - y);
  herdr.state[G.GAME] = { party, pokemon, ...extra };
};

describe("XP and levels", () => {
  test("a turn earns 10 XP plus 5 per full minute, capped at 50", () => {
    expect(G.taskXp(5000)).toBe(10);
    expect(G.taskXp(180000)).toBe(25);
    expect(G.taskXp(3600000)).toBe(50);
    expect(G.taskXp(-1)).toBe(10);
  });

  test("level n needs 4 * n^2 XP, from Lv1 to Lv100", () => {
    expect(G.levelOf(0)).toBe(1);
    expect(G.levelOf(1023)).toBe(15);
    expect(G.levelOf(1024)).toBe(16);
    expect(G.levelOf(1e9)).toBe(100);
    expect(G.progress(4 * 16 ** 2 + (4 * 17 ** 2 - 4 * 16 ** 2) / 2).into).toBeCloseTo(0.5);
  });

  test("level-up news only when the lead crosses a multiple of 5, and it's quiet", () => {
    withParty([1], { 1: 4 * 8 ** 2 }); // Lv8
    G.finishTask("p", 1, 0); // +10 XP, still Lv8
    const levelNews = () => herdr.notes.filter((n) => n.title.includes("reached Lv"));
    expect(levelNews()).toEqual([]);
    herdr.state[G.GAME].pokemon[1] = 4 * 10 ** 2 - 5; // just under Lv10
    G.finishTask("p", 1, 0);
    expect(levelNews().map((n) => n.title)).toEqual(["Bulbasaur reached Lv 10!"]);
    expect(levelNews()[0].quiet).toBe(true);
  });

  test("the day's turns pay less and less: 1-5 in full, then 40%, 10%, 3%", () => {
    withParty([1]);
    const gains = [];
    for (let i = 0; i < 60; i++) {
      const before = G.game().pokemon[1] ?? 0;
      G.finishTask("p", 1, 600000); // 50 XP at full rate
      gains.push(G.game().pokemon[1] - before);
    }
    expect([gains[0], gains[4], gains[5], gains[19], gains[20], gains[49], gains[50]]).toEqual([50, 50, 20, 20, 5, 5, 2]);
  });
});

describe("the party", () => {
  test("XP goes to the lead whatever the project, and 25% to the rest of the party", () => {
    withParty([4, 7]);
    G.finishTask("a", 1, 600000);
    G.finishTask("b", 25, 600000);
    expect(G.game().pokemon).toEqual({ 4: 100, 7: 26 });
    expect(G.game().lifetime).toBe(100);
  });

  test("XP before a starter waits for it; the starter is picked once among the three", () => {
    G.finishTask("p", 1, 600000);
    expect(G.game()).toMatchObject({ party: [], bank: 50, lifetime: 50 });
    expect(() => G.chooseStarter(25)).toThrow();
    G.chooseStarter(7);
    expect(G.game()).toMatchObject({ party: [7], pokemon: { 7: 50 }, bank: 0 });
    expect(herdr.state[G.CAUGHT]).toEqual([7]);
    expect(() => G.chooseStarter(1)).toThrow();
  });

  test("the party holds up to 6 Pokemon from the Pokedex; any of them can lead", () => {
    withParty([4]);
    herdr.state[G.CAUGHT] = [4, 10, 25];
    G.setLead(25);
    expect(G.game().party).toEqual([25, 4]);
    expect(() => G.setParty([4, 151])).toThrow();
    expect(() => G.setParty([4, 4])).toThrow();
    expect(() => G.setParty([])).toThrow();
  });

  test("the trainer level grows with lifetime XP, the same however many projects", () => {
    expect(G.trainerLevel({ lifetime: 0 })).toBe(1);
    expect(G.trainerLevel({ lifetime: 40 * 25 })).toBe(5);
    expect(G.trainerLevel({ lifetime: 40 * 100 })).toBe(10);
  });
});

describe("gifts at trainer levels", () => {
  test("a single gift arrives by itself; a choice waits for the person", () => {
    withParty([1], {}, { lifetime: 40 * 25 - 10 });
    G.finishTask("p", 1, 0); // TR5: Eevee
    expect(herdr.state[G.CAUGHT]).toContain(133);
    expect(G.game().gifts.got).toEqual([5]);
    herdr.state[G.GAME].lifetime = 40 * 225 - 10;
    G.finishTask("p", 1, 0); // TR15: a fossil to choose; TR10's Lapras on the way
    expect(G.game().gifts).toEqual({ got: [5, 10], pending: [15] });
    expect(() => G.claimGift(15, 25)).toThrow();
    G.claimGift(15, 140);
    expect(G.game().gifts).toEqual({ got: [5, 10, 15], pending: [] });
    expect(herdr.state[G.CAUGHT]).toContain(140);
  });
});

describe("results", () => {
  test("a commit, green tests and a merge pay once per turn and project; a merge finds an Ultra Ball", () => {
    withParty([1]);
    expect(G.result("p", "commit")).toBeNull(); // no turn yet
    G.finishTask("p", 1, 0); // 10 XP
    expect(G.result("p", "commit")).toBe("commit");
    expect(G.result("p", "commit")).toBeNull();
    G.result("p", "green");
    G.result("p", "merged");
    expect(G.game().pokemon[1]).toBe(10 + 20 + 30 + 50);
    expect(G.game().bag.ultra).toBe(1);
    expect(() => G.result("p", "deploy")).toThrow();
  });
});

describe("project keys", () => {
  test("labels are the key's last path segment", () => {
    expect(G.projectLabel("/Users/a/workspace/kanto-api")).toBe("kanto-api");
    expect(G.projectLabel("vps:/srv/app")).toBe("app");
  });

  test("projectKey maps a space name, else returns it", () => {
    herdr.state[G.PROJECTS] = { "kanto renamed": "/r/kanto" };
    expect(G.projectKey("kanto renamed")).toBe("/r/kanto");
    expect(G.projectKey("other")).toBe("other");
  });

  test("migrating a project moves its mascot and keeps an existing one there", () => {
    herdr.state[G.PARTNERS] = { "old-name": 4, "/r/kanto": 25, "/r/other": 7 };
    G.migrateProject("old-name", "/r/kanto");
    G.migrateProject("/r/other", "/r/new");
    expect(herdr.state[G.PARTNERS]).toEqual({ "/r/kanto": 25, "/r/new": 7 });
  });
});

describe("evolution, jingles and badges", () => {
  test("reaching the evolution level evolves, keeps the XP, catches, plays one jingle and earns Thunder", () => {
    withParty([4, 7], { 4: 1000 });
    G.finishTask("p", 1, 600000); // +50 XP -> Lv16: Charmander -> Charmeleon
    expect(G.game().party).toEqual([5, 7]);
    expect(G.game().pokemon[5]).toBe(1050);
    expect(herdr.state[G.CAUGHT]).toEqual([4, 5, 7]);
    expect(G.game().recent.map((r) => r.id)).toEqual([5]);
    expect(G.game().badges).toContain("thunder");
    expect(herdr.sounds).toEqual(["mods/pokedex-agents/sounds/evolve.mp3"]); // the badge stays quiet
  });

  test("a badge on its own plays the badge jingle", () => {
    herdr.state[G.CAUGHT] = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    G.recordCatches([10]);
    expect(G.game().badges).toEqual(["boulder"]);
    expect(herdr.sounds).toEqual(["mods/pokedex-agents/sounds/badge.mp3"]);
  });

  test("jingles stay silent when sounds are off", () => {
    herdr.soundsEnabled = false;
    withParty([4], { 4: 1000 });
    G.finishTask("p", 1, 600000);
    expect(herdr.sounds).toEqual([]);
    expect(G.game().party).toEqual([5]);
  });
});

describe("sub-agents", () => {
  test("a finished sub-agent earns 10 XP without counting a task", () => {
    withParty([1]);
    G.finishSubTask("p", 1);
    expect(G.game().pokemon[1]).toBe(G.SUBTASK_XP);
    expect(G.game().subtasks).toBe(1);
    expect(G.game().tasks).toBe(0);
  });
});

describe("encounters", () => {
  test("a finished task can spawn one, counted as seen", () => {
    roll(0);
    G.finishTask("p", 1, 0);
    expect(G.game().encounter).not.toBeNull();
    expect(G.game().encounters.seen).toBe(1);
  });

  test("an expired encounter counts as fled and no longer blocks new ones", () => {
    herdr.state[G.GAME] = { encounter: { id: 94, at: Date.now() - G.ENCOUNTER_MS - 1000, balls: 3 } };
    G.finishTask("p", 1, 0);
    expect(G.game().encounters.fled).toBe(1);
    expect(G.game().encounter).toBeNull();
  });

  test("a throw that lands catches it", () => {
    herdr.state[G.GAME] = { encounter: { id: 94, at: Date.now(), balls: 3 } };
    roll(0);
    expect(G.throwBall()).toBe("caught");
    expect(G.game().encounters.caught).toBe(1);
    expect(herdr.state[G.CAUGHT]).toEqual([94]);
  });

  test("three misses and it flees", () => {
    herdr.state[G.GAME] = { encounter: { id: 94, at: Date.now(), balls: 3 } };
    expect([G.throwBall(), G.throwBall(), G.throwBall()]).toEqual(["missed", "missed", "fled"]);
    expect(G.game().encounters.fled).toBe(1);
  });

  test("running away counts as fled", () => {
    herdr.state[G.GAME] = { encounter: { id: 94, at: Date.now(), balls: 3 } };
    G.runAway();
    expect(G.game().encounters.fled).toBe(1);
    expect(G.game().encounter).toBeNull();
  });

  test("catch rates: basic, final form, legendary", () => {
    expect(G.catchRate(4)).toBe(0.6);
    expect(G.catchRate(6)).toBe(0.35);
    expect(G.catchRate(150)).toBe(0.03);
    expect(G.catchRate(26)).toBe(0.35); // Raichu: a stone evolution's result is final
  });

  test("tasks finished while it waits weaken it, raising the odds", () => {
    herdr.state[G.GAME] = { encounter: { id: 4, at: Date.now(), balls: 3, weak: 0 } };
    G.finishTask("p", 1, 0);
    G.finishTask("p", 1, 0);
    const e = G.game().encounter;
    expect(e.weak).toBe(2);
    expect(G.throwRate(e)).toBeCloseTo(0.9);
    expect(G.throwRate(e, "ultra")).toBe(1);
  });

  test("Poke Balls from the bag are thrown once the encounter's free ones run out", () => {
    herdr.state[G.GAME] = { encounter: { id: 94, at: Date.now(), balls: 0 }, bag: { poke: 1 } };
    expect(G.throwBall("poke")).toBe("fled");
    expect(G.game().bag.poke).toBe(0);
  });

  test("Great Balls come from the bag and keep it there after the free balls run out", () => {
    herdr.state[G.GAME] = { encounter: { id: 94, at: Date.now(), balls: 1 }, bag: { great: 1 } };
    expect(G.throwBall("poke")).toBe("missed");
    expect(G.throwBall("poke")).toBe("empty");
    expect(G.throwBall("great")).toBe("fled");
    expect(G.game().bag.great).toBe(0);
  });

  test("a wild catch gets a dex entry", () => {
    herdr.state[G.GAME] = { encounter: { id: 94, at: Date.now(), balls: 3, project: "p" } };
    roll(0);
    G.throwBall();
    expect(G.game().dex[94]).toMatchObject({ project: "p", how: "wild" });
  });
});

describe("items and item evolutions", () => {
  test("stone Pokemon no longer evolve by level", () => {
    withParty([25], { 25: 1e6 });
    G.finishTask("p", 1, 0);
    expect(G.game().party).toEqual([25]);
  });

  test("using a stone evolves a party member and spends it; without one, or outside the party, nothing happens", () => {
    withParty([133], { 133: 500 }, { bag: { thunder: 1 } });
    expect(G.useItem(133, "fire")).toBeNull();
    expect(G.useItem(25, "thunder")).toBeNull();
    expect(G.useItem(133, "thunder")).toBe(135);
    expect(G.game()).toMatchObject({ party: [135], pokemon: { 135: 500 } });
    expect(G.game().bag.thunder).toBe(0);
    expect(G.game().dex[135]).toMatchObject({ how: "evolved" });
  });

  test("an hour-long task finds a Link Cable and a Great Ball", () => {
    G.finishTask("p", 1, 3600000);
    expect(G.game().bag).toMatchObject({ link: 1 });
    expect(G.game().bag.great).toBeGreaterThanOrEqual(1);
  });
});

describe("blocked agents", () => {
  test("by default a slow answer costs nothing, and a fast one makes the next task earn 25% more", () => {
    G.unblocked("p", G.FAINT_MS);
    expect(G.game().fainted).toEqual({});
    withParty([1]);
    G.unblocked("p", G.FAST_MS);
    G.finishTask("p", 1, 120000); // 20 XP, +25%
    expect(G.game().pokemon[1]).toBe(25);
    G.finishTask("p", 1, 120000);
    expect(G.game().pokemon[1]).toBe(45);
  });

  test("hard mode: left waiting 10 minutes, the partner faints and its next task earns no XP", () => {
    herdr.state[G.OPTIONS] = { hardMode: true };
    withParty([1]);
    G.unblocked("p", G.FAINT_MS);
    expect(G.game().fainted).toEqual({ p: true });
    G.finishTask("p", 1, 0);
    expect(G.game().pokemon[1] ?? 0).toBe(0);
    expect(G.game().fainted).toEqual({});
    G.finishTask("p", 1, 0);
    expect(G.game().pokemon[1]).toBe(10);
  });
});

describe("quests and ranks", () => {
  test("a new player gets the task quests at their minimums, daily and weekly", () => {
    withParty([1]);
    const qs = G.quests();
    expect(qs.map((q) => [q.id, q.needs])).toEqual([["d-tasks", [2, 3, 5]], ["w-tasks", [5, 10, 15]]]);
  });

  test("tiers sit at 50/100/150% of the player's own median, and each one pays", () => {
    withParty([1]);
    withHistory(14, { turns: 30 });
    expect(G.quests().find((q) => q.id === "d-tasks").needs).toEqual([15, 30, 45]);
    for (let i = 0; i < 15; i++) G.finishTask("p", 1, 0);
    expect(G.quests().find((q) => q.id === "d-tasks")).toMatchObject({ tier: 1, need: 30, n: 15 });
    for (let i = 0; i < 30; i++) G.finishTask("p", 1, 0);
    const g = G.game();
    expect(G.quests().find((q) => q.id === "d-tasks")).toMatchObject({ tier: 3, done: true });
    // 1 + 2 Great Balls, then an Ultra Ball and PokeDollars; plus the active day's Great Ball.
    expect([g.bag.great, g.bag.ultra, g.money]).toEqual([4, 1, 50]);
    expect(G.localStats()).toMatchObject({ quests: 1 });
    expect(g.stats.days[key(new Date())].gold).toBe(1);
  });

  test("a quiet player keeps the minimums, and only quests the last 30 days show possible are offered", () => {
    withParty([1]);
    withHistory(14, { turns: 2 });
    expect(G.quests().map((q) => [q.id, q.needs])).toEqual([["d-tasks", [2, 3, 5]], ["w-tasks", [7, 14, 21]]]);
    withHistory(14, { turns: 5, caught: 1 });
    expect(G.quests().map((q) => q.id)).toEqual(expect.arrayContaining(["d-tasks", "d-catch"]));
    expect(G.quests().map((q) => q.id)).not.toContain("d-fast");
  });

  test("one reroll a day, never the task quest nor one that paid", () => {
    withParty([1]);
    withHistory(14, { turns: 10, caught: 2, fast: 2, long: 2, variety: 2 });
    const daily = G.quests().filter((q) => !q.weekly);
    expect(daily.length).toBe(3);
    expect(() => G.rerollQuest("d-tasks")).toThrow();
    const out = daily.find((q) => q.rerollable);
    const next = G.rerollQuest(out.id);
    expect(daily.map((q) => q.id)).not.toContain(next);
    expect(G.quests().map((q) => q.id)).toContain(next);
    expect(G.quests().some((q) => q.rerollable)).toBe(false);
    expect(() => G.rerollQuest(G.quests()[1].id)).toThrow();
  });

  test("all eight Kanto badges make you Champion in the same save", () => {
    herdr.state[G.GAME] = { badges: ["boulder", "cascade", "thunder", "rainbow", "soul", "marsh", "volcano"] };
    herdr.state[G.CAUGHT] = Array.from({ length: 150 }, (_, i) => i + 1);
    G.recordCatches([151]);
    expect(G.game().badges).toEqual(expect.arrayContaining(["earth", "champion"]));
  });
});

describe("save versions and local stats", () => {
  test("a version 1 save is upgraded to the current version with empty stats", () => {
    herdr.state[G.GAME] = { tasks: 3, xp: { p: 40 } };
    expect(G.migrateSave()).toBe(G.SAVE_VERSION);
    expect(herdr.state[G.GAME]).toMatchObject({ tasks: 3, version: G.SAVE_VERSION, stats: { days: {}, lengths: [] }, wild: [] });
  });

  test("a version 2 save's waiting encounter joins the tall grass, and fainting is cleared", () => {
    const e = { id: 94, at: Date.now(), balls: 3 };
    herdr.state[G.GAME] = { version: 2, encounter: e, fainted: { p: true } };
    G.migrateSave();
    expect(G.game()).toMatchObject({ version: G.SAVE_VERSION, wild: [e], encounter: e, fainted: {} });
  });

  test("version 3 to 4: per-project partners become one party, losing nothing", () => {
    herdr.state[G.PARTNERS] = { a: 4, b: 25, c: 4, d: 1, e: 7, f: 10, g: 16, h: 19 };
    herdr.state[G.CAUGHT] = [25, 150];
    const xp = { a: 900, b: 2000, c: 100, d: 50, e: 400, f: 30, g: 20, h: 10 };
    herdr.state[G.GAME] = { version: 3, xp };
    G.migrateSave();
    const g = G.game();
    expect(g.version).toBe(G.SAVE_VERSION);
    expect(g.pokemon).toEqual({ 4: 1000, 25: 2000, 1: 50, 7: 400, 10: 30, 16: 20, 19: 10 });
    expect(g.party).toEqual([25, 4, 7, 1, 10, 16]); // the most XP leads
    expect(g.lifetime).toBe(3510);
    expect(herdr.state[G.CAUGHT]).toEqual([1, 4, 7, 10, 16, 19, 25, 150]);
    expect(herdr.state[G.GAME].xp).toBeUndefined();
    expect(herdr.state[G.PARTNERS].a).toBe(4); // still the mascot
    expect(g.seen).toEqual([]); // the New Pokedex explainer is due
  });

  test("version 4 to 5: the streak carries over with a freeze per 7 active days, and no tutorial", () => {
    withHistory(15, { turns: 3 });
    herdr.state[G.GAME] = { ...herdr.state[G.GAME], version: 4, tasks: 45, streak: { last: "2027-01-08", days: 12, best: 20 } };
    G.migrateSave();
    const g = G.game();
    expect(g.streak).toEqual({ last: "2027-01-08", days: 12, best: 20, freezes: 2, active: 15 });
    expect([g.version, g.tutorial, g.rested, g.money]).toEqual([G.SAVE_VERSION, null, 0, 0]);
  });

  test("a brand-new save doesn't get the New Pokedex explainer", () => {
    G.finishTask("p", 1, 0);
    expect(G.game().seen).toEqual(["phase2"]);
  });

  test("a save newer than the rules is left alone", () => {
    herdr.state[G.GAME] = { version: 99, tasks: 1 };
    expect(G.migrateSave()).toBe(99);
    expect(herdr.state[G.GAME]).toEqual({ version: 99, tasks: 1 });
  });

  test("finished turns and encounters are counted per day", () => {
    G.finishTask("p", 1, 120000);
    G.finishTask("p", 1, 360000);
    roll(0.01); // an encounter, then a catch
    G.finishTask("p", 1, 60000);
    expect(G.throwBall()).toBe("caught");
    const s = G.localStats();
    expect(s).toMatchObject({ activeDays: 1, turnsPerDay: 3, turns: 3, medianTurnMs: 120000, seen: 1, caught: 1, fled: 0 });
  });
});

describe("the tall grass queue", () => {
  test("wild Pokemon wait in a queue of at most 5, and one met an hour ago is still there", () => {
    roll(0.01);
    for (let i = 0; i < 7; i++) G.finishTask("p", 1, 0);
    expect(G.game().wild.length).toBe(G.WILD_MAX);
    expect(G.game().encounters.seen).toBe(G.WILD_MAX);
    herdr.state[G.GAME].wild[0].at = Date.now() - 3600000;
    roll(0.99);
    G.finishTask("p", 1, 0);
    expect(G.game().wild.length).toBe(G.WILD_MAX);
  });

  test("a new one is news but never a quiet one, and opens nothing by itself unless alerts allow it", () => {
    roll(0.01);
    G.finishTask("p", 1, 0);
    const note = herdr.notes.find((n) => n.title.startsWith("A wild"));
    expect(note.quiet).toBeUndefined();
    expect(G.shouldAlert(3)).toBe(false);
    expect(G.shouldAlert(0)).toBe(true);
    G.setOption("alert", "off");
    expect(G.shouldAlert(0)).toBe(false);
    G.setOption("alert", "on");
    expect(G.shouldAlert(5)).toBe(true);
    expect(() => G.setOption("alert", "loud")).toThrow();
  });

  test("throws and running away pick a Pokemon by its place in the queue", () => {
    herdr.state[G.GAME] = { wild: [{ id: 10, at: Date.now(), balls: 3 }, { id: 94, at: Date.now(), balls: 3 }] };
    roll(0);
    expect(G.throwBall("poke", 1)).toBe("caught");
    expect(G.game().wild.map((e) => e.id)).toEqual([10]);
    G.runAway(0);
    expect(G.game().wild).toEqual([]);
    expect(G.game().encounter).toBeNull();
    expect(Object.values(G.game().stats.days)[0]).toMatchObject({ caught: 1, left: 1 });
  });
});

describe("the welcome back summary", () => {
  test("level-ups, items and quests are quiet news, told once in one summary", () => {
    herdr.state[G.GAME] = { xp: { p: 4 * 9 ** 2 }, wild: [{ id: 94, at: Date.now(), balls: 3 }] };
    G.finishTask("p", 1, 3600000); // Lv10 and a Link Cable
    expect(herdr.notes.filter((n) => n.title.includes("Lv 10") || n.title.includes("Link")).every((n) => n.quiet)).toBe(true);
    herdr.notes = [];
    G.digest();
    expect(titles()).toEqual(["Welcome back!"]);
    expect(herdr.notes[0].body).toContain("1 wild Pokemon waiting");
    expect(herdr.notes[0].body).toContain("Link Cable");
    herdr.state[G.GAME].wild = [];
    herdr.notes = [];
    expect(G.digest()).toBeNull();
    expect(titles()).toEqual([]);
  });

  test("the first turn after two hours away sends it", () => {
    herdr.state[G.GAME] = { lastTurn: Date.now() - 3 * 3600000, wild: [{ id: 94, at: Date.now(), balls: 3 }] };
    G.finishTask("p", 1, 0);
    expect(titles()).toContain("Welcome back!");
  });
});

describe("default partners", () => {
  test("always a base form, never a legendary", () => {
    expect(G.defaultPartner(6)).toBe(4);
    expect(G.defaultPartner(136)).toBe(133);
    expect(G.defaultPartner(25)).toBe(25);
    expect([1, 4, 7]).toContain(G.defaultPartner(150));
  });
});

describe("streaks", () => {
  afterEach(() => setSystemTime());

  test("5 active days in the last 7 keep it: two days off a week are fine, a third breaks it", () => {
    onDays([4, 5, 6, 7, 8], () => G.finishTask("p", 1, 0)); // Monday to Friday
    expect(G.game().streak.days).toBe(1);
    setSystemTime(new Date(2027, 0, 10, 10)); // Sunday, nothing yet: through Saturday
    expect(G.liveStreak(G.game())).toBe(2);
    onDays([11], () => G.finishTask("p", 1, 0)); // Monday
    expect(G.game().streak.days).toBe(4);
    // Thursday, Tuesday and Wednesday off: Thursday is the 7th active day, and its freeze covers
    // Tuesday but not Wednesday too.
    onDays([14], () => G.finishTask("p", 1, 0));
    expect(G.game().streak).toMatchObject({ days: 0, best: 5, freezes: 0 });
  });

  test("until a streak starts, the week counts the active days among the last 7", () => {
    onDays([4, 5], () => G.finishTask("p", 1, 0)); // Monday and Tuesday
    expect(G.liveStreak(G.game())).toBe(0);
    expect(G.liveWeek(G.game())).toBe(2);
    setSystemTime(new Date(2027, 0, 11, 10)); // the next Monday: last Monday has left the window
    expect(G.liveWeek(G.game())).toBe(1);
  });

  test("a Streak Freeze, earned every 7 active days, covers a missed day", () => {
    onDays([4, 5, 6, 7, 8, 11, 12], () => G.finishTask("p", 1, 0)); // 7 active days
    expect(G.game().streak.freezes).toBe(1);
    onDays([14], () => G.finishTask("p", 1, 0)); // Thursday, Wednesday missed
    const g = G.game();
    expect(g.streak).toMatchObject({ days: 7, freezes: 0 });
    expect(g.stats.days["2027-01-13"].frozen).toBe(1);
  });
});

describe("rested XP", () => {
  afterEach(() => setSystemTime());

  test("each extra day away banks a day of average XP, up to 3, and XP counts double until it's spent", () => {
    withParty([1]);
    onDays([4], () => G.finishTask("p", 1, 600000)); // 50 XP
    onDays([7], () => G.finishTask("p", 1, 600000)); // 2 days away: 100 banked, 50 of it spent
    expect([G.game().lifetime, G.game().rested]).toEqual([150, 50]);
    onDays([18], () => G.finishTask("p", 1, 600000)); // 10 days away: capped at 3 days (150)
    expect([G.game().lifetime, G.game().rested]).toEqual([250, 100]);
  });

  test("a usual weekend banks nothing", () => {
    withParty([1]);
    onDays([4, 5, 6, 7, 8, 11], () => G.finishTask("p", 1, 600000));
    expect(G.game().rested).toBe(0);
  });
});

describe("Professor Oak's tutorial", () => {
  test("five first steps on a new save, then 5 Poke Balls", () => {
    G.chooseStarter(4);
    expect(G.game().tutorial).toEqual([]);
    G.finishTask("p", 4, 0);
    expect(G.game().tutorial).toEqual(["agent", "task"]);
    roll(0.01); // an encounter (Ivysaur), then a catch
    G.finishTask("p", 4, 0);
    expect(G.throwBall()).toBe("caught");
    G.setLead(2);
    G.markSeen("trainer");
    const g = G.game();
    expect([g.tutorial, g.bag.poke]).toEqual([null, 5]);
    expect(titles()).toContain("Professor Oak: well done!");
  });
});
