/* 사전 — 서버에서 AI에게 낱말 뜻을 대신 물어본다. 브라우저에 키를 두지 않으려고 이 함수를 둔다.
   Gemini 키가 있으면 Gemini(무료 등급), 없고 Claude 키가 있으면 Claude를 쓴다.

   환경변수(둘 중 하나, 버셀 → Settings → Environment Variables):
     GEMINI_API_KEY      https://aistudio.google.com/apikey 에서 무료로 받는다
     ANTHROPIC_API_KEY   (또는 CLAUDE_API_KEY) Claude 콘솔, 유료 크레딧
     GEMINI_MODEL        (선택) 기본 gemini-3.5-flash-lite
   환경변수는 넣은 뒤 재배포(Redeploy)해야 반영된다.

   POST /api/dict {term, mode}   낱말 풀이 (앱의 단어 탭이 부른다)
   GET  /api/dict                부모님용 연결 확인 페이지
   GET  /api/dict?test=1         rainbow 를 실제로 찾아본다 */

import Anthropic from '@anthropic-ai/sdk';

const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash-lite';   // 무료 등급, 생각(thinking) 기본값 minimal 이라 빠르다

const MODES = {
  ek: { label: '영한', rule: '영어 단어를 한국어로 풀이한다. meaning과 exampleKo는 한국어로, example은 아주 쉬운 영어 한 문장으로 쓴다.' },
  ee: { label: '영영', rule: '영어 단어를 아주 쉬운 영어로 풀이한다. meaning과 example은 영어로, exampleKo는 그 예문의 한국어 뜻으로 쓴다.' },
  kk: { label: '한글', rule: '한국어 낱말을 한국어로 풀이한다. meaning과 example은 한국어로 쓰고, exampleKo는 빈 문자열로 둔다.' }
};

