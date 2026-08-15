import test from "node:test";
import assert from "node:assert/strict";
import { Api } from "../src/api.js";

test("Api respond and cancelResponse use the correct envelopes", async () => {
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ accepted: true }) };
  };
  try {
    const api = new Api();
    await api.respond("r1", { answer: 1 });
    await api.cancelResponse("r2");
    assert.deepEqual(bodies[0].result, { ok: true, value: { answer: 1 } });
    assert.equal(bodies[1].result.ok, false);
    assert.equal(bodies[1].result.error.code, "cancelled");
  } finally { globalThis.fetch = original; }
});

test("Api rejects a gateway receipt that was not accepted", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ accepted: false, reason: "not-pending" }) });
  try {
    await assert.rejects(() => new Api().respond("late", {}), /not-pending/);
  } finally { globalThis.fetch = original; }
});
