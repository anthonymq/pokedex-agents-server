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

Actions: `taskFinished`, `subTaskFinished`, `unblocked`, `met`, `throwBall`, `runAway`, `useItem`, `setPartner`, `savePartners`, `resolveProject`, `catch`, `release`, `setSort`, `merge`, `import`. `origin` ("rex", "herdr") and `session` are stored on the news a call causes, so the app that caused it can show it.

## State

The save lives in `~/.local/state/pokedex-agents-server/` (`POKEDEX_STATE` overrides it). The first start copies over the save pokemon-rex kept in `~/.local/state/rex-pokedex/`.

## Shared code

The apps keep copies of `src/game.js` and `src/pokemon.js` for read-only helpers (levels, names, odds). Each app's `scripts/sync-game.sh` refreshes its copies from here, and `--check` reports any that differ.

## Tests

```sh
bun test
```
