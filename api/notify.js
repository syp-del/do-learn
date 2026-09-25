/* 승인 요청 알림 — 부모님 텔레그램으로 보낸다.
   환경변수: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
   둘 다 없으면 조용히 넘어간다(앱은 그대로 동작하고, 부모님이 앱을 열면 카드가 보인다). */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // 붙여넣을 때 흔히 딸려오는 공백·따옴표·"bot" 접두어를 걷어낸다
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim()
    .replace(/^["']|["']$/g, '').replace(/^bot(?=\d)/, '');
  const { kidName, minutes, familyId, chatId: bodyChat } = req.body || {};
  // 앱의 '부모님 관리 → 알림'에서 연결한 대화방이 1순위, 환경변수 TELEGRAM_CHAT_ID는 예비
  const fromBody = /^-?\d{4,20}$/.test(String(bodyChat || '')) ? String(bodyChat) : '';
  const chatId = fromBody || String(process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chatId) {
    return res.status(200).json({ sent: false, reason: 'not_configured' });
  }
  const name = String(kidName || '아이').slice(0, 20);
  const mins = Number(minutes) || 20;

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  // tg=1 — 텔레그램 단추로 연 승인은 대표 관리자 비밀번호로만 된다(앱이 알아본다)
  const link = familyId ? `https://${host}/#f=${familyId}&tg=1` : `https://${host}/`;

  // 이름 뒤 조사를 받침에 맞춘다 — "하윤이가" / "나리가"
  const last = name.charCodeAt(name.length - 1);
  const jong = last >= 0xAC00 && last <= 0xD7A3 && (last - 0xAC00) % 28 > 0;
  const subject = `${name}${jong ? '이가' : '가'}`;

  // Markdown은 이름에 _ * 같은 글자가 있으면 텔레그램이 메시지를 거부한다. HTML로 보내고 이스케이프한다.
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const text =
    `🔔 <b>${esc(subject)} 놀이를 하고 싶대요!</b>\n` +
    `오늘 할 일을 모두 마쳤어요.\n` +
    `요청한 시간: ${mins}분\n\n` +
    `아래 버튼을 눌러 앱에서 승인해 주세요. (대표 관리자 비밀번호)`;

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: `✅ 열어주러 가기 (${mins}분)`, url: link }]]
        }
      })
    });

    const j = await r.json();
    if (!j.ok) {
      console.error('telegram error', j);
      return res.status(502).json({ sent: false, reason: j.description || 'telegram_error' });
    }
    return res.status(200).json({ sent: true });
  } catch (e) {
    console.error('notify failed', e);
    return res.status(500).json({ sent: false, reason: 'failed' });
  }
}