const esc = s => String(s == null ? '' : s)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 붙여넣을 때 딸려오는 앞뒤 공백·따옴표를 걷어낸다
const clean = v => String(v || '').trim().replace(/^["']|["']$/g, '');

// 정해진 이름들을 먼저 보고, 없으면 이름이 nameRe 에 맞고 값이 prefix 로 시작하는 환경변수를 쓴다
function findKey(names, nameRe, prefix) {
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
function provider() {
  const g = findKey(['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'], /GEMINI/i, 'AIza');
  if (g) return { id: 'gemini', label: 'Gemini', model: clean(process.env.GEMINI_MODEL) || GEMINI_DEFAULT_MODEL, ...g };
  const c = findKey(['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'ANTHROPIC_KEY'], /ANTHROPIC|CLAUDE/i, 'sk-ant-');
  if (c) return { id: 'claude', label: 'Claude', model: CLAUDE_MODEL, ...c };
  return null;
}

function promptFor(term, m) {
  return `너는 초등학교 1학년 아이에게 낱말을 알려주는 다정한 선생님이야.
낱말: "${term}"
사전 종류: ${m.label}. ${m.rule}

아래 JSON 하나만 출력해. 설명도 마크다운도 코드펜스도 쓰지 마.
{"term":"","reading":"","meaning":"","example":"","exampleKo":"","emoji":""}

규칙:
- meaning은 15자 안팎의 한 문장. 어려운 한자어와 전문 용어를 쓰지 마.
- reading: 영어 단어면 한글로 읽는 법(예: 레인보우), 한국어 낱말이면 빈 문자열.
- emoji: 낱말이 떠오르는 이모지 딱 한 개.
- 그런 낱말을 모르면 meaning에 "잘 모르겠어요"라고만 써.`;
}

/* ---------- Gemini (REST generateContent) ---------- */
class GeminiError extends Error {
  constructor(status, body) {
    const err = (body && body.error) || {};
    super(err.message || `HTTP ${status}`);
    this.status = status;
    // 예: API_KEY_INVALID (틀린 키), 답이 막혔을 때는 SAFETY 같은 이유
    this.reason = ((err.details || []).find(d => d && d.reason) || {}).reason || err.status || '';
  }
}
const GEMINI_BLOCKED = ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY'];

async function askGemini(p, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model)}:generateContent`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 1024 }
  });
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': p.key },
      body,
      signal: AbortSignal.timeout(15000)
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
    // 잠깐 바쁜 경우(500/503)는 한 번만 다시 해본다
    if (attempt === 0 && (r.status === 500 || r.status === 503)) {
      await new Promise(done => setTimeout(done, 600));
      continue;
    }
    throw new GeminiError(r.status, j);
  }
}

/* ---------- Claude (공식 SDK) ---------- */
async function askClaude(p, prompt) {
  const client = new Anthropic({ apiKey: p.key, maxRetries: 1, timeout: 15000 });
  const msg = await client.messages.create({
    model: p.model,
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }]
  });
  return msg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

// AI에게 묻고 앱이 쓰는 모양으로 돌려준다. 실패하면 오류를 그대로 던진다(explain()이 풀이한다).
async function lookup(p, term, mode) {
  const prompt = promptFor(term, MODES[mode] || MODES.ek);
  const text = p.id === 'gemini' ? await askGemini(p, prompt) : await askClaude(p, prompt);
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new SyntaxError('답에 JSON이 없어요');
  const out = JSON.parse(text.slice(start, end + 1));
  return {
    term: out.term || term,
    reading: out.reading || '',
    meaning: out.meaning || '',
    example: out.example || '',
    exampleKo: out.exampleKo || '',
    emoji: out.emoji || '📖'
  };
}

// 실패 이유를 아이에게 보여줄 말(kid)과 부모님 확인 페이지에 쓸 말(parent)로 바꾼다.
const KID_LATER = '지금은 사전을 쓸 수 없어요. 조금 뒤에 다시 해볼까요?';
const KID_PARENT = '지금은 사전을 쓸 수 없어요. 부모님께 말씀해 주세요.';
const BAD_KEY = { code: 'bad_key', kid: '사전 열쇠가 맞지 않아요. 부모님께 말씀해 주세요.' };
const BUSY = { code: 'busy', kid: '사전이 조금 바빠요. 잠깐 뒤에 다시 해볼까요?' };

function explain(e, p) {
  if (e instanceof GeminiError) {
    const s = e.status;
    if (e.reason === 'API_KEY_INVALID' || s === 401) return { ...BAD_KEY,
      parent: 'Gemini 키가 틀렸거나 지워졌어요. AI Studio에서 새 키를 만들어 다시 넣어주세요.' };
    if (s === 403) return { code: 'denied', kid: KID_PARENT,
      parent: '이 키로는 Gemini를 쓸 수 없어요. AI Studio에서 만든 키인지 확인해 주세요.' };
    if (s === 404) return { code: 'no_model', kid: KID_LATER,
      parent: `모델(${p.model})을 찾지 못했어요. 버셀 환경변수 GEMINI_MODEL 에 다른 모델 이름을 넣을 수 있어요.` };
    if (s === 429) return { ...BUSY,
      parent: '무료 사용량(분당·하루)을 넘었어요. 잠시 뒤나 내일 다시 해보세요.' };
    if (s === 200 && GEMINI_BLOCKED.includes(e.reason)) return { code: 'blocked',
      kid: '그 낱말은 사전에서 찾을 수 없어요.',
      parent: 'Gemini가 안전 문제로 답하지 않았어요.' };
    if (s === 200) return { code: 'bad_json', kid: '답을 알아듣지 못했어요. 다시 해볼까요?',
      parent: `Gemini의 답이 비었어요 (${e.reason}). 한 번 더 해보세요.` };
    return { code: 'upstream', kid: KID_LATER, parent: `Gemini가 오류를 돌려줬어요 (${s}): ${e.message}` };
  }
  // Claude SDK 오류 — 구체적인 것부터. APIConnectionError 는 APIError 의 하위 클래스라 먼저 본다.
  if (e instanceof Anthropic.AuthenticationError) return { ...BAD_KEY,
    parent: 'Claude 키가 틀렸거나 지워졌어요. 콘솔에서 새 키를 만들어 다시 넣어주세요.' };
  if (e instanceof Anthropic.PermissionDeniedError) return { code: 'denied', kid: KID_PARENT,
    parent: '이 키로는 Claude를 쓸 권한이 없어요. 콘솔에서 키가 속한 워크스페이스를 확인해 주세요.' };
  if (e instanceof Anthropic.NotFoundError) return { code: 'no_model', kid: KID_LATER,
    parent: `모델(${p.model})을 찾지 못했어요. 코드의 모델 이름을 바꿔야 해요.` };
  if (e instanceof Anthropic.RateLimitError) return { ...BUSY,
    parent: '너무 자주 불렀어요(요청 한도). 잠시 뒤에 다시 해보세요.' };
  if (e instanceof Anthropic.APIConnectionError) return { code: 'network',
    kid: '사전에 연결하지 못했어요. 조금 뒤에 다시 해볼까요?',
    parent: 'Claude 서버에 연결하지 못했어요. 잠시 뒤에 다시 해보세요.' };
  if (e instanceof Anthropic.APIError && (e.status === 402 || e.type === 'billing_error')) return { code: 'no_credit',
    kid: '사전 이용권이 다 됐어요. 부모님께 말씀해 주세요.',
    parent: '결제 정보나 크레딧이 없어요. Claude 콘솔의 Billing 에서 크레딧을 충전해 주세요.' };
  if (e instanceof Anthropic.APIError) return { code: 'upstream', kid: KID_LATER,
    parent: `Claude가 오류를 돌려줬어요 (${e.status || '?'}): ${e.message || ''}` };
  // Gemini fetch 가 끊기거나 시간이 넘었을 때
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError' || (e instanceof TypeError && /fetch/i.test(e.message)))) {
    return { code: 'network', kid: '사전에 연결하지 못했어요. 조금 뒤에 다시 해볼까요?',
      parent: `${p.label} 서버에 연결하지 못했어요. 잠시 뒤에 다시 해보세요.` };
  }
  if (e instanceof SyntaxError) return { code: 'bad_json', kid: '답을 알아듣지 못했어요. 다시 해볼까요?',
    parent: `${p.label}의 답을 읽지 못했어요. 한 번 더 해보세요.` };
  return { code: 'failed', kid: '지금은 사전을 쓸 수 없어요.', parent: `알 수 없는 오류: ${(e && e.message) || e}` };
}

export default async function handler(req, res) {
  if (req.method === 'GET') return setupPage(req, res);
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed', message: 'POST로 보내주세요.' });
  }
  const p = provider();
  if (!p) {
    return res.status(503).json({
      error: 'no_key',
      message: '사전이 아직 준비되지 않았어요. 부모님께 말씀해 주세요.'
    });
  }

  const { term, mode } = req.body || {};
  if (!term || typeof term !== 'string' || term.length > 40) {
    return res.status(400).json({ error: 'bad_term', message: '낱말을 다시 적어주세요.' });
  }

  try {
    const out = await lookup(p, term, mode);
    res.setHeader('cache-control', 'public, max-age=86400');
    return res.status(200).json(out);
  } catch (e) {
    const why = explain(e, p);
    console.error('dict failed', p.id, why.code, e && e.status, e && e.message);
    return res.status(why.code === 'failed' ? 500 : 502).json({ error: why.code, message: why.kid });
  }
}

/* 부모님이 휴대폰으로 열어보는 연결 확인 페이지 — 텔레그램 연결 페이지와 같은 모양.
   키가 보이는지 알려주고, ?test=1 이면 rainbow 를 실제로 찾아 결과나 실패 이유를 보여준다. 키 값은 보여주지 않는다. */
async function setupPage(req, res) {
  const p = provider();
  let test = null;
  if (p && req.query && req.query.test === '1') {
    try { test = { ok: true, r: await lookup(p, 'rainbow', 'ek') }; }
    catch (e) { test = { ok: false, why: explain(e, p) }; console.error('dict test failed', p.id, e && e.status, e && e.message); }
  }
  const step = (n, ok, title, body) => `<div class="step${ok ? ' ok' : ''}"><div class="num">${ok ? '✓' : n}</div>
    <div class="body"><h2>${esc(title)}</h2>${body}</div></div>`;

  const s1 = `<ol>
      <li><a href="https://aistudio.google.com/apikey">aistudio.google.com/apikey</a>에 구글 계정으로 로그인</li>
      <li><b>Create API key</b>(API 키 만들기)를 눌러 키를 복사 (<code>AIza</code>로 시작해요)</li>
    </ol>
    <p class="dim">결제 정보 없이 무료로 쓸 수 있어요. 무료 등급에서는 찾은 낱말이 구글 서비스 개선에 쓰일 수 있어요.</p>`;

  const s2 = p
    ? `<p class="good">키를 찾았어요 (<code>${esc(p.name)}</code>)</p>
      <p>${esc(p.label)} · <code>${esc(p.model)}</code> 로 낱말을 찾아요.</p>`
    : `<p class="bad">아직 키가 없어요.</p>
      <ol>
        <li>버셀 → 이 프로젝트 → <b>Settings → Environment Variables</b></li>
        <li>Key에 <code>GEMINI_API_KEY</code>, Value에 복사한 키를 붙여넣고 <b>Save</b></li>
        <li><b>Deployments</b> → 맨 위 배포의 <b>⋯ → Redeploy</b></li>
        <li>1~2분 뒤 이 페이지를 <b>새로고침</b></li>
      </ol>`;

  let s3;
  if (!p) {
    s3 = `<p class="dim">2단계가 끝나면 시험해 볼 수 있어요.</p>`;
  } else if (test && test.ok) {
    const r = test.r;
    s3 = `<p class="good">사전이 잘 동작해요! 🎉</p>
      <p>${esc(r.emoji)} <b>${esc(r.term)}</b>${r.reading ? ` (${esc(r.reading)})` : ''} — ${esc(r.meaning)}</p>`;
  } else if (test) {
    s3 = `<p class="bad">찾지 못했어요. ${esc(test.why.parent)}</p>
      <p><a class="btn" href="?test=1">다시 해보기</a></p>`;
  } else {
    s3 = `<p>버튼을 누르면 <b>rainbow</b>를 실제로 찾아봐요.</p>
      <p><a class="btn" href="?test=1">시험해 보기</a></p>`;
  }

  const html = `<!doctype html><html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>사전 연결</title>
<style>
  :root{--cream:#FFF9F5;--berry:#FF8FA8;--deep:#E85C7C;--mint:#9BE0C8;--mintd:#2F8F73;--cocoa:#6B4A52;--soft:#A5858D;--blush:#F3DDE2}
  body{margin:0;background:var(--cream);color:var(--cocoa);font:16px/1.6 'Apple SD Gothic Neo','Malgun Gothic',system-ui,sans-serif;padding:20px 16px 40px}
  main{max-width:560px;margin:0 auto}
  h1{font-size:24px;margin:0 0 4px} .lead{color:var(--soft);margin:0 0 20px}
  .step{display:flex;gap:14px;background:#fff;border-radius:20px;padding:16px;margin-bottom:12px;box-shadow:0 6px 18px rgba(214,150,166,.16)}
  .step.ok{background:#F1FBF6}
  .num{flex:none;width:34px;height:34px;border-radius:50%;background:var(--blush);display:grid;place-items:center;font-weight:700}
  .step.ok .num{background:var(--mint);color:#fff}
  .body{min-width:0;flex:1} h2{font-size:18px;margin:4px 0 6px}
  p{margin:6px 0} ol{margin:6px 0;padding-left:20px}
  code{background:var(--blush);border-radius:6px;padding:1px 6px;font-size:14px;word-break:break-all}
  .bad{color:var(--deep)} .good{color:var(--mintd);font-weight:700} .dim{color:var(--soft)}
  .btn{display:inline-block;background:var(--berry);color:#fff;text-decoration:none;border-radius:999px;padding:10px 18px;font-weight:700;margin:4px 6px 0 0}
  .done{background:var(--mint);color:#fff;border-radius:20px;padding:16px;text-align:center;font-weight:700;margin-bottom:12px}
  a{color:var(--deep)}
</style></head><body><main>
  <h1>사전 연결</h1>
  <p class="lead">단어 탭의 사전은 AI가 낱말 뜻을 찾아줘요. 버셀에 키 하나만 넣으면 돼요.</p>
  ${test && test.ok ? '<div class="done">사전 연결이 끝났어요! 이제 이 페이지는 닫아도 돼요.</div>' : ''}
  ${step(1, !!p, 'Gemini 무료 키 받기', s1)}
  ${step(2, !!p, '버셀에 키 넣기', s2)}
  ${step(3, !!(test && test.ok), '시험해 보기', s3)}
  <p class="dim" style="margin-top:18px">환경변수를 넣거나 바꾼 뒤에는 버셀에서 <b>Redeploy</b>를 해야 반영돼요.
    Claude를 쓰려면 <code>GEMINI_API_KEY</code> 대신 <code>ANTHROPIC_API_KEY</code>를 넣으면 돼요(유료 크레딧 필요). 둘 다 있으면 Gemini를 먼저 써요.</p>
</main></body></html>`;

  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  return res.status(200).send(html);
}
