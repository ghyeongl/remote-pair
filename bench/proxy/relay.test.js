#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  CLASS_DTLS,
  CLASS_RTCP,
  CLASS_RTP,
  CLASS_STUN,
  DIR_HOST_TO_CLIENT,
  Impairer,
  Relay,
  SeqNormalizer,
  classifyPacket,
  createStats,
  endpointKey,
} = require("./relay");

function stunPacket() {
  return Buffer.from([0x00, 0x01, 0x00, 0x00]);
}

function dtlsPacket() {
  return Buffer.from([0x16, 0xfe, 0xfd, 0x00]);
}

function rtcpPacket() {
  return Buffer.from([0x80, 0xc8, 0x00, 0x06]);
}

function rtpPacket(seq, length = 100) {
  const buffer = Buffer.alloc(Math.max(length, 12));
  buffer[0] = 0x80;
  buffer[1] = 96;
  buffer.writeUInt16BE(seq & 0xffff, 2);
  buffer.writeUInt32BE(1234 + seq, 4);
  buffer.writeUInt32BE(0xfeedbeef, 8);
  return buffer;
}

function config(overrides = {}) {
  return {
    profile: "passthrough",
    seed: "relay-test",
    latencyMs: 0,
    jitterMs: 0,
    loss: 0,
    geP: 0.02,
    geR: 0.25,
    geLossBad: 1,
    fragBytes: 1100,
    fragLoss: 1,
    rtcpLoss: 0,
    ...overrides,
  };
}

function droppedSeqs(seed) {
  const cfg = config({ profile: "loss", seed, loss: 0.35 });
  const impairer = new Impairer(cfg, createStats(cfg));
  const dropped = [];
  for (let seq = 4000; seq < 4050; seq += 1) {
    const packet = rtpPacket(seq);
    const decision = impairer.decide(classifyPacket(packet), DIR_HOST_TO_CLIENT, packet.length);
    if (decision.drop) dropped.push(decision.normSeq);
  }
  return dropped;
}

assert.equal(classifyPacket(stunPacket()).className, CLASS_STUN);
assert.equal(classifyPacket(dtlsPacket()).className, CLASS_DTLS);
assert.equal(classifyPacket(rtcpPacket()).className, CLASS_RTCP);
assert.equal(classifyPacket(rtpPacket(7)).className, CLASS_RTP);
assert.equal(classifyPacket(rtpPacket(7)).seq, 7);

{
  const cfg = config({ profile: "loss", loss: 1 });
  const stats = createStats(cfg);
  const impairer = new Impairer(cfg, stats);
  assert.equal(impairer.decide(classifyPacket(stunPacket()), DIR_HOST_TO_CLIENT, 4).drop, false);
  assert.equal(impairer.decide(classifyPacket(dtlsPacket()), DIR_HOST_TO_CLIENT, 4).drop, false);
  const packet = rtpPacket(1200);
  assert.equal(impairer.decide(classifyPacket(packet), DIR_HOST_TO_CLIENT, packet.length).drop, true);
  assert.equal(impairer.decide(classifyPacket(packet), DIR_HOST_TO_CLIENT, packet.length).drop, false);
  assert.equal(stats.retransmitsPassed, 1);
}

assert.deepEqual(droppedSeqs("same-seed"), droppedSeqs("same-seed"));
assert.notDeepEqual(droppedSeqs("same-seed"), droppedSeqs("other-seed"));

// Residual loss (RETX_LOSS): retransmits can also be dropped, so NACK/RTX no
// longer trivially recovers. retxLoss=1 drops every retransmit too.
{
  const cfg = config({ profile: "loss", loss: 1, retxLoss: 1 });
  const stats = createStats(cfg);
  const impairer = new Impairer(cfg, stats);
  const packet = rtpPacket(2200);
  assert.equal(impairer.decide(classifyPacket(packet), DIR_HOST_TO_CLIENT, packet.length).drop, true);
  const retx = impairer.decide(classifyPacket(packet), DIR_HOST_TO_CLIENT, packet.length);
  assert.equal(retx.drop, true);
  assert.equal(retx.reason, "retxLoss");
  assert.equal(stats.retransmitsPassed, 0);
  assert.equal(stats.retransmitsDropped, 1);
}

