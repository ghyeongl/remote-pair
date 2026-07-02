const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const manager = fs.readFileSync(path.join(root, "host/app/PairingManager.swift"), "utf8");
const onboardingWindow = fs.readFileSync(path.join(root, "host/app/OnboardingWindow.swift"), "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name} - ${error.message.split("\n")[0]}`);
  }
}

test("US-004 window close tears down pairing and backend TTL force-closes Broadcast", () => {
  assert.match(
    onboardingWindow,
    /func windowWillClose\(_ notification: Notification\) \{[\s\S]*PairingManager\.shared\.endWindow\(\)[\s\S]*switch mode/,
    "native close handler must tear down PairingManager before mode-specific close handling",
  );
  assert.match(manager, /private var broadcastExpiryTimer: DispatchSourceTimer\?/);
  assert.match(manager, /private let maxBroadcastTTLSec = [1-9][0-9]*/);
  assert.match(
    manager,
    /func beginWindow\(force: Bool = false\) throws -> \[String: Any\] \{[\s\S]*BonjourAdvertiser\.setPairingInfo[\s\S]*scheduleBroadcastExpiryLocked\(\)/,
    "beginWindow must arm the backend TTL after opening the UDP endpoint",
  );
  // R12-5: the paired short-circuit MUST be gated on !force, so an explicit re-advertise (force=true)
  // opens a fresh window while auto-entry/resume/poll-reopen still short-circuit.
  assert.match(manager, /if !force, let paired = XpairAuthorizedKeys\.latestPaired\(\)/);
  // R12-5: the status reconciler must promote from the ledger only when accepted == nil (genuine
  // resume), never while a new client is mid-proof on a re-advertised window.
  assert.match(manager, /else if accepted == nil, let paired = XpairAuthorizedKeys\.latestPaired\(\)/);
  assert.match(
    manager,
    /timer\.schedule\(deadline: \.now\(\) \+ \.seconds\(maxBroadcastTTLSec\)\)/,
    "TTL timer must be bounded by the backend, not by React cleanup",
  );
  assert.match(
    manager,
    /private func expireBroadcastWindowLocked\(\) \{[\s\S]*phase = "closed"[\s\S]*incoming = nil[\s\S]*incomingExpiresAt = nil[\s\S]*lastError = "broadcast expired; restart pairing"[\s\S]*closeEndpoint\(cancelBroadcastTimer: false\)/,
    "TTL expiry must force the same closed endpoint state as UI cleanup",
  );
	  assert.match(
	    manager,
	    /private func closeEndpoint\(cancelBroadcastTimer: Bool = true, cancelMetadata: Bool = true\) \{[\s\S]*broadcastExpiryTimer\?\.cancel\(\)[\s\S]*metadataServer\?\.cancel\(\)[\s\S]*endpoint\?\.cancel\(\)[\s\S]*serviceInstanceID = ""[\s\S]*hostNonce = ""[\s\S]*BonjourAdvertiser\.setPairingInfo\(nil\)/,
	    "normal endpoint close must cancel TTL, clear broadcast identity, and stop Bonjour pairing info",
	  );
});

test("US-004 pairing nonce uses SecRandomCopyBytes before advertising", () => {
  assert.match(manager, /import Security/);
  assert.match(manager, /case randomUnavailable\(OSStatus\)/);
  assert.match(manager, /private static func randomToken\(byteCount: Int\) throws -> String/);
  assert.match(manager, /SecRandomCopyBytes\(kSecRandomDefault, bytes\.count, &bytes\)/);
  assert.match(
    manager,
    /guard status == errSecSuccess else \{[\s\S]*throw PairingSecurityError\.randomUnavailable\(status\)/,
    "nonce generation must fail closed on SecRandomCopyBytes failure",
  );
  assert.doesNotMatch(manager, /SystemRandomNumberGenerator/);
  assert.doesNotMatch(manager, /UInt8\.random/);
  assert.match(
    manager,
    /let nextHostNonce = try Self\.randomToken\(byteCount: 24\)[\s\S]*let server = try PairingUDPServer[\s\S]*phase = "waiting"[\s\S]*hostNonce = nextHostNonce[\s\S]*BonjourAdvertiser\.setPairingInfo/,
    "pairing window must not enter waiting state or advertise before CSPRNG nonce generation succeeds",
  );
});

test("US-004 SSH proof requires observed fingerprint and has no filesystem marker fallback", () => {
  assert.doesNotMatch(manager, /consumeProofMarkers/, "local marker consumers must not pair clients");
  assert.doesNotMatch(manager, /pairing-proofs/, "forged files under pairing-proofs must not be proof inputs");
  assert.doesNotMatch(manager, /loginFingerprint\s*\?\?\s*approved/, "missing login fingerprint must not default to approved");
  assert.match(manager, /static func markPaired\(clientID: String, loginFingerprint: String\?\) throws/);
  assert.match(manager, /guard let login = loginFingerprint\?\.trimmingCharacters/);
  assert.match(manager, /throw PairingSecurityError\.missingLoginFingerprint/);
  assert.match(manager, /PairingSecurity\.proofMatches\(approvedFingerprint: approved, loginFingerprint: login\)/);
  assert.match(manager, /throw PairingSecurityError\.proofFingerprintMismatch/);
	  assert.match(
	    manager,
	    /static var defaultGatePath: String \{ "\\\(home\)\/\.xpair\/host\/bin\/xpair-ssh-gate" \}/,
	    "production gate path must live under the user-writable Xpair host bin dir",
	  );
		  assert.match(manager, /permitopen="127\.0\.0\.1:\\#\(remoteDesktopSignalPort\)"/);
		  assert.match(manager, /restrict,pty,port-forwarding/);
		  assert.match(manager, /static let remoteDesktopSignalPort = 8890/);
	  assert.match(manager, /assert\(!line\.contains\("no-port-forwarding"\)\)/);
	  // R9-3: forwarding is deferred to the paired state. buildRestrictedLine gates the tokens behind
	  // `paired`, install() writes the pending (no-forwarding) line, and the gate grants forwarding
	  // (ledger-flip FIRST, then add_authorized_key_forwarding) only on promotion — idempotently.
	  assert.match(manager, /let forwarding = paired \?/);
	  assert.match(manager, /paired: false\)/);
	  assert.match(manager, /sub add_authorized_key_forwarding \{/);
	  assert.match(manager, /\$line =~ s\/\\Arestrict,pty,\/restrict,pty,port-forwarding,permitopen="127\.0\.0\.1:8890",\//);
	  assert.match(manager, /write_ledger\(\);\s*add_authorized_key_forwarding\(\);[^\n]*\n\s*print "paired/);
	  assert.match(
	    manager,
	    /command="\\#\(gatePath\) \\#\(clientID\) \\#\(fingerprint\)"/,
    "authorized_keys forced command must carry the matched key fingerprint into the live gate",
  );
  assert.match(manager, /export XPAIR_GATE_LOGIN_FP="\$login_fp"/);
  assert.match(manager, /my \$login_fp = \$ENV\{"XPAIR_GATE_LOGIN_FP"\}/);
  assert.match(manager, /require_matching_login_fingerprint\(\);[\s\S]*\$rec->\{status\} = "paired"/);
  assert.match(
    manager,
    /if \(\$status eq "accepted-pending-proof"\) \{[\s\S]*reject\("pairing proof deadline expired", 67\)[\s\S]*print "paired\\n";[\s\S]*exit 0;/,
    "forced command must keep validating pending and expired ledger states under lock",
  );
});

test("US-004 accept requires exact non-empty displayed fingerprint", () => {
  assert.match(manager, /func acceptIncoming\(requestID: String, fingerprint: String\) throws -> \[String: Any\]/);
  assert.doesNotMatch(manager, /func acceptIncoming\(requestID: String, fingerprint: String\?/);
  assert.doesNotMatch(manager, /approvedFingerprint == nil \|\| approvedFingerprint!\.isEmpty/);
  assert.match(
    manager,
    /guard req\.id == requestID,[\s\S]*!fingerprint\.isEmpty,[\s\S]*fingerprint == req\.fingerprint else \{[\s\S]*throw PairingSecurityError\.requestMismatch/,
    "accept must reject empty or mismatched fingerprints before installing the key",
  );
  assert.match(
    onboardingWindow,
    /let fingerprint = \(request\?\["keyFingerprint"\] as\? String\) \?\? ""/,
    "missing UI fingerprint must flow to PairingManager as an empty value that is rejected",
  );
  assert.match(manager, /private static func acceptIncomingRequiresExactNonEmptyFingerprint\(pubLine: String\) throws/);
  assert.match(manager, /acceptIncoming\(requestID: req\.id, fingerprint: ""\)/);
  assert.match(manager, /acceptIncoming\(requestID: req\.id, fingerprint: "SHA256:different"\)/);
  assert.match(manager, /acceptIncoming\(requestID: req\.id,[\s\S]*fingerprint: req\.fingerprint\)/);
});

test("US-004 pending proof confirms pairing and exits before command execution", () => {
  assert.match(
    manager,
    /case "\$gate_action" in[\s\S]*paired\)[\s\S]*printf '%s\\n' "xpair-ssh-gate: paired"[\s\S]*exit 0[\s\S]*exec\)[\s\S]*if \[ -n "\$\{SSH_ORIGINAL_COMMAND:-\}" \]/,
    "pending proof must exit before SSH_ORIGINAL_COMMAND while paired connections may continue to exec",
  );
  assert.match(
    manager,
    /if \(\$status eq "paired"\) \{[\s\S]*require_matching_login_fingerprint\(\);[\s\S]*print "exec\\n";[\s\S]*exit 0;/,
    "already paired clients still require the observed fingerprint before command execution",
  );
});

test("US-004 key install is ledger-first and rolls back on partial failure", () => {
	  assert.match(manager, /let originalLines = readAuthorizedKeyLines\(\)/);
	  assert.match(manager, /isXpairAuthorizedKeyLine\(existing\)[\s\S]*authorizedKeyBlob\(in: existing\) == req\.keyBlob/);
	  assert.match(manager, /let originalLedger = readLedger\(\)/);
  assert.match(
    manager,
    /try writeLedger\(ledger\)[\s\S]*do \{[\s\S]*try ensureGateHelperReady\(\)[\s\S]*try writeAuthorizedKeyLines\(lines\)[\s\S]*\} catch \{[\s\S]*try\? writeLedger\(originalLedger\)[\s\S]*try\? writeAuthorizedKeyLines\(originalLines\)/,
    "ledger write must happen before authorized_keys write, with rollback for later failures",
	  );
		  assert.match(manager, /private static func installPreservesUnmarkedSameBlobAuthorizedKey\(pubLine: String\) throws/);
		  assert.match(manager, /private static func installRemovesMarkedDuplicateAuthorizedKey\(pubLine: String\) throws/);
	});

test("US-004 UDP rate limiting has a global bucket and LRU source eviction", () => {
  assert.match(manager, /private var globalRateBucket = SourceRateBucket/);
  assert.match(manager, /private let globalBucketCapacity = [1-9][0-9.]+/);
  assert.match(manager, /private func consumeGlobalDatagramToken\(now: Int64\) -> Bool/);
  assert.match(
    manager,
    /guard consumeGlobalDatagramToken\(now: now\) else \{ return false \}[\s\S]*if rateBuckets\[key\] == nil && rateBuckets\.count >= maxSourceBuckets \{[\s\S]*evictLRUSourceBucket\(\)/,
    "global throttling must run before per-source accounting and full tables must evict instead of closing broadcast",
  );
  assert.match(manager, /private func evictLRUSourceBucket\(\)/);
  assert.match(manager, /lastSeen: Int64/);
  assert.doesNotMatch(manager, /broadcast exhausted/, "spoofed sources must not force a permanent broadcast exhausted state");
});

console.log(`REDGREEN ${passed} ${failed}`);
process.exit(failed ? 1 : 0);
