/* 🦜 뚜뚜 — 영어 스피치 선생님. 앱의 "뚜뚜 스피치 교실"이 부른다.
   브라우저에 AI 키를 두지 않으려고 서버에서 대신 묻는다(공통 코드는 _ai.js).

   POST /api/coach   헤더 x-family-id: <가족 UUID>   (실제로 있는 가족만 받는다)
     {task:'prep',   sentences:[...]}                         원고 문장마다 한국어 뜻·그림 힌트·강세·끝 억양·어려운 단어
     {task:'speech', sentence, audio(base64), mime, stage, …}  아이 녹음을 듣고 발음·유창성·높낮이 피드백 (Gemini만)
     {task:'tts',    text, voice, style}                      뚜뚜의 자연스러운 목소리 (Gemini 음성 합성)
   GET  /api/coach   연결 상태 (키 값은 보여주지 않는다)

   녹음은 기기에만 저장되고, 여기로는 분석할 몇 초짜리만 온다. 아이 이름은 보내지 않는다. */

import { provider, askGeminiAny, askClaude, parseJson, explain, GeminiError, clean, geminiModels } from './_ai.js';

// 앱(index.html)과 같은 공개용 키 — 가족이 실제로 있는지만 확인한다
const SB_URL = 'https://xirclohwurvtschwrtxw.supabase.co';
const SB_KEY = 'sb_publishable_97VPBM0syPSyG2r1S6ScMg_azkVXgdN';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KID_TT = {
  no_key: '뚜뚜 귀가 아직 준비되지 않았어요. 부모님께 말씀해 주세요.',
  bad_key: '뚜뚜가 지금은 들을 수 없어요. 부모님께 말씀해 주세요.',
  denied: '뚜뚜가 지금은 들을 수 없어요. 부모님께 말씀해 주세요.',
  no_model: '뚜뚜가 잠깐 자리를 비웠어요. 조금 뒤에 다시 해볼까?',
  busy: '뚜뚜가 잠깐 쉬고 있어요. 조금 뒤에 다시 들어줄게!',
  blocked: '뚜뚜가 잘 못 알아들었어요. 다시 말해볼까?',
  bad_json: '뚜뚜가 잘 못 알아들었어요. 다시 말해볼까?',
  upstream: '뚜뚜가 잠깐 자리를 비웠어요. 조금 뒤에 다시 해볼까?',
  network: '뚜뚜랑 연결이 끊겼어요. 인터넷을 확인해 볼까?',
  no_credit: '뚜뚜가 지금은 들을 수 없어요. 부모님께 말씀해 주세요.',
  failed: '뚜뚜가 잠깐 자리를 비웠어요.'
};