// Bandwidth cap (leaky bucket): saturating the link queues then tail-drops.
{
  const cfg = config({ profile: "passthrough", bwKbps: 1000, bwBufferMs: 100 });
  const stats = createStats(cfg);
  const impairer = new Impairer(cfg, stats);
  // 1000 kbps = 125 bytes/ms. A 1250-byte packet takes 10ms to clear.
  // bandwidthDecision is time-based; drive it with explicit nowMs for determinism.
  const d0 = impairer.bandwidthDecision(1250, 1000); // link idle -> only txMs delay
  assert.equal(d0.drop, false);
  assert.equal(d0.delayMs, 10);
  // Immediately enqueue many more at the same instant: queue grows until overflow.
  let drops = 0, passes = 0;
  for (let i = 0; i < 50; i += 1) {
    const d = impairer.bandwidthDecision(1250, 1000);
    if (d.drop) drops += 1; else passes += 1;
  }
  assert.ok(drops > 0, "tight bandwidth + burst must tail-drop");
  // buffer 100ms / 10ms per pkt ~= 10 packets queued before overflow
  assert.ok(passes <= 11 && passes >= 8, `expected ~10 queued, got ${passes}`);
}

// Bandwidth disabled (default) never drops or delays.
{
  const cfg = config({ profile: "passthrough", bwKbps: 0 });
  const impairer = new Impairer(cfg, createStats(cfg));
  const d = impairer.bandwidthDecision(1250, 1000);
  assert.equal(d.drop, false);
  assert.equal(d.delayMs, 0);
}

// retxLoss=0 (default) keeps the old behavior: retransmits always pass.
{
  const cfg = config({ profile: "loss", loss: 1, retxLoss: 0 });
  const stats = createStats(cfg);
  const impairer = new Impairer(cfg, stats);
  const packet = rtpPacket(2300);
  impairer.decide(classifyPacket(packet), DIR_HOST_TO_CLIENT, packet.length);
  assert.equal(impairer.decide(classifyPacket(packet), DIR_HOST_TO_CLIENT, packet.length).drop, false);
  assert.equal(stats.retransmitsPassed, 1);
  assert.equal(stats.retransmitsDropped, 0);
}

{
  const cfg = config({ profile: "burst", seed: "burst-seed", geP: 0.7, geR: 0.05, geLossBad: 1 });
  const impairer = new Impairer(cfg, createStats(cfg));
  const dropped = [];
  for (let seq = 200; seq < 240; seq += 1) {
    const packet = rtpPacket(seq);
    if (impairer.decide(classifyPacket(packet), DIR_HOST_TO_CLIENT, packet.length).drop) dropped.push(seq);
  }
  let hasConsecutiveDrop = false;
  for (let i = 1; i < dropped.length; i += 1) {
    if (dropped[i] === dropped[i - 1] + 1) hasConsecutiveDrop = true;
  }
  assert.equal(hasConsecutiveDrop, true, `expected bursty consecutive drops, got ${dropped.join(",")}`);
}

{
  const cfg = config({ profile: "fragment", fragBytes: 1100, fragLoss: 1 });
  const impairer = new Impairer(cfg, createStats(cfg));
  const small = rtpPacket(1, 500);
  const large = rtpPacket(2, 1200);
  assert.equal(impairer.decide(classifyPacket(small), DIR_HOST_TO_CLIENT, small.length).drop, false);
  assert.equal(impairer.decide(classifyPacket(large), DIR_HOST_TO_CLIENT, large.length).drop, true);
}

{
  const cfg = config({ profile: "marked-burst", burstSchedule: [{ startOffsetMs: 1000, durationMs: 500 }] });
  const stats = createStats(cfg);
  const impairer = new Impairer(cfg, stats);
  const originalNow = Date.now;
  // Media starts well AFTER relay process start; the burst schedule must anchor to the
  // first host→client RTP packet (media start), not to startedAt.
  const t0 = Date.parse(stats.startedAt) + 5000;
  try {
    // First media packet anchors the schedule and is itself before the burst window.
    Date.now = () => t0;
    const first = rtpPacket(9);
    assert.equal(impairer.decide(classifyPacket(first), DIR_HOST_TO_CLIENT, first.length).drop, false);
    assert.equal(stats.bursts.length, 1);
    assert.equal(stats.bursts[0].startOffsetMs, 1000);
    assert.equal(stats.bursts[0].startMs, t0 + 1000);
    // Inside the burst window [t0+1000, t0+1500): dropped.
    Date.now = () => t0 + 1100;
    const inBurst = rtpPacket(10);
    assert.equal(impairer.decide(classifyPacket(inBurst), DIR_HOST_TO_CLIENT, inBurst.length).drop, true);
    // After the burst: forwarded again.
    Date.now = () => t0 + 2000;
    const after = rtpPacket(11);
    assert.equal(impairer.decide(classifyPacket(after), DIR_HOST_TO_CLIENT, after.length).drop, false);
  } finally {
    Date.now = originalNow;
  }
}

{
  const normalizer = new SeqNormalizer();
  assert.equal(normalizer.normalize(65534), 0);
  assert.equal(normalizer.normalize(65535), 1);
  assert.equal(normalizer.normalize(0), 2);
  assert.equal(normalizer.normalize(1), 3);
}

