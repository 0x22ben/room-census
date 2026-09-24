// Reading a public room: what the page keeps of a message, and what it asks Technocore for.
import assert from "node:assert/strict";
import { test } from "node:test";

import { FIRST, readRoom, shortFrom, shortTime, WAIT } from "../src/lib/room-feed.mjs";

const reply = (messages) => JSON.stringify({ room: "dev", count: messages.length, messages });
const answer = (body, status = 200) => async () => ({ ok: status < 400, status, text: async () => body });

test("the first read asks for the last messages, and the next ones wait for what comes after", async () => {
  const asked = [];
  const fetcher = async (url, options) => { asked.push({ url, options }); return { ok: true, status: 200, text: async () => reply([]) }; };
  await readRoom("dev", { fetcher });
  await readRoom("dev", { since: 41, wait: WAIT, fetcher });
  assert.equal(asked[0].url, `https://technocore.chat/r/dev?format=json&limit=${FIRST}`);
  assert.equal(asked[1].url, `https://technocore.chat/r/dev?format=json&since=41&wait=${WAIT}`);
  // nothing about the reader travels with the request
  for (const { options } of asked) {
    assert.equal(options.credentials, "omit");
    assert.equal(options.referrerPolicy, "no-referrer");
    assert.equal(options.redirect, "error", "a redirect would send the request somewhere else");
    assert.equal(options.cache, "no-store");
  }
});

test("a room name that could change the address is escaped", async () => {
  const asked = [];
  await readRoom("../kv/secret", { fetcher: async (url) => { asked.push(url); return { ok: true, status: 200, text: async () => reply([]) }; } });
  assert.equal(asked[0], "https://technocore.chat/r/..%2Fkv%2Fsecret?format=json&limit=50");
});

test("a message is reduced to what the page shows, and nothing is trusted", async () => {
  const { messages, last } = await readRoom("dev", { fetcher: answer(reply([
    { seq: 7, from: "did:key:z6MkTest", nick: "<script>", ts: "2026-09-24T09:00:00Z", nonce: 12, text: "<b>hello</b>", sig: "abc" },
    { seq: 8, from: 42, text: { not: "a string" }, extra: "dropped" },
    { seq: "no", text: "ignored" },
    { text: "no seq either" },
  ])) });
  assert.equal(messages.length, 2, "a message without a usable seq is dropped");
  assert.deepEqual(messages[0], { seq: 7, from: "did:key:z6MkTest", nick: "<script>", ts: "2026-09-24T09:00:00Z", nonce: "12", text: "<b>hello</b>", sig: "abc" });
  // the signature is carried as it was given: the page decides nothing from it until it checks it
  assert.equal(messages[1].sig, "", "a message with no signature carries none");
  assert.equal(messages[1].from, "42");
  assert.equal(typeof messages[1].text, "string");
  assert.equal(Object.keys(messages[0]).sort().join(), "from,nick,nonce,seq,sig,text,ts");
  assert.equal(last, 8);
  // a very long message cannot grow the page without limit
  const long = await readRoom("dev", { fetcher: answer(reply([{ seq: 1, text: "x".repeat(9000) }])) });
  assert.equal(long.messages[0].text.length, 4096);
});

test("a room that answers with an error is a failure, not an empty room", async () => {
  await assert.rejects(readRoom("dev", { fetcher: answer("nope", 500) }));
  await assert.rejects(readRoom("dev", { fetcher: answer("not json") }));
});

test("a signature that is only long is still only a claim", async () => {
  const { messages } = await readRoom("dev", { fetcher: answer(reply([{ seq: 1, from: "did:key:z6MkAnyone", text: "trust me", sig: "x".repeat(500) }])) });
  assert.equal(messages[0].sig.length, 200, "a signature is carried, cut to a size a page can handle");
  assert.equal(typeof messages[0].sig, "string");
});

test("a sender is shown short, and never under a name the page invents", () => {
  assert.equal(shortFrom("did:key:z6MkehRgf7yJbgaGfYsdoAsKdBPE3dj2CYhowQdcjqSJgvVd", ""), "z6Mke…gvVd");
  // a name the room carries can claim anything, so a DID is always shown as itself
  assert.equal(shortFrom("did:key:z6MkehRgf7yJbgaGfYsdoAsKdBPE3dj2CYhowQdcjqSJgvVd", "Room Census"), "z6Mke…gvVd");
  assert.equal(shortFrom("", "ben"), "ben", "a sender with no DID is shown under the name the room carries");
  assert.equal(shortFrom("", ""), "anonymous");
  assert.equal(shortTime("not a date"), "");
  assert.match(shortTime("2026-09-24T09:00:00Z"), /^\d{2}:\d{2}$/);
});
