// pairing-metadata-response.test.js — the host's pairing metadata HTTP response (the "metadata part"
// of pairing) verified in isolation, build-free (~ms, no Swift build). The real client fetches
// http://<host>:8891/.well-known/xpair-pairing.json with Node's `http.get`, whose strict llhttp parser
// rejects a malformed response. A Swift multiline string literal does NOT append a newline after its
// last line, so building the header block that way emits "...Connection: close\r\n\r" (a bare CR,
// missing the final LF) instead of "\r\n\r\n" — lenient clients (curl/nc) tolerate it, the client's
// llhttp does not ("Expected LF after headers" → metadata null → pairing never starts).
//
// This test materializes the response exactly as PairingMetadataHTTPServer emits it (from source, no
// build) and asserts a REAL strict HTTP parser accepts it, with correct CRLF framing and a
// Content-Length equal to the body byte length. The negative case proves the parser (and thus this
// test) rejects the original bare-CR bug.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  - ${name}`))
    .catch((error) => {
      failures += 1;
      console.error(`  FAIL - ${name}\n        ${error && error.message ? error.message : error}`);
    });
}

const SWIFT_SRC = path.join(__dirname, "../../../../host/app/PairingManager.swift");

// Materialize the exact bytes PairingMetadataHTTPServer writes for a given body, from the Swift source.
// The header is built as `let header = "..."\n + "..."\n ... var payload = Data(header.utf8)`. We take
// that region, pull out every double-quoted string literal, decode \r \n \t escapes, substitute
// \(body.count) with the body's byte length, and concatenate — reproducing Swift's string value. Then
// header bytes + body bytes = the wire response. If the source ever reverts to a form that drops the
// final LF, the materialized bytes lose it too and the strict parser below rejects them.
function hostMetadataResponse(bodyBytes) {
  const src = fs.readFileSync(SWIFT_SRC, "utf8");
  const start = src.indexOf("let header =");
  assert.notEqual(start, -1, "could not find `let header =` in PairingManager.swift");
  const end = src.indexOf("Data(header.utf8)", start);
  assert.notEqual(end, -1, "could not find `Data(header.utf8)` after `let header =`");
  const region = src.slice(start, end);

  const literals = region.match(/"(?:[^"\\]|\\.)*"/g) || [];
  assert.ok(literals.length > 0, "no string literals in the header-construction region");
  const header = literals
    .map((lit) => lit.slice(1, -1)) // strip surrounding quotes
    .join("")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\(body\.count\)/g, String(bodyBytes.length));
  return Buffer.concat([Buffer.from(header, "utf8"), bodyBytes]);
}

// Feed raw response bytes to Node's REAL strict HTTP parser: a one-shot server writes the bytes and
// closes, and http.get parses them. Resolves the parsed response; rejects on a parse error — exactly
// what the client experiences.
function strictParse(rawBytes) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on("data", () => {});
      socket.end(rawBytes);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const req = http.get({ host: "127.0.0.1", port, path: "/.well-known/xpair-pairing.json" }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          server.close();
          resolve({ statusCode: res.statusCode, headers: res.headers, body });
        });
      });
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
    });
  });
}

async function main() {
  await check("host metadata response is a well-formed HTTP message a strict parser accepts", async () => {
    const body = Buffer.from(JSON.stringify({ hostKeyFP: "SHA256:abc", pairPort: 8890 }), "utf8");
    const raw = hostMetadataResponse(body);

    // Framing: headers must terminate with exactly CRLFCRLF (never a bare CR).
    const sep = raw.indexOf("\r\n\r\n");
    assert.notEqual(sep, -1, "header block does not terminate in CRLFCRLF");

    const res = await strictParse(raw);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "application/json");
    assert.equal(res.headers["cache-control"], "no-store");
    // Content-Length must equal the body's byte length, and the parsed body must round-trip.
    assert.equal(Number(res.headers["content-length"]), body.length);
    assert.deepEqual(JSON.parse(res.body), { hostKeyFP: "SHA256:abc", pairPort: 8890 });
  });

  await check("strict parser rejects the bare-CR framing (the original bug)", async () => {
    // The exact malformed shape the buggy Swift multiline literal produced: header ends in "\r\n\r"
    // (bare CR, no final LF) before the body.
    const body = Buffer.from('{"ok":true}', "utf8");
    const buggy = Buffer.concat([
      Buffer.from(
        "HTTP/1.1 200 OK\r\n" +
          "Content-Type: application/json\r\n" +
          `Content-Length: ${body.length}\r\n` +
          "Connection: close\r\n\r",
        "utf8",
      ),
      body,
    ]);
    await assert.rejects(strictParse(buggy), "strict parser must reject a header block missing its final LF");
  });
}

main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} test(s) FAILED`);
    process.exit(1);
  }
  console.log("\npairing metadata response tests passed");
});
