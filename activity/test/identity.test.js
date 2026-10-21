import assert from "node:assert/strict";
import { test } from "node:test";
import { clientIdFromHost, defaultDna, friendCode, gamertag } from "../src/identity.js";

const ID = "333333333333333333";

test("the same Discord user always gets the same starter avatar and code", () => {
  assert.deepEqual(defaultDna(ID, "Ana"), defaultDna(ID, "Ana"));
  assert.equal(friendCode(ID), friendCode(ID));
  assert.notDeepEqual(defaultDna(ID, "Ana"), defaultDna("444444444444444444", "Ana"));
});

test("starter avatars fit the C# AvatarDna rules", () => {
  for (let i = 0; i < 200; i++) {
    const dna = defaultDna(String(100000000000000000n + BigInt(i) * 7919n), "x");
    assert.equal(dna.v, 1);
    assert.equal(dna.id, "local");
    for (const key of ["skinColor", "hairColor", "shirtColor", "legsColor"]) assert.match(dna[key], /^#[0-9A-F]{6}$/);
    for (const key of ["headId", "hairId", "torsoId", "legsId", "eyeUV", "mouthUV"]) assert.ok(dna[key] >= 0 && dna[key] <= 15);
    assert.ok(JSON.stringify(dna).length <= 1024);
  }
});

test("friend codes match NetworkManager's pattern", () => {
  for (let i = 0; i < 200; i++) assert.match(friendCode(`${ID}${i}`), /^[A-HJ-NP-Z2-9]{6}$/);
});

test("gamertags are trimmed to 15 characters with a fallback", () => {
  assert.equal(gamertag("  a very long display name  "), "a very long dis");
  assert.equal(gamertag(""), "player");
  assert.equal(gamertag(null), "player");
  assert.equal(gamertag("bad\u0007name"), "badname");
});

test("only <application id>.discordsays.com counts as inside Discord", () => {
  assert.equal(clientIdFromHost("1562463240532004874.discordsays.com"), "1562463240532004874");
  assert.equal(clientIdFromHost("mexbox-activity.example.workers.dev"), null);
  assert.equal(clientIdFromHost("1562463240532004874.discordsays.com.evil.example"), null);
  assert.equal(clientIdFromHost("localhost"), null);
});