/* ---------- 가족 확인 (10분 기억) ---------- */
const known = new Map();
async function familyOk(id) {
  if (!UUID.test(id || '')) return false;
  const until = known.get(id);
  if (until && until > Date.now()) return true;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/settings?select=family_id&family_id=eq.${id}`, {
      headers: { apikey: SB_KEY, 'x-family-id': id },
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) return r.status >= 500;              // 수파베이스가 잠깐 아프면 연습은 막지 않는다
    const rows = await r.json().catch(() => []);
    const ok = Array.isArray(rows) && rows.length > 0;
    if (ok) known.set(id, Date.now() + 10 * 60000);
    return ok;
  } catch (e) {
    return true;                                    // 네트워크 문제도 연습은 막지 않는다
  }
}

/* ---------- 글자 다듬기 ---------- */
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const arr = (v, max) => (Array.isArray(v) ? v : []).slice(0, max);
const lvl = v => { const n = Number(v); return (v == null || v === '' || !Number.isFinite(n)) ? 2 : Math.max(1, Math.min(3, Math.round(n))); };

/* ============================================================
   prep — 원고 준비
   ============================================================ */
const PREP_SYSTEM = `너는 한국 초등학교 1학년(7살) 아이의 영어 스피치 대회 원고를 준비해 주는 다정한 선생님이야.
원고는 이미 문장으로 나뉘어 있어. 문장을 고치거나 합치거나 빼지 말고, 문장마다 아래를 만들어.
- ko: 아이가 이해하기 쉬운 자연스러운 한국어 뜻. 35자 안팎. 어려운 한자어를 피하고 "~해요"체로.
- cue: 이 문장이 떠오르는 이모지 1~2개 (외울 때 그림 힌트로 쓴다).
- stress: 힘주어 말하면 좋은 단어 1~3개. 원문에 있는 철자 그대로.
- end: 문장 끝을 내려 말하면 "fall", 올려 말하면 "rise". 보통 평서문·감탄문은 fall, 예/아니오 질문은 rise.
- tricky: 한국 아이가 발음하기 어려운 단어 최대 2개와 tipKo(25자 이내). 입 모양·혀 위치처럼 따라 할 수 있게 쓰고, 영어 발음을 한글로 적지 마.
i 는 받은 문장 번호를 그대로 써.`;

const PREP_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          i: { type: 'INTEGER' },
          ko: { type: 'STRING' },
          cue: { type: 'STRING' },
          stress: { type: 'ARRAY', items: { type: 'STRING' } },
          end: { type: 'STRING' },
          tricky: {
            type: 'ARRAY',
            items: { type: 'OBJECT', properties: { word: { type: 'STRING' }, tipKo: { type: 'STRING' } }, required: ['word', 'tipKo'] }
          }
        },
        required: ['i', 'ko', 'cue', 'stress', 'end', 'tricky']
      }
    }
  },
  required: ['items']
};

async function prep(p, body) {
  const sentences = arr(body.sentences, 80).map(s => str(s, 400)).filter(Boolean);
  if (!sentences.length) return { status: 400, json: { error: 'bad_input', message: '원고 문장이 없어요.' } };
  const list = sentences.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const user = `원고 문장:\n${list}\n\n문장 ${sentences.length}개 모두에 대해 JSON으로 답해.`;
  let model = p.model;
  const text = p.id === 'gemini'
    ? await askGeminiAny(p, { system: PREP_SYSTEM, parts: [{ text: user }], schema: PREP_SCHEMA, maxTokens: 6144, timeoutMs: 14000, temperature: 0.4 })
        .then(r => { model = r.model; return r.text; })
    : await askClaude(p, { system: PREP_SYSTEM, maxTokens: 4096, timeoutMs: 25000,
        text: `${user}\n아래 모양의 JSON 하나만 출력해. 설명도 코드펜스도 쓰지 마.\n{"items":[{"i":1,"ko":"","cue":"","stress":[""],"end":"fall","tricky":[{"word":"","tipKo":""}]}]}` });
  const out = parseJson(text);
  const items = sentences.map((en, n) => {
    const it = arr(out.items, 200).find(x => Number(x && x.i) === n + 1) || arr(out.items, 200)[n] || {};
    return {
      en,
      ko: str(it.ko, 80),
      cue: str(it.cue, 12),
      stress: arr(it.stress, 3).map(w => str(w, 30)).filter(w => w && en.toLowerCase().includes(w.toLowerCase())),
      end: String(it.end || '').toLowerCase() === 'rise' ? 'rise' : 'fall',
      tricky: arr(it.tricky, 2).map(t => ({ word: str(t && t.word, 30), tipKo: str(t && t.tipKo, 40) })).filter(t => t.word && t.tipKo)
    };
  });
  return { status: 200, json: { items, provider: p.id, model } };
}

/* ============================================================
   speech — 녹음을 듣고 피드백
   ============================================================ */
const SPEECH_SYSTEM = `너는 "뚜뚜"라는 앵무새 영어 선생님이야. 한국의 초등학교 1학년(7살) 여자아이가 영어 스피치 대회를 준비하고 있어.
아이가 방금 녹음한 목소리를 듣고, 목표 문장과 비교해서 따뜻하고 구체적으로 피드백해.
- heard: 녹음에서 실제로 들린 영어를 그대로 적어. 목표 문장을 베끼지 마. 소리가 없으면 빈 문자열.
- stars: 3 = 모든 단어를 또렷하고 자연스럽게 말함, 2 = 거의 맞음(작은 실수 1~2개나 조금 불분명), 1 = 빠진 단어가 많거나 알아듣기 어려움. 소리가 없거나 전혀 다른 말이면 1.
- praise: 잘한 점 한 가지. 한국어 반말로 다정하게, 20자 이내.
- tip: "이렇게 말해보면 더 좋아요" 같은, 지금 가장 도움이 될 조언 딱 한 가지. 한국어 40자 이내. 발음은 입 모양·혀 위치처럼 아이가 바로 따라 할 수 있게.
- words: 다시 연습하면 좋은 단어 최대 2개와 tipKo(25자 이내).
- fluency: level 1~3과 noteKo(25자 이내) — 끊김, 머뭇거림, 빠르기.
- intonation: level 1~3과 noteKo(25자 이내) — 힘줄 단어, 문장 끝을 올리거나 내리기.
- missing: 빠뜨린 단어(영어). skipped: 통째로 빠뜨린 문장 번호(여러 문장일 때만, 아니면 빈 배열).
규칙: "틀렸다"는 말을 쓰지 마. 음소·억양 같은 어려운 말 대신 쉬운 말을 써. 영어 발음을 한글로 적지 마. 아이 이름을 부르지 마.
아이가 외워서 말하는 중이면(단계가 높으면) 다 외운 것을 크게 칭찬해.`;

const SPEECH_SCHEMA = {
  type: 'OBJECT',
  properties: {
    heard: { type: 'STRING' },
    stars: { type: 'INTEGER' },
    praise: { type: 'STRING' },
    tip: { type: 'STRING' },
    words: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { word: { type: 'STRING' }, tipKo: { type: 'STRING' } }, required: ['word', 'tipKo'] }
    },
    fluency: { type: 'OBJECT', properties: { level: { type: 'INTEGER' }, noteKo: { type: 'STRING' } }, required: ['level', 'noteKo'] },
    intonation: { type: 'OBJECT', properties: { level: { type: 'INTEGER' }, noteKo: { type: 'STRING' } }, required: ['level', 'noteKo'] },
    missing: { type: 'ARRAY', items: { type: 'STRING' } },
    skipped: { type: 'ARRAY', items: { type: 'INTEGER' } }
  },
  required: ['heard', 'stars', 'praise', 'tip', 'words', 'fluency', 'intonation', 'missing', 'skipped']
};

const STAGES = ['원고를 보면서 말하기', '단어 몇 개를 가리고 말하기', '첫 글자만 보고 말하기', '한국어 뜻만 보고 말하기', '아무것도 안 보고 외워서 말하기'];
const MIMES = ['audio/wav', 'audio/mp4', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/aac'];

async function speech(p, body) {
  const kind = body.kind === 'stage' ? 'stage' : (body.kind === 'chain' ? 'chain' : 'sentence');
  const sentence = str(body.sentence, kind === 'sentence' ? 400 : 4000);
  const audio = String(body.audio || '');
  const mime = MIMES.includes(body.mime) ? body.mime : 'audio/wav';
  if (!sentence || !audio || audio.length > 4000000 || !/^[A-Za-z0-9+/=]+$/.test(audio)) {
    return { status: 400, json: { error: 'bad_input', message: '녹음이 잘 안 됐어요. 다시 해볼까?' } };
  }
  const stage = Math.max(0, Math.min(4, Number(body.stage) || 0));
  const m = body.metrics || {};
  const facts = [
    kind === 'stage' ? `처음부터 끝까지 외워서 하는 리허설이야. 원고(번호가 문장 번호):\n${sentence}`
      : kind === 'chain' ? `여러 문장을 이어서 외워 말하기야. 목표 문장들:\n${sentence}`
      : `목표 문장: "${sentence}"`,
    kind === 'sentence' ? `이번 단계: ${STAGES[stage]}` : '',
    arr(body.stress, 3).length ? `힘줄 단어: ${arr(body.stress, 3).map(w => str(w, 30)).join(', ')}` : '',
    body.end ? `문장 끝: ${body.end === 'rise' ? '올려 말하기' : '내려 말하기'}` : '',
    `기기가 잰 값: 말한 시간 ${Number(m.secs || 0).toFixed(1)}초, 중간에 쉰 곳 ${Number(m.pauses || 0)}번, 목소리 크기 ${str(m.loud, 10) || '보통'}, 문장 끝 높낮이 ${str(m.endPitch, 10) || '모름'}`
  ].filter(Boolean).join('\n');

  const { text, model } = await askGeminiAny(p, {
    system: SPEECH_SYSTEM,
    parts: [{ text: facts }, { inlineData: { mimeType: mime, data: audio } }],
    schema: SPEECH_SCHEMA,
    maxTokens: 2048,
    timeoutMs: kind === 'sentence' ? 12000 : 20000,
    temperature: 0.3
  });
  const out = parseJson(text);
  return {
    status: 200,
    json: {
      heard: str(out.heard, kind === 'sentence' ? 400 : 4000),
      stars: Math.max(1, Math.min(3, Math.round(Number(out.stars) || 1))),
      praise: str(out.praise, 40),
      tip: str(out.tip, 80),
      words: arr(out.words, 2).map(w => ({ word: str(w && w.word, 30), tipKo: str(w && w.tipKo, 50) })).filter(w => w.word),
      fluency: { level: lvl(out.fluency && out.fluency.level), noteKo: str(out.fluency && out.fluency.noteKo, 50) },
      intonation: { level: lvl(out.intonation && out.intonation.level), noteKo: str(out.intonation && out.intonation.noteKo, 50) },
      missing: arr(out.missing, 12).map(w => str(w, 30)).filter(Boolean),
      skipped: arr(out.skipped, 60).map(Number).filter(n => Number.isInteger(n) && n > 0),
      provider: p.id, model
    }
  };
}

/* ============================================================
   tts — 뚜뚜의 자연스러운 목소리 (Gemini 음성 합성)
   아이 목소리가 아니라 뚜뚜가 할 말(선생님 문장·원고 문장)만 보낸다.
   새 Interactions 방식(gemini-3.8-flash-tts)을 먼저 쓰고, 안 되면 예전 generateContent 방식으로.
   앱은 받은 목소리를 기기에 저장해 두고 다시 쓴다 (같은 말은 한 번만 만든다).
   ============================================================ */
const TTS_VOICES = ['Sulafat', 'Achernar', 'Vindemiatrix', 'Leda', 'Aoede', 'Autonoe', 'Despina', 'Kore', 'Zephyr', 'Laomedeia'];
const TTS_STYLES = {
  ko: 'warm, bright and gentle, like a kind teacher talking to a 7-year-old child; clear and not too fast',
  en: 'clear, warm and friendly, like a kind English teacher reading to a 7-year-old child, with natural intonation',
  slow: 'very slowly and clearly, word by word, like a kind teacher reading to a young child',
  speech: 'natural, bright and confident, like a cheerful child giving a speech, clear pronunciation'
};
const TTS_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'];
let ttsGood = null;                                   // 한 번 되는 모델을 찾으면 기억한다
const ttsCache = new Map();                           // 같은 서버가 살아 있는 동안 같은 말은 다시 만들지 않는다

// 응답 어딘가에 들어 있는 오디오(base64)를 찾는다 — 새 방식·예전 방식 둘 다
function findAudio(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  const mime = String(node.mime_type || node.mimeType || '');
  if (typeof node.data === 'string' && node.data.length > 200 && (/audio/i.test(mime) || node.type === 'audio')) return { data: node.data, mime };
  for (const k of ['output_audio', 'outputAudio', 'inlineData', 'inline_data', 'audio']) {
    if (node[k]) { const hit = findAudio(node[k], depth + 1); if (hit) return hit; }
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') { const hit = findAudio(v, depth + 1); if (hit) return hit; }
  }
  return null;
}
// 머리 없는 PCM(16비트, 한 채널)이면 WAV 머리를 붙인다
function asWav(b64, mime) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.slice(0, 4).toString('ascii') === 'RIFF') return buf.toString('base64');
  const rate = +((String(mime).match(/rate=(\d+)/) || [])[1] || 24000);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + buf.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(buf.length, 40);
  return Buffer.concat([h, buf]).toString('base64');
}
async function ttsCall(p, model, text, voice, style) {
  const legacy = /^gemini-2\./.test(model);
  const url = legacy
    ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
    : 'https://generativelanguage.googleapis.com/v1beta/interactions';
  const body = legacy
    ? { contents: [{ parts: [{ text: `Say this in a ${style} way: ${text}` }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } }
    : { model, input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style }] }] }],
        response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice }] } };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': p.key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000)
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new GeminiError(r.status, j);
  const a = findAudio(j);
  if (!a) throw new GeminiError(200, { error: { message: '목소리가 비었어요', status: 'EMPTY' } });
  return asWav(a.data, a.mime);
}
async function tts(p, body) {
  const text = str(body.text, 400);
  if (!text) return { status: 400, json: { error: 'bad_input', message: '읽을 말이 없어요.' } };
  const voice = TTS_VOICES.includes(body.voice) ? body.voice : 'Sulafat';
  const style = TTS_STYLES[body.style] || TTS_STYLES.en;
  const key = `${voice}|${body.style}|${text}`;
  if (ttsCache.has(key)) return { status: 200, json: { audio: ttsCache.get(key), mime: 'audio/wav', voice, model: ttsGood } };
  const env = clean(process.env.GEMINI_TTS_MODEL);
  const order = [...new Set([env, ttsGood, ...TTS_MODELS].filter(Boolean))];
  let last = null;
  for (const model of order) {
    try {
      const audio = await ttsCall(p, model, text, voice, style);
      ttsGood = model;
      ttsCache.set(key, audio);
      if (ttsCache.size > 60) ttsCache.delete(ttsCache.keys().next().value);
      return { status: 200, json: { audio, mime: 'audio/wav', voice, model } };
    } catch (e) {
      last = e;
      // 모델이 없거나(404) 이 방식을 모르면(400) 다음 모델로. 한도·키 문제는 바로 멈춘다.
      if (!(e instanceof GeminiError) || ![400, 404].includes(e.status)) throw e;
    }
  }
  throw last;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const p = provider(), pa = provider({ audio: true });
    res.setHeader('cache-control', 'no-store');
    const models = req.query && req.query.models === '1' && pa ? await geminiModels(pa) : undefined;
    return res.status(200).json({ ok: !!p, provider: p ? p.id : null, model: p ? p.model : null, keyName: p ? p.name : null, audio: !!pa, ...(models ? { models } : {}) });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed', message: 'POST로 보내주세요.' });

  const body = req.body || {};
  const task = body.task;
  if (!['prep', 'speech', 'tts'].includes(task)) return res.status(400).json({ error: 'bad_task', message: '무엇을 할지 모르겠어요.' });

  const fam = String(req.headers['x-family-id'] || '');
  if (!(await familyOk(fam))) return res.status(403).json({ error: 'no_family', message: '우리 가족 주소로 열어주세요.' });

  const p = provider({ audio: task !== 'prep' });
  if (!p) return res.status(503).json({ error: 'no_key', message: KID_TT.no_key });

  try {
    const r = task === 'prep' ? await prep(p, body) : (task === 'tts' ? await tts(p, body) : await speech(p, body));
    res.setHeader('cache-control', 'no-store');
    return res.status(r.status).json(r.json);
  } catch (e) {
    const why = explain(e, p, KID_TT);
    console.error('coach failed', task, p.id, why.code, e && e.status, e && e.message);
    return res.status(why.code === 'failed' ? 500 : 502).json({ error: why.code, message: why.kid });
  }
}
