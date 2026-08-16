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

test("approval preserves every wrapped reason and command line", () => {
  const { app }=appHarness();app.chat.toolCommandForCall=()=>Array.from({length:20},(_,i)=>`command ${i}`).join("\n");
  const popup=new ApprovalPopup({app,frame:{rpcId:"r",sessionId:"s",approvalId:"a",callId:"c",reason:"very long ".repeat(30)}});
  const text=popup.lines.flat().map(x=>typeof x==="string"?x:x.t).join("\n");
  assert.match(text,/command 19/);assert.ok(popup.maxScroll()>0);assert.match(popup.title,/可滚动/);
});

test("approval scrolls one line with up/down without changing safe button", () => {
  const { app } = appHarness();
  app.chat.toolCommandForCall=()=>Array.from({length:20},(_,i)=>`line ${i}`).join("\n");
  const popup=new ApprovalPopup({app,frame:{rpcId:"r",sessionId:"s",approvalId:"a",callId:"c",toolName:"bash"}});
  popup.lines.push(...Array.from({length:10},(_,i)=>`extra ${i}`));
  assert.equal(popup.btnIdx,1);
  popup.onKey({type:"key",name:"down"});assert.equal(popup.scrollY,1);assert.equal(popup.btnIdx,1);
  popup.onKey({type:"key",name:"up"});assert.equal(popup.scrollY,0);assert.equal(popup.btnIdx,1);
});

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
  const screen={text(){},fillRect(){},box(){},hline(){},put(){}};popup.render(screen);
  popup.detailPage = 10;
  popup.onKey({ type: "key", name: "pagedown" });
  assert.equal(popup.detailScrollY, 10);
  popup.onKey({ type: "key", name: "end" });
  assert.equal(popup.detailScrollY, Math.max(0,popup.detailTotal-popup.detailPage));
  popup.onKey({ type: "key", name: "home" });
  assert.equal(popup.detailScrollY, 0);
  popup.onMouse({ type: "mouse", kind: "wheel-down", x: 5, y: 5 });
  assert.equal(popup.detailScrollY, 3);
});

test("long question wraps and scrolls while action rows stay visible", () => {
  const { app }=appHarness();const popup=new QuestionPopup({app,frame:{rpcId:"q",sessionId:"s",questions:[{id:"x",header:"Long",question:"问题内容 ".repeat(80),options:[{label:"A",description:"描述 ".repeat(50)},{label:"B"}]}]}});
  const drawn=[];const screen={text(x,y,t){drawn.push({x,y,t});},fillRect(){},box(){},hline(){},put(){}};popup.render(screen);
  assert.ok(popup.detailTotal>popup.detailPage);assert.ok(drawn.some(x=>String(x.t).includes("输入自己的回答")));assert.ok(drawn.some(x=>String(x.t).includes("跳过此问题")));
  const before=popup.detailScrollY;popup.onMouse({type:"mouse",kind:"wheel-down",x:popup.x+2,y:popup.y+2});assert.equal(popup.detailScrollY,before+3);
});

test("question mouse only activates the rendered option text hitbox", async () => {
  const { app, calls } = appHarness();
  const popup = new QuestionPopup({ app, frame: { rpcId: "q", sessionId: "s", questions: [{ id: "x", question: "Choose", options: [{ label: "A" }, { label: "B" }] }] } });
  const fakeScreen={text(){},fillRect(){},box(){},hline(){},put(){}};
  popup.render(fakeScreen);
  const box=popup.optionHitboxes[0];
  popup.onMouse({type:"mouse",kind:"press",button:0,x:popup.x+popup.w-3,y:box.y1});
  await Promise.resolve();
  assert.equal(calls.length,0,"blank highlighted row area must not submit");
  popup.onMouse({type:"mouse",kind:"press",button:0,x:box.x1,y:box.y1});
  await Promise.resolve();
  assert.equal(calls[0][0],"respond");
});

test("question skip is a real list item and submits a skipped answer", async () => {
  const { app, calls } = appHarness();
  const popup = new QuestionPopup({ app, frame: { rpcId: "q", sessionId: "s", questions: [{ id: "x", question: "Choose", options: [{ label: "A" }, { label: "B" }] }] } });
  popup.onKey({ type: "key", name: "down" });popup.onKey({ type: "key", name: "down" });popup.onKey({ type: "key", name: "down" });
  assert.equal(popup.selIdx,3);
  popup.onKey({type:"key",name:"enter"});await Promise.resolve();
  assert.deepEqual(calls[0][2].answer.answers[0],{id:"x",selected:[]});
});

test("custom editor input row is always directly below its option", () => {
  const { app } = appHarness();
  const popup = new QuestionPopup({ app, frame: { rpcId: "q", sessionId: "s", questions: [{ id: "x", question: "Choose", options: [{ label: "A" }] }] } });
  const drawn=[];const screen={text(x,y,t){drawn.push({x,y,t});},fillRect(){},box(){},hline(){},put(){}};
  popup.render(screen);
  const custom=drawn.find(x=>String(x.t).includes("输入自己的回答"));
  const input=drawn.find(x=>String(x.t).includes("在此输入"));
  const skip=drawn.find(x=>String(x.t).includes("跳过此问题"));
  assert.equal(input.y,custom.y+1);assert.equal(skip.y,input.y+1);
});

test("custom editor reserves left/right for cursor movement", async () => {
  const { app, calls } = appHarness();
  const popup = new QuestionPopup({ app, frame: { rpcId: "q", sessionId: "s", questions: [{ id: "x", question: "Choose", options: [{ label: "A" }] }] } });
  popup.onKey({type:"key",name:"down"});popup.onKey({type:"key",name:"enter"});
  popup.onKey({type:"text",text:"ac"});popup.onKey({type:"key",name:"left"});popup.onKey({type:"text",text:"b"});
  assert.equal(popup.drafts[0].custom,"abc");
  popup.onKey({type:"key",name:"enter"});await Promise.resolve();assert.equal(calls[0][2].answer.answers[0].custom,"abc");
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
