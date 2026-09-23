/* 텔레그램 chat id 찾기 — 브라우저에서 한 번 열어보는 용도.
   1) @BotFather 에서 봇을 만들고 토큰을 받는다
   2) 버셀 환경변수에 TELEGRAM_BOT_TOKEN 을 넣는다
   3) 텔레그램에서 그 봇에게 아무 메시지나 보낸다
   4) 이 주소를 열면 chat id 가 보인다 → TELEGRAM_CHAT_ID 로 넣는다 */

export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return res.status(200).json({
      ok: false,
      다음: 'TELEGRAM_BOT_TOKEN 을 버셀 환경변수에 먼저 넣고, 재배포한 뒤 이 주소를 다시 열어주세요.'
    });
  }

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
    const j = await r.json();
    if (!j.ok) {
      return res.status(200).json({ ok: false, 오류: j.description || '토큰이 맞지 않는 것 같아요.' });
    }

    const chats = [];
    for (const u of j.result || []) {
      const c = (u.message || u.edited_message || u.channel_post || {}).chat;
      if (c && !chats.some(x => x.chat_id === c.id)) {
        chats.push({
          chat_id: c.id,
          이름: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.title || '',
          종류: c.type
        });
      }
    }

    const already = process.env.TELEGRAM_CHAT_ID;
    return res.status(200).json({
      ok: true,
      찾은_대화: chats,
      현재_설정된_CHAT_ID: already || '(아직 없음)',
      다음: chats.length
        ? 'chat_id 값을 버셀 환경변수 TELEGRAM_CHAT_ID 에 넣고 재배포하세요.'
        : '텔레그램에서 봇에게 아무 메시지나 한 번 보낸 뒤 이 주소를 새로고침하세요.'
    });
  } catch (e) {
    return res.status(500).json({ ok: false, 오류: '텔레그램에 연결하지 못했어요.' });
  }
}
