/* 승인 요청 알림 — 부모님 텔레그램으로 보낸다.
   환경변수: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
   둘 다 없으면 조용히 넘어간다(앱은 그대로 동작하고, 부모님이 앱을 열면 카드가 보인다). */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return res.status(200).json({ sent: false, reason: 'not_configured' });
  }

  const { kidName, minutes, familyId } = req.body || {};
  const name = String(kidName || '아이').slice(0, 20);
  const mins = Number(minutes) || 20;

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const link = familyId ? `https://${host}/#f=${familyId}` : `https://${host}/`;

  // 이름 뒤 조사를 받침에 맞춘다 — "하윤이가" / "나리가"
  const last = name.charCodeAt(name.length - 1);
  const jong = last >= 0xAC00 && last <= 0xD7A3 && (last - 0xAC00) % 28 > 0;
  const subject = `${name}${jong ? '이가' : '가'}`;

  const text =
    `🔔 *${subject} 게임을 하고 싶대요!*\n` +
    `오늘 할 일을 모두 마쳤어요.\n` +
    `요청한 시간: ${mins}분\n\n` +
    `아래 버튼을 눌러 앱에서 승인해 주세요.`;

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
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
