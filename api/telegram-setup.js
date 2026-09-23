/* 텔레그램 연결 확인 페이지 — 부모님이 휴대폰으로 열어보는 용도.
   각 단계가 됐는지 보여주고, chat id를 찾아주고, 테스트 메시지를 보낸다.

   환경변수: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  (버셀 → Settings → Environment Variables)
   환경변수는 넣은 뒤 재배포(Redeploy)해야 반영된다.

   GET /api/telegram-setup          상태 보기
   GET /api/telegram-setup?test=1   테스트 메시지 보내기 (두 값이 모두 있을 때만) */

const esc = s => String(s == null ? '' : s)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function tg(token, method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : undefined);
    return await r.json();
  } catch (e) {
    return { ok: false, description: '텔레그램에 연결하지 못했어요' };
  }
}

// 흔한 실수: 앞뒤 공백, 따옴표, "bot" 접두어까지 같이 붙여넣기
function cleanToken(raw) {
  return String(raw || '').trim().replace(/^["']|["']$/g, '').replace(/^bot(?=\d)/, '');
}

export default async function handler(req, res) {
  const token = cleanToken(process.env.TELEGRAM_BOT_TOKEN);
  const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  const looksLikeToken = /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token);

  let bot = null, tokenError = null, chats = [], updatesError = null, test = null;

  if (token) {
    const me = await tg(token, 'getMe');
    if (me.ok) bot = me.result;
    else tokenError = me.description || '토큰을 확인하지 못했어요';
  }

  // chat id가 아직 없을 때만 대화 목록을 보여준다 (설정이 끝나면 숨긴다)
  if (bot && !chatId) {
    const up = await tg(token, 'getUpdates');
    if (up.ok) {
      for (const u of up.result || []) {
        const m = u.message || u.edited_message;
        const c = m && m.chat;
        if (c && c.type === 'private' && !chats.some(x => x.id === c.id)) {
          chats.push({ id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(' '), text: m.text || '' });
        }
      }
    } else {
      updatesError = up.description || '대화 목록을 읽지 못했어요';
    }
  }

  if (bot && chatId && req.query && req.query.test === '1') {
    const r = await tg(token, 'sendMessage', {
      chat_id: chatId,
      text: '✅ Do-Learn Do-Learn 알림이 연결됐어요!\n아이가 게임을 요청하면 여기로 알려드릴게요.'
    });
    test = r.ok ? { ok: true } : { ok: false, why: r.description || '보내지 못했어요' };
  }

  const done1 = !!bot;
  const done2 = done1 && !!chatId;
  const allDone = done2 && (!test || test.ok);

  const step = (n, ok, title, body) => `
    <section class="step ${ok ? 'ok' : ''}">
      <div class="num">${ok ? '✓' : n}</div>
      <div class="body"><h2>${title}</h2>${body}</div>
    </section>`;

  // ---------- 1단계: 봇 토큰 ----------
  let s1;
  if (!token) {
    s1 = `<p class="bad">아직 <code>TELEGRAM_BOT_TOKEN</code>이 없어요.</p>
      <ol>
        <li>텔레그램에서 <b>@BotFather</b>를 찾아 대화를 시작해요.</li>
        <li><code>/newbot</code>을 보내고 봇 이름과 아이디를 정해요.</li>
        <li>받은 토큰을 버셀 환경변수 <code>TELEGRAM_BOT_TOKEN</code>에 넣어요.</li>
        <li>버셀에서 <b>Redeploy</b>를 누르고 이 페이지를 새로고침해요.</li>
      </ol>`;
  } else if (!bot) {
    s1 = `<p class="bad">토큰이 맞지 않아요: <code>${esc(tokenError)}</code></p>
      ${looksLikeToken ? '' : `<p>토큰은 <code>1234567890:AAH…</code>처럼 <b>숫자, 콜론(:), 긴 영문</b> 순서예요.
        앞뒤 공백이나 따옴표 없이 그대로 붙여넣어 주세요.</p>`}
      <p>@BotFather에게 <code>/mybots</code> → 봇 선택 → <b>API Token</b>에서 다시 복사할 수 있어요.</p>`;
  } else {
    s1 = `<p>봇 <b>${esc(bot.first_name)}</b> (<a href="https://t.me/${esc(bot.username)}">@${esc(bot.username)}</a>)
      에 연결됐어요.</p>`;
  }

  // ---------- 2단계: chat id ----------
  let s2;
  if (!done1) {
    s2 = `<p class="dim">1단계를 먼저 끝내주세요.</p>`;
  } else if (chatId) {
    s2 = `<p><code>TELEGRAM_CHAT_ID</code> = <code>${esc(chatId)}</code> 로 설정돼 있어요.</p>`;
  } else if (updatesError) {
    s2 = `<p class="bad">대화 목록을 못 읽었어요: <code>${esc(updatesError)}</code></p>`;
  } else if (!chats.length) {
    s2 = `<p>텔레그램에서 <a href="https://t.me/${esc(bot.username)}"><b>@${esc(bot.username)}</b></a>를 열고
      <b>시작(Start)</b>을 누르거나 아무 말이나 한 번 보내주세요.</p>
      <p>봇은 먼저 말을 걸 수 없어서 이 과정이 꼭 필요해요. 보낸 뒤 이 페이지를 <b>새로고침</b>하세요.</p>
      <p><a class="btn" href="https://t.me/${esc(bot.username)}">텔레그램에서 봇 열기</a>
         <a class="btn ghost" href="">새로고침</a></p>`;
  } else {
    s2 = `<p>찾았어요! 아래 숫자를 버셀 환경변수 <code>TELEGRAM_CHAT_ID</code>에 넣고 <b>Redeploy</b> 하세요.</p>
      ${chats.map(c => `
        <div class="chat">
          <div><b>${esc(c.name || '이름 없음')}</b>${c.text ? ` · “${esc(c.text.slice(0, 20))}”` : ''}</div>
          <div class="idrow"><code class="big" id="c${esc(c.id)}">${esc(c.id)}</code>
            <button onclick="copyId('${esc(c.id)}', this)">복사</button></div>
        </div>`).join('')}
      <p class="dim">여러 개가 보이면 부모님 이름이 적힌 것을 고르세요.</p>`;
  }

  // ---------- 3단계: 테스트 ----------
  let s3;
  if (!done2) {
    s3 = `<p class="dim">2단계까지 끝나면 테스트 메시지를 보낼 수 있어요.</p>`;
  } else if (test && test.ok) {
    s3 = `<p class="good">텔레그램으로 테스트 메시지를 보냈어요. 휴대폰을 확인해 보세요! 🎉</p>`;
  } else if (test) {
    const hint = /chat not found/i.test(test.why)
      ? '<p><code>TELEGRAM_CHAT_ID</code> 숫자가 틀렸거나, 봇에게 아직 말을 건 적이 없어요.</p>'
      : /blocked/i.test(test.why) ? '<p>텔레그램에서 이 봇을 차단하셨어요. 차단을 풀어주세요.</p>' : '';
    s3 = `<p class="bad">보내지 못했어요: <code>${esc(test.why)}</code></p>${hint}
      <p><a class="btn" href="?test=1">다시 보내기</a></p>`;
  } else {
    s3 = `<p>버튼을 누르면 휴대폰 텔레그램으로 확인 메시지가 가요.</p>
      <p><a class="btn" href="?test=1">테스트 메시지 보내기</a></p>`;
  }

  const html = `<!doctype html><html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>텔레그램 연결</title>
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
  code.big{font-size:22px;padding:4px 10px;background:#FFF1D6}
  .bad{color:var(--deep)} .good{color:var(--mintd);font-weight:700} .dim{color:var(--soft)}
  .btn{display:inline-block;background:var(--berry);color:#fff;text-decoration:none;border-radius:999px;padding:10px 18px;font-weight:700;margin:4px 6px 0 0}
  .btn.ghost{background:#fff;color:var(--cocoa);border:2px solid var(--blush)}
  .chat{border:2px solid var(--blush);border-radius:14px;padding:10px 12px;margin:8px 0}
  .idrow{display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap}
  .idrow button{border:0;background:var(--cocoa);color:#fff;border-radius:999px;padding:8px 14px;font-size:14px}
  .done{background:var(--mint);color:#fff;border-radius:20px;padding:16px;text-align:center;font-weight:700;margin-bottom:12px}
  a{color:var(--deep)}
</style></head><body><main>
  <h1>텔레그램 알림 연결</h1>
  <p class="lead">아이가 게임을 요청하면 부모님 휴대폰으로 알림이 가도록 설정해요.</p>
  ${allDone && test && test.ok ? '<div class="done">모든 설정이 끝났어요! 이제 이 페이지는 닫아도 돼요.</div>' : ''}
  ${step(1, done1, '봇 토큰', s1)}
  ${step(2, done2, '부모님 대화방 번호 (chat id)', s2)}
  ${step(3, !!(test && test.ok), '테스트 메시지', s3)}
  <p class="dim" style="margin-top:18px">환경변수를 넣거나 바꾼 뒤에는 버셀에서 <b>Redeploy</b>를 해야 반영돼요.</p>
</main>
<script>
function copyId(id, btn){
  var done = function(){ btn.textContent = '복사됨!'; setTimeout(function(){ btn.textContent = '복사'; }, 1500); };
  if (navigator.clipboard) navigator.clipboard.writeText(String(id)).then(done, function(){ pick(id); });
  else pick(id);
}
function pick(id){
  var el = document.getElementById('c' + id); if (!el) return;
  var r = document.createRange(); r.selectNodeContents(el);
  var s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
</script></body></html>`;

  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  return res.status(200).send(html);
}
