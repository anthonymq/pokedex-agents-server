// Joining Herdr's save into the server's (src/merge.js): nothing either app earned is lost.
import { expect, test } from "bun:test";
import { mergeSaves } from "../src/merge.js";

const G = "pokedex.game", C = "pokedex.caught", P = "pokedex.partners", PR = "pokedex.projects";

test("counts add up, sets join, the earlier dex entry and the later streak are kept", () => {
  const mine = {
    [G]: { xp: { a: 100, b: 5 }, tasks: 3, subtasks: 1, evolutions: 0, badges: ["boulder"], shiny: [4], bag: { great: 1 },
      encounters: { seen: 1, caught: 1, fled: 0 }, streak: { last: "2026-11-15", days: 2, best: 2 },
      dex: { 4: { at: 200, how: "met" } }, recent: [{ id: 4, at: 200 }], encounter: { id: 1 } },
    [C]: [4, 25], [P]: { a: 4, shared: 1 },
  };
  const theirs = {
    [G]: { xp: { a: 50, c: 7 }, tasks: 10, badges: ["boulder", "cascade"], shiny: [], bag: { great: 2, ultra: 1 },
      encounters: { seen: 2, caught: 0, fled: 2 }, streak: { last: "2026-11-16", days: 5, best: 4 },
      dex: { 4: { at: 100, how: "wild" }, 7: { at: 300, how: "met" } }, recent: [{ id: 7, at: 300 }] },
    [C]: [7, 25], [P]: { shared: 9 }, [PR]: { space: "/repo" },
  };
  const m = mergeSaves(mine, theirs);
  expect(m[G].xp).toEqual({ a: 150, b: 5, c: 7 });
  expect(m[G].tasks).toBe(13);
  expect(m[G].badges).toEqual(["boulder", "cascade"]);
  expect(m[G].bag).toEqual({ great: 3, ultra: 1 });
  expect(m[G].encounters).toEqual({ seen: 3, caught: 1, fled: 2 });
  expect(m[G].streak).toEqual({ last: "2026-11-16", days: 5, best: 4 });
  expect(m[G].dex[4]).toEqual({ at: 100, how: "wild" });
  expect(m[G].recent.map((r) => r.id)).toEqual([7]);
  expect(m[G].encounter).toBeNull();
  expect(m[C]).toEqual([4, 7, 25]);
  expect(m[P]).toEqual({ a: 4, shared: 9 });
  expect(m[PR]).toEqual({ space: "/repo" });
});

test("a null game on either side is an empty one", () => {
  expect(mergeSaves({ [G]: { tasks: 2 } }, { [G]: null })[G].tasks).toBe(2);
  expect(mergeSaves({ [G]: null }, { [G]: { tasks: 3 } })[G].tasks).toBe(3);
});
