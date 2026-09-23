/* 사전 — Claude API를 서버에서 대신 부른다.
   브라우저에 키를 두지 않으려고 이 함수를 둔다.
   필요한 환경변수: ANTHROPIC_API_KEY  (버셀 → Settings → Environment Variables) */

const MODES = {
  ek: { label: '영한', rule: '영어 단어를 한국어로 풀이한다. meaning과 exampleKo는 한국어로, example은 아주 쉬운 영어 한 문장으로 쓴다.' },
  ee: { label: '영영', rule: '영어 단어를 아주 쉬운 영어로 풀이한다. meaning과 example은 영어로, exampleKo는 그 예문의 한국어 뜻으로 쓴다.' },
  kk: { label: '한글', rule: '한국어 낱말을 한국어로 풀이한다. meaning과 example은 한국어로 쓰고, exampleKo는 빈 문자열로 둔다.' }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed', message: 'POST로 보내주세요.' });
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(503).json({
      error: 'no_key',
      message: '사전이 아직 준비되지 않았어요. 부모님께 말씀해 주세요.'
    });
  }

  const { term, mode } = req.body || {};
  if (!term || typeof term !== 'string' || term.length > 40) {
    return res.status(400).json({ error: 'bad_term', message: '낱말을 다시 적어주세요.' });
  }
  const m = MODES[mode] || MODES.ek;

  const prompt = `너는 초등학교 1학년 아이에게 낱말을 알려주는 다정한 선생님이야.
낱말: "${term}"
사전 종류: ${m.label}. ${m.rule}

아래 JSON 하나만 출력해. 설명도 마크다운도 코드펜스도 쓰지 마.
{"term":"","reading":"","meaning":"","example":"","exampleKo":"","emoji":""}

규칙:
- meaning은 15자 안팎의 한 문장. 어려운 한자어와 전문 용어를 쓰지 마.
- reading: 영어 단어면 한글로 읽는 법(예: 레인보우), 한국어 낱말이면 빈 문자열.
- emoji: 낱말이 떠오르는 이모지 딱 한 개.
- 그런 낱말을 모르면 meaning에 "잘 모르겠어요"라고만 써.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!r.ok) {
      const detail = await r.text();
      console.error('anthropic error', r.status, detail.slice(0, 300));
      return res.status(502).json({
        error: 'upstream',
        message: r.status === 401
          ? '사전 열쇠가 맞지 않아요. 부모님께 말씀해 주세요.'
          : '지금은 사전을 쓸 수 없어요. 조금 뒤에 다시 해볼까요?'
      });
    }

    const j = await r.json();
    const text = (j.content || []).map(c => c.text || '').join('').trim();
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start < 0 || end < 0) {
      return res.status(502).json({ error: 'bad_json', message: '답을 알아듣지 못했어요. 다시 해볼까요?' });
    }

    const out = JSON.parse(text.slice(start, end + 1));
    res.setHeader('cache-control', 'public, max-age=86400');
    return res.status(200).json({
      term: out.term || term,
      reading: out.reading || '',
      meaning: out.meaning || '',
      example: out.example || '',
      exampleKo: out.exampleKo || '',
      emoji: out.emoji || '📖'
    });
  } catch (e) {
    console.error('dict failed', e);
    return res.status(500).json({ error: 'failed', message: '지금은 사전을 쓸 수 없어요.' });
  }
}
