# pokedex-agents-server

The Pokedex game for coding agents, as one small local server. It holds the rules (XP, evolutions, wild encounters, badges, quests) and the save. The game's front ends, [pokemon-rex](https://github.com/anthonymq/pokemon-rex) and [pokemon-herdr](https://github.com/anthonymq/pokemon-herdr), are its clients: they report what their agents do and draw what the server sends back. Neither app depends on the other.

## Install

You need [Bun](https://bun.sh).

```sh
git clone <this repo> ~/.local/share/pokedex-agents-server
```

You don't start it yourself: the first app that needs the server and can't reach it starts it. Starting it twice is harmless, because the second copy finds the port taken and exits. The apps look for it in `$POKEDEX_SERVER_DIR`, then `~/.local/share/pokedex-agents-server`, then `~/workspace-perso/pokedex-agents-server`. To run it by hand:

```sh
bun bin/pokedex-agents-server.js
```

## API

It listens on `127.0.0.1:7151` only. To change the port, set `POKEDEX_PORT`, or `"port"` in `config.json` in the state folder.

| Route | What it does |
| --- | --- |
| `GET /state` | `{ shared, notes, view }`: the save, the last day's news, and what the apps draw that depends on the clock |
| `GET /events` | the same, as server-sent events: one `state` event at once, then one after each change |
| `GET /ws` | the same, as WebSocket text messages |
| `GET /version` | `{ rules, save }`: the versions of the rules and the save this server runs |
| `POST /call` | `{ action, args, origin, session, at? }` returns `{ ok, value }` or `{ ok: false, error }` |

Actions: `taskFinished`, `subTaskFinished`, `result(project, kind)`, `unblocked`, `throwBall(ball, index)`, `runAway(index)`, `digest`, `setOption(key, value)`, `chooseStarter(id)`, `setParty(ids)`, `setLead(id)`, `claimGift(tr, id)`, `useItem(id, item)`, `rerollQuest(id)`, `seen(key)`, `setPartner`, `savePartners`, `resolveProject`, `release`, `setSort`, `merge`, `import`. `origin` ("rex", "herdr") and `session` are stored on the news a call causes, so the app that caused it can show it.

- `view` holds what the clock decides, so an app never shows it from an older or newer copy of the rules: `quests` (today's three and this week's one, with their progress), `streak`, and `rules` and `save`, the versions also served by `/version`. The state is sent again when the day turns, even if nothing was written. An app whose `RULES_VERSION` differs from the server's warns about it.
- `at` is when an agent event happened, in milliseconds: an app that couldn't reach the server queues the report and sends it later with its own time, and the rules count it on that day. More than 3 days late and it no longer counts. Only `taskFinished`, `subTaskFinished`, `unblocked` and `result` take it.
- Reports are capped so a buggy or dishonest app can't inflate the game: a turn counts for at most 6 hours, and each kind for at most 30 to 60 reports a minute, counted by when they happened (a replayed queue isn't refused).
- Wild Pokemon wait in the tall grass (`wild` in the save, up to 5, a day each); `index` picks one, the oldest by default. A new one is news, never a popup: clients alert only when `shouldAlert()` allows it.
- `setOption`: `alert` is `off`, `on` or `smart` (the default: only while no agent is busy); `hardMode` turns fainting on. Without it, answering a blocked agent within 2 minutes makes its project's next task earn 25% more XP.
- Small news (level-ups, items, quests) is marked `quiet`; `digest` sends one "Welcome back!" summary of it, as does the first turn after 2 hours away.
- XP belongs to one party (`party`, up to 6, the first leads; `pokemon` holds each one's XP), not to projects: every award goes to the lead wherever the work happened, and 25% to the rest of the party (Day Care). A project's entry in `pokedex.partners` is only its mascot (`setPartner`). Before a starter is chosen (`chooseStarter`: 1, 4 or 7), XP waits in `bank`.
- A turn earns 10 XP + 5 per minute, up to 50; `result` adds +20 for a commit, +30 for green tests/CI, +50 and an Ultra Ball for a merge, once per kind per turn. The day's turns 1-5 pay in full, 6-20 40%, 21-50 10%, the rest 3%.
- The trainer level is floor(sqrt(lifetime XP / 40)). Gifts come at trainer levels 5 (Eevee), 10 (Lapras), 15 (Omanyte or Kabuto), 20 (Hitmonlee or Hitmonchan) and 30 (Porygon); a choice waits for `claimGift`.
- Quests are sized to the player: three daily (always a task quest) and one weekly, each with Bronze / Silver / Gold at 50% / 100% / 150% of their own median over the 14 days before, never under a minimum. Every tier pays (Bronze a Great Ball, Gold an Ultra Ball and 50 PokeDollars; the weekly one pays Ultra Balls, a stone and 200). A quest is only offered when the best of the last 30 days would have reached its Bronze, and `rerollQuest` swaps one that hasn't paid for another, once a day.
- The streak counts days, not amount: a day keeps it when 5 of the 7 days ending with it were active, so any two days off a week are fine. A **Streak Freeze**, earned every 7 active days (2 at most), is spent by itself on a missing day that would break it. The Rainbow badge needs a 2-week streak and Volcano an 8-week one.
- **Rested XP**: each day off beyond the two a week a streak allows banks one day of the player's average XP, up to 3 days of it, and XP counts double until the bank is spent. A usual weekend banks nothing.
- A new save gets Professor Oak's five first steps (`tutorial`); finishing them pays 5 Poke Balls. The bag holds Poke Balls too, thrown once an encounter's free three run out.
- **PokeDollars** (`money`) add up from Gold quests. Nothing spends them yet.
- `catch` only works when the server runs with `POKEDEX_DEBUG=1`. `met` is gone (it's accepted and does nothing): opening an agent no longer catches its partner.

## Balancing

`bun scripts/simulate.js` plays the rules for three personas (casual, regular, pro) over a year and prints when each milestone lands, plus a repo-neutrality check. `--check` exits 1 when a shipped phase's target is missed: repo neutrality, no forced interruptions, the casual player seeing 90% of their encounters and finishing a quest on 80% of their active days, the pro reaching Gold on at most 40% of them, the regular player's first evolution on days 2-3, the casual player's within week 1, and the pro's first Lv100 no sooner than day 60.

## State

The save lives in `~/.local/state/pokedex-agents-server/` (`POKEDEX_STATE` overrides it). The first start copies over the save pokemon-rex kept in `~/.local/state/rex-pokedex/`.

Project keys in the save are keyed hashes (`p:` and 16 hex digits), so it holds no repo path, machine name, Herdr space name or branch name: an action that names a project is hashed at the boundary (`src/keys.js`) with the key in `secret`, and the readable names live beside the save in `local.json` (a space name to its repo, a readable key to the save's key, and the save's key to a short label). The apps get them with the state, so they can still show "eot-app" on a card while the save only knows the hash. Neither file is part of the save: an export, an import or a merge never carries them, and `secret` and `local.json` are the two files never to copy anywhere shared. Losing `secret` only costs the projects their mascots: they get new keys.

## Shared code

The apps keep copies of `src/game.js` and `src/pokemon.js` for read-only helpers (levels, names, odds). Each app's `scripts/sync-game.sh` refreshes its copies from here, and `--check` reports any that differ.

## Tests

```sh
bun test
```
