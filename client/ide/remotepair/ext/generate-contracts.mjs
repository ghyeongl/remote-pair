#!/usr/bin/env node
// generate-contracts.mjs — generate ./generated/contracts.json from the monorepo shared/ SoT.
//
// Runs in the MONOREPO (where ../../../../shared exists from remotepair/ext/). The OUTPUT is
// committed so client/ide/ stays self-contained: a standalone build never reaches into the
// parent shared/ at build or runtime — it only consumes the committed generated file.
//
// Regenerate after changing shared/: `node client/ide/remotepair/ext/generate-contracts.mjs`
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// remotepair/ext/ → up 4 to the monorepo root, then shared/
const shared = join(here, "..", "..", "..", "..", "shared");
const rd = (p) => JSON.parse(readFileSync(p, "utf8"));

const proto = rd(join(shared, "screen-protocol", "constants.json"));
const ident = rd(join(shared, "identity", "identity.json"));
const vers = rd(join(shared, "identity", "versions.json"));

const out = {
  _generated: "DO NOT EDIT — generated from monorepo shared/ by generate-contracts.mjs",
  screen: {
    v1aPort: proto.transport.v1a_jpeg.defaultPort,
    v2SignalPort: proto.transport.v2_webrtc.defaultSignalPort,
    remoteInputSupported: proto.remoteInput.supported,
  },
  identity: {
    product: ident.product,
    urlProtocol: ident.urlProtocol,
    ideBundleId: ident.components.ide.darwinBundleIdentifier,
  },
  version: vers.ide,
};

// OUT overrides the destination so drift checks can regenerate to a temp file
// without touching the committed copy (see shared/check-ide-selfcontained.sh).
const dest = process.env.OUT || join(here, "generated", "contracts.json");
if (!process.env.OUT) mkdirSync(join(here, "generated"), { recursive: true });
writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
console.log(`✓ ${dest} written from shared/ SoT`);
