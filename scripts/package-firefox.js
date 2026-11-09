/* Prepare Firefox's unpacked source for linting, packaging and signing (GPL-3.0). */
"use strict";

const { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const root = realpathSync(join(__dirname, ".."));
const from = join(root, "extension");
const to = join(root, "dist", "firefox");
mkdirSync(join(root, "dist"), { recursive: true });
if (realpathSync(join(root, "dist")) !== join(root, "dist") ||
    (existsSync(to) && realpathSync(to) !== to)) {
  throw new Error("Firefox output must stay inside the repository's dist folder");
}
if (existsSync(to)) rmSync(to, { recursive: true });
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
const file = join(to, "manifest.json");
const manifest = JSON.parse(readFileSync(file, "utf8"));
manifest.background = {
  scripts: ["lib/settings.js", "lib/queue-model.js", "lib/queue-sync.js", "queue-background.js", "background.js"],
};
manifest.permissions = manifest.permissions.filter((permission) => permission !== "contextMenus");
manifest.host_permissions = manifest.host_permissions.filter((host) => !host.includes("127.0.0.1"));
manifest.browser_specific_settings = {
  gecko: {
    id: "@yt-tldw-private",
    strict_min_version: "142.0",
    data_collection_permissions: {
      required: ["browsingActivity"],
      optional: ["websiteContent", "authenticationInfo"],
    },
  },
  gecko_android: { strict_min_version: "142.0" },
};
writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
