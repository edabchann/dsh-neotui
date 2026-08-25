// side-question.mjs — /btw 侧问的独立执行器（子进程，密钥一次性使用）。
// 只在子进程内存中读取 ~/.dsh/.credentials.yaml 的 DEEPSEEK_API_KEY，
// 直调 DeepSeek API（无工具、单轮），stdout 只输出答案 JSON。
// ── 重要 ── 绝不打印/回显密钥；错误消息不包含请求头内容。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** env-style credential 文件解析（仅取键名列表，值不落日志）。 */
export function parseCredentials(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    // YAML "KEY: value" 或 env "KEY=value" 两种形态
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::|=)\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/** 侧问题请求体（系统围栏 + 会话摘要上下文 + 问题）。 */
export function buildMessages(question, context = "") {
  const system = `<system-reminder>This is a side question from the user. Answer it directly in a single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently
- You share the conversation context but are a separate instance

CRITICAL CONSTRAINTS:
- You have NO tools - you cannot read files, run commands, search, or take actions
- This is a one-off response; there will be no follow-up turns
- Answer only with what you know from the conversation context
- Never promise to take any action; if you do not know, say so

Simply answer the question with the information you have.</system-reminder>`;
  const msgs = [{ role: "system", content: system }];
  if (context) msgs.push({ role: "user", content: `对话摘要（供参考，非问题本身）：\n${context}` });
  msgs.push({ role: "user", content: question });
  return msgs;
}

/** 直调 DeepSeek 聊天补全（无工具、单轮）。fetchImpl 可注入（测试）。 */
export async function callDeepSeek(apiKey, messages, { baseUrl = "https://api.deepseek.com", model = "deepseek-chat", fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature: 0.6, max_tokens: 2048 }),
  });
  if (!res.ok) throw new Error(`API 响应 ${res.status}`);
  const data = await res.json();
  const answer = data?.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error("模型未返回内容");
  return answer;
}

// ── CLI 入口：node src/side-question.mjs --question "..." [--context "..."] [--credentials path] ──
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (name) => args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : null;
  const question = opt("--question");
  const context = opt("--context") ?? "";
  if (!question) { console.error("缺少 --question"); process.exit(1); }
  const credPath = opt("--credentials") ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".credentials.yaml");
  try {
    const creds = parseCredentials(readFileSync(credPath, "utf8"));
    const key = creds.DEEPSEEK_API_KEY;
    if (!key) { console.error("credentials 中未找到 DEEPSEEK_API_KEY"); process.exit(1); }
    const answer = await callDeepSeek(key, buildMessages(question, context));
    process.stdout.write(JSON.stringify({ ok: true, answer }));
  } catch (e) {
    // 只输出通用错误（不含密钥与请求头）
    console.error(`side-question 失败: ${e?.message ?? e}`);
    process.exit(1);
  }
}
