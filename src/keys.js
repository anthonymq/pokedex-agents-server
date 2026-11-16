// Project keys in the save are keyed hashes, so the save never holds a repo path, a machine name, a
// Herdr space name or a branch name. Apps keep sending readable names; every action that takes a
// project hashes it here, records the readable key -> hash and hash -> short name maps in local.json
// (this machine only), and the rules only ever see hashes.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR, shared, setShared, takeFromSave } from "./store.js";
import { GAME, PARTNERS, PROJECTS, KEYS, LABELS } from "./game.js";

const SECRET_FILE = path.join(STATE_DIR, "secret");
export const isKey = (k) => /^p:[0-9a-f]{16}$/.test(String(k));
let secret = null;
// The secret, made once per machine. Losing it only means projects get new keys (and lose their mascots).
function key() {
  if (secret) return secret;
  try {
    secret = fs.readFileSync(SECRET_FILE, "utf8").trim();
  } catch {}
  if (!secret) {
    secret = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  }
  return secret;
}
const digest = (text) => `p:${crypto.createHmac("sha256", key()).update(text).digest("hex").slice(0, 16)}`;
const shortName = (name) => String(name).split(/[/\\]/).filter(Boolean).pop() ?? String(name);

// A project's key in the save, from any readable name; a key already hashed is kept.
export function projectId(name) {
  name = String(name);
  if (isKey(name)) return name;
  const id = digest(name);
  const keys = shared(KEYS) ?? {};
  if (keys[name] !== id) setShared(KEYS, { ...keys, [name]: id });
  const labels = shared(LABELS) ?? {};
  if (!labels[id]) setShared(LABELS, { ...labels, [id]: shortName(name) });
  return id;
}
// A hash of something that is never shown again (a branch name): no maps kept.
export const hashOnly = (text) => (isKey(text) ? String(text) : digest(String(text)));

// Hashes every project key still readable in the save, and moves the old space -> key map out of it.
// Safe to run any time: the server does at start and after an import or a merge.
export function hashSave() {
  const old = takeFromSave(PROJECTS);
  if (old && typeof old === "object") setShared(PROJECTS, { ...old, ...(shared(PROJECTS) ?? {}) });
  const partners = shared(PARTNERS) ?? {};
  if (Object.keys(partners).some((k) => !isKey(k))) {
    const hashed = {};
    for (const [k, id] of Object.entries(partners)) hashed[projectId(k)] ??= id;
    setShared(PARTNERS, hashed);
  }
  const g = shared(GAME);
  if (!g) return;
  const keyed = (o) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [projectId(k), v])) : o);
  const wild = (e) => (e?.project ? { ...e, project: projectId(e.project) } : e);
  const count = (c) => c && { ...c, projects: (c.projects ?? []).map(projectId), branches: (c.branches ?? []).map(hashOnly) };
  const next = {
    ...g,
    results: keyed(g.results), happy: keyed(g.happy), fainted: keyed(g.fainted),
    wild: g.wild?.map(wild), encounter: wild(g.encounter),
    dex: g.dex && Object.fromEntries(Object.entries(g.dex).map(([id, e]) => [id, e?.project ? { ...e, project: projectId(e.project) } : e])),
    quests: g.quests && { ...g.quests, d: count(g.quests.d), w: count(g.quests.w) },
  };
  if (JSON.stringify(next) !== JSON.stringify(g)) setShared(GAME, next);
}
