/* 텔레그램 연결 — 앱의 '부모님 관리 → 알림'에서 부른다.
   부모님이 t.me/<봇>?start=<가족ID> 를 열고 시작(START)을 누르면 텔레그램이 봇에게
   "/start <가족ID>" 를 보낸다. 여기서 그 메시지를 찾아 부모님 대화방 번호(chat id)를 돌려준다.
   앱은 그 번호를 가족 설정에 저장하므로 TELEGRAM_CHAT_ID 환경변수를 따로 넣을 필요가 없다.

   필요한 환경변수: TELEGRAM_BOT_TOKEN
   GET  /api/telegram-link?familyId=<uuid>           봇 정보 + 이 가족으로 시작한 대화방 찾기
   POST /api/telegram-link  {action:'test', chatId}   그 대화방으로 확인 메시지 보내기 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT = /^-?\d{4,20}$/;

function token() {
  return String(process.env.TELEGRAM_BOT_TOKEN || '').trim()
    .replace(/^["']|["']$/g, '').replace(/^bot(?=\d)/, '');
}

async function tg(tok, method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${tok}/${method}`, body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : undefined);
    return await r.json();
  } catch (e) {
    return { ok: false, description: 'telegram_unreachable' };
  }
}

const nameOf = c => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || '';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  const tok = token();
  if (!tok) {
    return res.status(200).json({
      ok: false, reason: 'no_token',
      message: '서버에 봇 토큰이 없어요. 버셀 환경변수 TELEGRAM_BOT_TOKEN을 넣고 Redeploy 해주세요.'
    });
  }

  const me = await tg(tok, 'getMe');
  if (!me.ok) {
    return res.status(200).json({
      ok: false, reason: 'bad_token',
      message: `봇 토큰이 맞지 않아요 (${me.description || '확인 실패'}). @BotFather → /mybots → API Token에서 다시 복사해 주세요.`
    });
  }
  const bot = { username: me.result.username, name: me.result.first_name };

  // ---------- 확인 메시지 보내기 ----------
  if (req.method === 'POST') {
    const { action, chatId } = req.body || {};
    if (action !== 'test' || !CHAT.test(String(chatId || ''))) {
      return res.status(400).json({ ok: false, reason: 'bad_request', message: '잘못된 요청이에요.' });
    }
    const r = await tg(tok, 'sendMessage', {
      chat_id: String(chatId),
      text: '✅ Do-Learn Do-Learn 알림이 연결됐어요!\n아이가 오늘 할 일을 마치고 놀이를 요청하면 여기로 알려드릴게요.'
    });
    if (!r.ok) {
      const why = r.description || '';
      return res.status(200).json({
        ok: false, reason: 'send_failed',
        message: /blocked/i.test(why) ? '텔레그램에서 봇이 차단돼 있어요. 봇 대화방에서 차단을 풀어주세요.'
               : /chat not found/i.test(why) ? '대화방을 찾지 못했어요. 봇에게 시작(START)을 다시 눌러주세요.'
               : `보내지 못했어요 (${why || '알 수 없음'})`
      });
    }
    return res.status(200).json({ ok: true, sent: true });
  }

  // ---------- 이 가족으로 시작한 대화방 찾기 ----------
  const familyId = String((req.query && req.query.familyId) || '');
  if (!UUID.test(familyId)) {
    return res.status(400).json({ ok: false, reason: 'bad_family', message: '가족 정보가 잘못됐어요.' });
  }

  const up = await tg(tok, 'getUpdates');
  if (!up.ok) {
    return res.status(200).json({
      ok: true, bot, chat: null, candidates: [],
      warn: /webhook/i.test(up.description || '')
        ? '봇에 웹훅이 걸려 있어서 대화를 읽을 수 없어요.'
        : '대화 목록을 읽지 못했어요.'
    });
  }

  let chat = null;
  const candidates = [];
  // 최신 메시지부터 본다
  for (const u of (up.result || []).slice().reverse()) {
    const m = u.message || u.edited_message;
    if (!m || !m.chat || m.chat.type !== 'private') continue;
    const text = String(m.text || '');
    if (!chat && text.startsWith('/start') && text.split(/\s+/)[1] === familyId) {
      chat = { id: m.chat.id, name: nameOf(m.chat) };
    }
    if (!candidates.some(c => c.id === m.chat.id) && candidates.length < 5) {
      candidates.push({ id: m.chat.id, name: nameOf(m.chat) });
    }
  }

  return res.status(200).json({
    ok: true,
    bot,
    link: `https://t.me/${bot.username}?start=${familyId}`,
    chat,
    // 가족 표시 없이 봇에게 말을 건 사람이 있으면 "혹시 이분인가요?"로 보여준다
    candidates: chat ? [] : candidates
  });
}
