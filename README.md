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
| `GET /state` | `{ shared, notes }`: the save and the last day's news |
| `GET /events` | the same, as server-sent events: one `state` event at once, then one after each change |
| `GET /ws` | the same, as WebSocket text messages |
| `POST /call` | `{ action, args, origin, session }` returns `{ ok, value }` or `{ ok: false, error }` |

Actions: `taskFinished`, `subTaskFinished`, `result(project, kind)`, `unblocked`, `throwBall(ball, index)`, `runAway(index)`, `digest`, `setOption(key, value)`, `chooseStarter(id)`, `setParty(ids)`, `setLead(id)`, `claimGift(tr, id)`, `useItem(id, item)`, `seen(key)`, `setPartner`, `savePartners`, `resolveProject`, `release`, `setSort`, `merge`, `import`. `origin` ("rex", "herdr") and `session` are stored on the news a call causes, so the app that caused it can show it.

- Wild Pokemon wait in the tall grass (`wild` in the save, up to 5, a day each); `index` picks one, the oldest by default. A new one is news, never a popup: clients alert only when `shouldAlert()` allows it.
- `setOption`: `alert` is `off`, `on` or `smart` (the default: only while no agent is busy); `hardMode` turns fainting on. Without it, answering a blocked agent within 2 minutes makes its project's next task earn 25% more XP.
- Small news (level-ups, items, quests) is marked `quiet`; `digest` sends one "Welcome back!" summary of it, as does the first turn after 2 hours away.
- XP belongs to one party (`party`, up to 6, the first leads; `pokemon` holds each one's XP), not to projects: every award goes to the lead wherever the work happened, and 25% to the rest of the party (Day Care). A project's entry in `pokedex.partners` is only its mascot (`setPartner`). Before a starter is chosen (`chooseStarter`: 1, 4 or 7), XP waits in `bank`.
- A turn earns 10 XP + 5 per minute, up to 50; `result` adds +20 for a commit, +30 for green tests/CI, +50 and an Ultra Ball for a merge, once per kind per turn. The day's turns 1-5 pay in full, 6-20 40%, 21-50 10%, the rest 3%.
- The trainer level is floor(sqrt(lifetime XP / 40)). Gifts come at trainer levels 5 (Eevee), 10 (Lapras), 15 (Omanyte or Kabuto), 20 (Hitmonlee or Hitmonchan) and 30 (Porygon); a choice waits for `claimGift`.
- `catch` only works when the server runs with `POKEDEX_DEBUG=1`. `met` is gone (it's accepted and does nothing): opening an agent no longer catches its partner.

## Balancing

`bun scripts/simulate.js` plays the rules for three personas (casual, regular, pro) over a year and prints when each milestone lands, plus a repo-neutrality check. `--check` exits 1 when a shipped phase's target is missed.

## State

The save lives in `~/.local/state/pokedex-agents-server/` (`POKEDEX_STATE` overrides it). The first start copies over the save pokemon-rex kept in `~/.local/state/rex-pokedex/`.

## Shared code

The apps keep copies of `src/game.js` and `src/pokemon.js` for read-only helpers (levels, names, odds). Each app's `scripts/sync-game.sh` refreshes its copies from here, and `--check` reports any that differ.

## Tests

```sh
bun test
```
