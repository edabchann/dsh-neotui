import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalPopup, QuestionPopup } from "../src/views.js";

function appHarness() {
  const calls = [];
  const app = {
    screen: { w: 80, h: 24 },
    chat: { toolCommandForCall: () => "rm -rf ./build" },
    api: {
      respond: async (...args) => { calls.push(["respond", ...args]); },
      cancelResponse: async (...args) => { calls.push(["cancel", ...args]); },
    },
    closePopup() { this.closed = true; },
    finishPrompt() { this.closed = true; },
    toast() {}, redraw() {},
  };
  return { app, calls };
}

test("approval shows command and Y submits allowed-once", async () => {
  const { app, calls } = appHarness();
  const popup = new ApprovalPopup({ app, frame: { rpcId: "r", sessionId: "s", approvalId: "a", callId: "c", toolName: "bash" } });
  assert.match(popup.lines.flat().map((x) => typeof x === "string" ? x : x.t).join(" "), /rm -rf/);
  popup.onKey({ type: "key", name: "char", key: "y", ctrl: false, alt: false });
  await Promise.resolve();
  assert.equal(calls[0][0], "respond");
  assert.equal(calls[0][2].outcome, "allowed-once");
});

test("question Escape sends a real cancellation envelope", async () => {
  const { app, calls } = appHarness();
  const popup = new QuestionPopup({ app, frame: { rpcId: "q", sessionId: "s", questions: [{ id: "x", question: "Choose", options: [{ label: "A" }] }] } });
  popup.onKey({ type: "key", name: "escape" });
  await Promise.resolve();
  assert.deepEqual(calls[0], ["cancel", "q"]);
});

test("plan review gets a dedicated surface and explicit approve action", async () => {
  const { app, calls } = appHarness();
  const popup = new QuestionPopup({ app, frame: { rpcId: "plan", sessionId: "s", questions: [{ id: "plan-review", header: "Review", question: "Approve?", detail: "# Plan\n- one\n- two", intent: { kind: "plan-review", approve: "Approve" }, options: [{ label: "Approve" }, { label: "Keep planning" }] }] } });
  assert.equal(popup.planReview, true);
  assert.equal(popup.title, "✎ 计划审阅");
  popup.onKey({ type: "key", name: "enter" });
  await Promise.resolve();
  assert.deepEqual(calls[0][2].answer.answers[0].selected, ["Approve"]);
});

test("long plan review scrolls with PgDn/Home/End and wheel", () => {
  const { app } = appHarness();
  const detail = Array.from({ length: 80 }, (_, i) => `step ${i + 1}`).join("\n");
  const popup = new QuestionPopup({ app, frame: { rpcId: "plan", sessionId: "s", questions: [{ id: "plan-review", question: "Approve?", detail, intent: { kind: "plan-review", approve: "Approve" }, options: [{ label: "Approve" }, { label: "Keep planning" }] }] } });
  popup.detailPage = 10;
  popup.onKey({ type: "key", name: "pagedown" });
  assert.equal(popup.detailScrollY, 10);
  popup.onKey({ type: "key", name: "end" });
  assert.equal(popup.detailScrollY, 70);
  popup.onKey({ type: "key", name: "home" });
  assert.equal(popup.detailScrollY, 0);
  popup.onMouse({ type: "mouse", kind: "wheel-down", x: 5, y: 5 });
  assert.equal(popup.detailScrollY, 3);
});

test("question offers a third custom-answer row and submits typed text", async () => {
  const { app, calls } = appHarness();
  const popup = new QuestionPopup({ app, frame: { rpcId: "q", sessionId: "s", questions: [{ id: "x", question: "Choose", options: [{ label: "A" }, { label: "B" }] }] } });
  popup.onKey({ type: "key", name: "down" });
  popup.onKey({ type: "key", name: "down" });
  assert.equal(popup.selIdx, 2);
  popup.onKey({ type: "key", name: "enter" });
  assert.equal(popup.customEditing, true);
  popup.onKey({ type: "text", text: "my answer" });
  popup.onKey({ type: "key", name: "enter" });
  await Promise.resolve();
  assert.deepEqual(calls[0][2].answer.answers[0], { id: "x", selected: [], custom: "my answer" });
});

test("multi-select toggles independent options before submit", async () => {
  const { app, calls } = appHarness();
  const popup = new QuestionPopup({ app, frame: { rpcId: "q", sessionId: "s", questions: [{ id: "x", question: "Choose", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }] } });
  popup.onKey({ type: "key", name: "char", key: " ", text: " ", ctrl: false });
  popup.onKey({ type: "key", name: "down" });
  popup.onKey({ type: "key", name: "char", key: " ", text: " ", ctrl: false });
  popup.onKey({ type: "key", name: "enter" });
  await Promise.resolve();
  assert.deepEqual(calls[0][2].answer.answers[0].selected, ["A", "B"]);
});
