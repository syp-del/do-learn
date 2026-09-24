/* AI 공통 — 사전(dict.js)과 뚜뚜(coach.js)이 같이 쓴다.
   파일 이름이 _ 로 시작해서 버셀이 주소(/api/_ai)로 열지 않는다. import 로만 쓴다.

   Gemini 키가 있으면 Gemini(무료 등급), 없고 Claude 키가 있으면 Claude를 쓴다.
     GEMINI_API_KEY      https://aistudio.google.com/apikey 에서 무료로 받는다
     ANTHROPIC_API_KEY   (또는 CLAUDE_API_KEY) Claude 콘솔, 유료 크레딧
     GEMINI_MODEL        (선택) 기본 gemini-3.5-flash-lite
   녹음을 듣는 일(뚜뚜의 발음 피드백)은 Gemini만 할 수 있다. */

import Anthropic from '@anthropic-ai/sdk';

export const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
export const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash-lite';   // 무료 등급, 생각(thinking) 기본값 minimal 이라 빠르다

export const esc = s => String(s == null ? '' : s)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 붙여넣을 때 딸려오는 앞뒤 공백·따옴표를 걷어낸다
export const clean = v => String(v || '').trim().replace(/^["']|["']$/g, '');

// 정해진 이름들을 먼저 보고, 없으면 이름이 nameRe 에 맞고 값이 prefix 로 시작하는 환경변수를 쓴다
export function findKey(names, nameRe, prefix) {
  for (const name of names) {
    const key = clean(process.env[name]);
    if (key) return { key, name };
  }
  for (const [name, value] of Object.entries(process.env)) {
    const key = clean(value);
    if (nameRe.test(name) && key.startsWith(prefix)) return { key, name };
  }
  return null;
}

// 쓸 AI를 고른다. Gemini(무료)를 먼저 본다. 둘 다 없으면 null.
// audio:true 면 녹음을 들을 수 있는 Gemini만 고른다.
export function provider({ audio = false } = {}) {
  const g = findKey(['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'], /GEMINI/i, 'AIza');
  if (g) return { id: 'gemini', label: 'Gemini', model: clean(process.env.GEMINI_MODEL) || GEMINI_DEFAULT_MODEL, ...g };
  if (audio) return null;
  const c = findKey(['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'ANTHROPIC_KEY'], /ANTHROPIC|CLAUDE/i, 'sk-ant-');
  if (c) return { id: 'claude', label: 'Claude', model: CLAUDE_MODEL, ...c };
  return null;
}

/* ---------- Gemini (REST generateContent) ---------- */
export class GeminiError extends Error {
  constructor(status, body) {
    const err = (body && body.error) || {};
    super(err.message || `HTTP ${status}`);
    this.status = status;
    // 예: API_KEY_INVALID (틀린 키), 답이 막혔을 때는 SAFETY 같은 이유
    this.reason = ((err.details || []).find(d => d && d.reason) || {}).reason || err.status || '';
  }
}
export const GEMINI_BLOCKED = ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY'];

/* input 이 글자면 예전(사전) 그대로 묻는다.
   객체면 { system, parts:[{text}|{inlineData:{mimeType,data}}], schema, maxTokens, timeoutMs } */
export async function askGemini(p, input) {
  const rich = typeof input === 'object' && input !== null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model)}:generateContent`;
  const req = rich
    ? {
        ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
        contents: [{ role: 'user', parts: input.parts }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: input.maxTokens || 2048,
          ...(input.schema ? { responseSchema: input.schema } : {}),
          ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {})
        }
      }
    : {
        contents: [{ parts: [{ text: input }] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 1024 }
      };
  const body = JSON.stringify(req);
  const timeout = (rich && input.timeoutMs) || 15000;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': p.key },
      body,
      signal: AbortSignal.timeout(timeout)
    });
    const j = await r.json().catch(() => null);
    if (r.ok) {
      const cand = (j && j.candidates && j.candidates[0]) || null;
      const parts = (cand && cand.content && cand.content.parts) || [];
      const text = parts.filter(x => !x.thought).map(x => x.text || '').join('').trim();
      if (!text) {
        const why = (j && j.promptFeedback && j.promptFeedback.blockReason) || (cand && cand.finishReason) || 'EMPTY';
        throw new GeminiError(200, { error: { message: `답이 비었어요 (${why})`, status: why } });
      }
      return text;
    }
    // 잠깐 바쁜 경우(500/503)는 한 번만 다시 해본다 (여러 모델을 번갈아 쓸 때는 바로 다음 모델로)
    if (attempt === 0 && (r.status === 500 || r.status === 503) && !(rich && input.noRetry)) {
      await new Promise(done => setTimeout(done, 600));
      continue;
    }
    throw new GeminiError(r.status, j);
  }
}

/* ---------- 모델이 붐빌 때 — 다른 모델로 넘어가기 ----------
   무료 등급은 "high demand"(503)나 시간 초과가 잦다. 이 키로 쓸 수 있는 모델 목록을 한 시간에 한 번 받아 와서,
   정해 둔 모델 → 같은 계열의 다른 flash 모델 순으로 번갈아 부른다. */
let modelList = null, modelAt = 0;
export async function geminiModels(p) {
  if (modelList && Date.now() - modelAt < 3600e3) return modelList;
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      headers: { 'x-goog-api-key': p.key }, signal: AbortSignal.timeout(6000)
    });
    const j = await r.json();
    modelList = (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => String(m.name || '').replace(/^models\//, ''))
      .filter(n => /^gemini-\d/.test(n) && !/tts|image|embed|live|native|robotics|computer|exp|learnlm|aqa/i.test(n));
    modelAt = Date.now();
  } catch (e) { modelList = modelList || []; }
  return modelList;
}
const ver = n => { const m = String(n).match(/gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
export async function geminiChain(p, max = 5) {
  const list = (await geminiModels(p)).filter(n => /flash/.test(n));
  const stable = list.filter(n => !/preview/.test(n)).sort((a, b) => ver(b) - ver(a) || (/lite/.test(a) ? 1 : -1));
  const preview = list.filter(n => /preview/.test(n)).sort((a, b) => ver(b) - ver(a));
  // 최신 모델이 몰릴 때는 한 세대 전 모델이 비어 있는 경우가 많아서, 정해 둔 모델 다음에 먼저 넣는다
  const older = stable.filter(n => ver(n) < 3), newer = stable.filter(n => ver(n) >= 3);
  return [...new Set([p.model, ...older.slice(0, 2), ...newer, ...preview])].slice(0, max);
}
// 번갈아 묻기 — 붐빔(500·503)·한도(429)·모델 없음(404)·시간 초과면 다음 모델로. 모델마다 12초, 전체 50초 안에서.
export async function askGeminiAny(p, input) {
  const chain = await geminiChain(p, 5), t0 = Date.now();
  let last = null;
  for (const model of chain) {
    const left = 50000 - (Date.now() - t0);
    if (left < 5000) break;
    try {
      const text = await askGemini({ ...p, model }, { ...input, noRetry: true, timeoutMs: Math.min(input.timeoutMs || 12000, left) });
      return { text, model };
    } catch (e) {
      last = e;
      console.warn('gemini busy, next model', model, (e && e.status) || (e && e.name));
      const busy = e instanceof GeminiError ? [404, 429, 500, 503].includes(e.status)
        : (e && (e.name === 'TimeoutError' || e.name === 'AbortError' || e instanceof TypeError));
      if (!busy) throw e;
    }
  }
  throw last || new Error('no model');
}

/* ---------- Claude (공식 SDK) — 글만 다룬다 ----------
   input 이 글자면 예전(사전) 그대로, 객체면 { system, text, maxTokens, timeoutMs } */
export async function askClaude(p, input) {
  const rich = typeof input === 'object' && input !== null;
  const client = new Anthropic({ apiKey: p.key, maxRetries: 1, timeout: (rich && input.timeoutMs) || 15000 });
  const msg = await client.messages.create({
    model: p.model,
    max_tokens: rich ? (input.maxTokens || 1024) : 400,
    ...(rich && input.system ? { system: input.system } : {}),
    messages: [{ role: 'user', content: rich ? input.text : input }]
  });
  return msg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

// 답에서 JSON 한 덩어리를 꺼낸다. 없으면 SyntaxError (explain()이 bad_json 으로 풀이한다)
export function parseJson(text) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new SyntaxError('답에 JSON이 없어요');
  return JSON.parse(text.slice(start, end + 1));
}

/* 실패 이유를 아이에게 보여줄 말(kid)과 부모님 확인 페이지에 쓸 말(parent)로 바꾼다.
   kid 는 부르는 쪽이 고른다 — 사전은 "사전이 조금 바빠요", 뚜뚜는 "뚜뚜가 잠깐 쉬고 있어요" */
export const KID_DICT = {
  bad_key: '사전 열쇠가 맞지 않아요. 부모님께 말씀해 주세요.',
  denied: '지금은 사전을 쓸 수 없어요. 부모님께 말씀해 주세요.',
  no_model: '지금은 사전을 쓸 수 없어요. 조금 뒤에 다시 해볼까요?',
  busy: '사전이 조금 바빠요. 잠깐 뒤에 다시 해볼까요?',
  blocked: '그 낱말은 사전에서 찾을 수 없어요.',
  bad_json: '답을 알아듣지 못했어요. 다시 해볼까요?',
  upstream: '지금은 사전을 쓸 수 없어요. 조금 뒤에 다시 해볼까요?',
  network: '사전에 연결하지 못했어요. 조금 뒤에 다시 해볼까요?',
  no_credit: '사전 이용권이 다 됐어요. 부모님께 말씀해 주세요.',
  failed: '지금은 사전을 쓸 수 없어요.'
};

export function explain(e, p, kidWords = KID_DICT) {
  const out = (code, parent) => ({ code, kid: kidWords[code] || kidWords.failed, parent });
  if (e instanceof GeminiError) {
    const s = e.status;
    if (e.reason === 'API_KEY_INVALID' || s === 401)
      return out('bad_key', 'Gemini 키가 틀렸거나 지워졌어요. AI Studio에서 새 키를 만들어 다시 넣어주세요.');
    if (s === 403) return out('denied', '이 키로는 Gemini를 쓸 수 없어요. AI Studio에서 만든 키인지 확인해 주세요.');
    if (s === 404) return out('no_model', `모델(${p.model})을 찾지 못했어요. 버셀 환경변수 GEMINI_MODEL 에 다른 모델 이름을 넣을 수 있어요.`);
    if (s === 429) return out('busy', '무료 사용량(분당·하루)을 넘었어요. 잠시 뒤나 내일 다시 해보세요.');
    if (s === 200 && GEMINI_BLOCKED.includes(e.reason)) return out('blocked', 'Gemini가 안전 문제로 답하지 않았어요.');
    if (s === 200) return out('bad_json', `Gemini의 답이 비었어요 (${e.reason}). 한 번 더 해보세요.`);
    return out('upstream', `Gemini가 오류를 돌려줬어요 (${s}): ${e.message}`);
  }
  // Claude SDK 오류 — 구체적인 것부터. APIConnectionError 는 APIError 의 하위 클래스라 먼저 본다.
  if (e instanceof Anthropic.AuthenticationError)
    return out('bad_key', 'Claude 키가 틀렸거나 지워졌어요. 콘솔에서 새 키를 만들어 다시 넣어주세요.');
  if (e instanceof Anthropic.PermissionDeniedError)
    return out('denied', '이 키로는 Claude를 쓸 권한이 없어요. 콘솔에서 키가 속한 워크스페이스를 확인해 주세요.');
  if (e instanceof Anthropic.NotFoundError) return out('no_model', `모델(${p.model})을 찾지 못했어요. 코드의 모델 이름을 바꿔야 해요.`);
  if (e instanceof Anthropic.RateLimitError) return out('busy', '너무 자주 불렀어요(요청 한도). 잠시 뒤에 다시 해보세요.');
  if (e instanceof Anthropic.APIConnectionError) return out('network', 'Claude 서버에 연결하지 못했어요. 잠시 뒤에 다시 해보세요.');
  if (e instanceof Anthropic.APIError && (e.status === 402 || e.type === 'billing_error'))
    return out('no_credit', '결제 정보나 크레딧이 없어요. Claude 콘솔의 Billing 에서 크레딧을 충전해 주세요.');
  if (e instanceof Anthropic.APIError) return out('upstream', `Claude가 오류를 돌려줬어요 (${e.status || '?'}): ${e.message || ''}`);
  // Gemini fetch 가 끊기거나 시간이 넘었을 때
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError' || (e instanceof TypeError && /fetch/i.test(e.message)))) {
    return out('network', `${p.label} 서버에 연결하지 못했어요. 잠시 뒤에 다시 해보세요.`);
  }
  if (e instanceof SyntaxError) return out('bad_json', `${p.label}의 답을 읽지 못했어요. 한 번 더 해보세요.`);
  return out('failed', `알 수 없는 오류: ${(e && e.message) || e}`);
}
