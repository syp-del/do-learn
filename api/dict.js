/* 사전 — 서버에서 AI에게 낱말 뜻을 대신 물어본다. 브라우저에 키를 두지 않으려고 이 함수를 둔다.
   Gemini 키가 있으면 Gemini(무료 등급), 없고 Claude 키가 있으면 Claude를 쓴다.

   환경변수(둘 중 하나, 버셀 → Settings → Environment Variables):
     GEMINI_API_KEY      https://aistudio.google.com/apikey 에서 무료로 받는다
     ANTHROPIC_API_KEY   (또는 CLAUDE_API_KEY) Claude 콘솔, 유료 크레딧
     GEMINI_MODEL        (선택) 기본 gemini-3.5-flash-lite
   환경변수는 넣은 뒤 재배포(Redeploy)해야 반영된다.

   POST /api/dict {term, mode}   낱말 풀이 (앱의 단어장 탭이 부른다) — mode: en 영어(한국어 뜻 + 쉬운 영어 풀이) · kk 한글 (ek·ee 도 받는다)
   GET  /api/dict                부모님용 연결 확인 페이지
   GET  /api/dict?test=1         rainbow 를 실제로 찾아본다 */

import { esc, provider, askGemini, askClaude, parseJson, explain } from './_ai.js';

const MODES = {
  en: { label: '영어', rule: '영어 단어를 풀이한다. meaning은 한국어 뜻, meaningEn은 아주 쉬운 영어 풀이 한 문장, example은 아주 쉬운 영어 한 문장, exampleKo는 그 예문의 한국어 뜻으로 쓴다.' },
  ek: { label: '영한', rule: '영어 단어를 한국어로 풀이한다. meaning과 exampleKo는 한국어로, example은 아주 쉬운 영어 한 문장으로 쓴다.' },
  ee: { label: '영영', rule: '영어 단어를 아주 쉬운 영어로 풀이한다. meaning과 example은 영어로, exampleKo는 그 예문의 한국어 뜻으로 쓴다.' },
  kk: { label: '한글', rule: '한국어 낱말을 한국어로 풀이한다. meaning과 example은 한국어로 쓰고, exampleKo는 빈 문자열로 둔다.' }
};

function promptFor(term, m) {
  return `너는 초등학교 1학년 아이에게 낱말을 알려주는 다정한 선생님이야.
낱말: "${term}"
사전 종류: ${m.label}. ${m.rule}

아래 JSON 하나만 출력해. 설명도 마크다운도 코드펜스도 쓰지 마.
${m === MODES.en ? '{"term":"","reading":"","meaning":"","meaningEn":"","example":"","exampleKo":"","emoji":""}' : '{"term":"","reading":"","meaning":"","example":"","exampleKo":"","emoji":""}'}

규칙:
- meaning은 15자 안팎의 한 문장. 어려운 한자어와 전문 용어를 쓰지 마.
- reading: 영어 단어면 한글로 읽는 법(예: 레인보우), 한국어 낱말이면 빈 문자열.
- emoji: 낱말이 떠오르는 이모지 딱 한 개.
- 그런 낱말을 모르면 meaning에 "잘 모르겠어요"라고만 써.`;
}

// AI에게 묻고 앱이 쓰는 모양으로 돌려준다. 실패하면 오류를 그대로 던진다(explain()이 풀이한다).
async function lookup(p, term, mode) {
  const prompt = promptFor(term, MODES[mode] || MODES.ek);
  const text = p.id === 'gemini' ? await askGemini(p, prompt) : await askClaude(p, prompt);
  const out = parseJson(text);
  return {
    term: out.term || term,
    reading: out.reading || '',
    meaning: out.meaning || '',
    example: out.example || '',
    exampleKo: out.exampleKo || '',
    ...(out.meaningEn ? { meaningEn: out.meaningEn } : {}),
    emoji: out.emoji || '📖'
  };
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