{
  // Multi-endpoint routing: a stale connectivity-check endpoint fills a bootstrap slot
  // before the ICE-nominated client. Media (RTP, which only the host sends) must route
  // to the live client by role, never to the stale endpoint parked in a peer slot.
  const relay = new Relay(config({ profile: "passthrough" }));
  const sent = [];
  relay.socket = { send: (_buf, port, address) => sent.push(`${address}:${port}`) };
  const stale = { address: "127.0.0.1", port: 6000 };
  const realClient = { address: "127.0.0.1", port: 7000 };
  const host = { address: "127.0.0.1", port: 5000 };

  relay.handleMessage(stunPacket(), stale);        // bootstrap: peerA = stale
  relay.handleMessage(stunPacket(), realClient);   // bootstrap: peerB = real client
  relay.handleMessage(stunPacket(), host);         // slots full; host not parked
  relay.handleMessage(rtcpPacket(), realClient);   // real client stays most-recently-active

  sent.length = 0;
  relay.handleMessage(rtpPacket(1), host);         // first RTP => host locks, client by recency
  assert.equal(endpointKey(relay.host), "127.0.0.1:5000");
  assert.equal(endpointKey(relay.client), "127.0.0.1:7000");
  assert.deepEqual(sent, ["127.0.0.1:7000"], `media must go only to the live client, got ${sent.join(",")}`);
}

{
  const cfg = config({ profile: "loss", loss: 0, latencyMs: 40, jitterMs: 0, bwKbps: 1000, bwBufferMs: 100 });
  const stats = createStats(cfg);
  const imp = new Impairer(cfg, stats);
  const originalNow = Date.now;
  try {
    Date.now = () => 1000;
    const primary = { className: CLASS_RTP, seq: 1, ssrc: 0x1111 };
    const rtx = { className: CLASS_RTP, seq: 2, ssrc: 0x2222 };
    assert.equal(imp.decide(primary, DIR_HOST_TO_CLIENT, 1250).delayMs, 50);
    const d = imp.decide(rtx, DIR_HOST_TO_CLIENT, 1250);
    assert.equal(d.drop, false);
    assert.equal(d.delayMs, 60);
    assert.equal(stats.retransmitsPassed, 1);
  } finally {
    Date.now = originalNow;
  }
}

{
  const cfg = config({ profile: "marked-burst", burstSchedule: [{ startOffsetMs: 100, durationMs: 100 }] });
  const stats = createStats(cfg);
  const imp = new Impairer(cfg, stats);
  const originalNow = Date.now;
  try {
    Date.now = () => 1000;
    assert.equal(imp.decide({ className: CLASS_RTP, seq: 1, ssrc: 0x1111 }, DIR_HOST_TO_CLIENT, 500).drop, false);
    Date.now = () => 1120;
    const d = imp.decide({ className: CLASS_RTP, seq: 2, ssrc: 0x2222 }, DIR_HOST_TO_CLIENT, 500);
    assert.equal(d.drop, true);
    assert.equal(d.reason, "marked-burst");
    assert.equal(stats.retransmitsDropped, 1);
  } finally {
    Date.now = originalNow;
  }
}

{
  // RTX retransmits arrive on their OWN ssrc, not by reusing the primary seq. They must
  // be handled as retransmissions: never dropped by the primary loss profile.
  const cfg = config({ profile: "loss", loss: 1, retxLoss: 0 });
  const imp = new Impairer(cfg, createStats(cfg));
  const primary = { className: CLASS_RTP, seq: 100, ssrc: 0xaaaa };
  const rtx = { className: CLASS_RTP, seq: 5, ssrc: 0xbbbb };
  assert.equal(imp.decide(primary, DIR_HOST_TO_CLIENT, 1000).drop, true, "primary dropped by loss=1");
  const d = imp.decide(rtx, DIR_HOST_TO_CLIENT, 1000);
  assert.equal(d.drop, false, "RTX must not be dropped by the primary loss profile");
}

{
  // RETX_LOSS drops the RTX stream and accounts it as a retransmit, not a primary drop.
  const cfg = config({ profile: "loss", loss: 0, retxLoss: 1 });
  const stats = createStats(cfg);
  const imp = new Impairer(cfg, stats);
  imp.decide({ className: CLASS_RTP, seq: 1, ssrc: 0x1111 }, DIR_HOST_TO_CLIENT, 500); // primary
  const d = imp.decide({ className: CLASS_RTP, seq: 9, ssrc: 0x2222 }, DIR_HOST_TO_CLIENT, 500); // rtx
  assert.equal(d.drop, true);
  assert.equal(d.reason, "retxLoss");
  assert.equal(stats.retransmitsDropped, 1);
  assert.equal(stats.uniqueSeqsDropped, 0, "RTX drop must not pollute the primary seq space");
}

console.log("relay.test ok");
