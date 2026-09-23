/* 책 찾기 — 서버에서 알라딘과 카카오를 차례로 물어본다.
   알라딘은 CORS 헤더를 보내지 않아 브라우저에서 직접 부를 수 없다. 그래서 여기서 대신 부른다.
   환경변수(둘 다 선택): ALADIN_TTB_KEY, KAKAO_REST_KEY
   GET /api/book?isbn=9788934972464   또는   GET /api/book?title=구름빵 */

async function fromAladin(isbn, title) {
  const key = process.env.ALADIN_TTB_KEY;
  if (!key) return null;

  const base = isbn
    ? `https://www.aladin.co.kr/ttb/api/ItemLookUp.aspx?ItemIdType=ISBN13&ItemId=${encodeURIComponent(isbn)}`
    : `https://www.aladin.co.kr/ttb/api/ItemSearch.aspx?QueryType=Title&Query=${encodeURIComponent(title)}&MaxResults=6`;
  const url = `${base}&ttbkey=${key}&output=js&Version=20131101&Cover=Big`;

  const r = await fetch(url);
  if (!r.ok) return null;
  // 알라딘 output=js 는 가끔 JSON에 없는 \' 이스케이프나 끝의 ; 가 붙는다
  const text = (await r.text()).trim().replace(/;\s*$/, '').replace(/\\'/g, "'");
  let j = null;
  try { j = JSON.parse(text); } catch (e) { console.error('aladin parse failed', text.slice(0, 120)); return null; }
  if (!j || !Array.isArray(j.item) || !j.item.length) return null;

  return j.item.map(it => ({
    title: it.title || '',
    author: (it.author || '').replace(/\s*\((지은이|글|그림|옮긴이|엮은이)[^)]*\)/g, '').trim(),
    publisher: it.publisher || '',
    cover: it.cover || '',
    isbn: it.isbn13 || it.isbn || '',
    category: it.categoryName || '',        // 예: 국내도서>어린이>그림책
    source: 'aladin'
  }));
}

async function fromKakao(isbn, title) {
  const key = process.env.KAKAO_REST_KEY;
  if (!key) return null;

  const url = isbn
    ? `https://dapi.kakao.com/v3/search/book?target=isbn&query=${encodeURIComponent(isbn)}&size=1`
    : `https://dapi.kakao.com/v3/search/book?target=title&query=${encodeURIComponent(title)}&size=6`;

  const r = await fetch(url, { headers: { Authorization: `KakaoAK ${key}` } });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j || !Array.isArray(j.documents) || !j.documents.length) return null;

  return j.documents.map(d => ({
    title: d.title || '',
    author: (d.authors || []).join(', '),
    publisher: d.publisher || '',
    cover: d.thumbnail || '',
    isbn: (d.isbn || '').split(' ').pop() || '',
    source: 'kakao'
  }));
}

export default async function handler(req, res) {
  const isbn = (req.query.isbn || '').replace(/[^0-9Xx]/g, '');
  const title = (req.query.title || '').trim();
  if (!isbn && !title) {
    return res.status(400).json({ error: 'bad_query', message: 'isbn 또는 title이 필요해요.' });
  }

  const tried = [];
  for (const [name, fn] of [['aladin', fromAladin], ['kakao', fromKakao]]) {
    try {
      const docs = await fn(isbn, title);
      if (docs && docs.length) {
        res.setHeader('cache-control', 'public, max-age=86400');
        return res.status(200).json({ docs, provider: name });
      }
      tried.push(name);
    } catch (e) {
      console.error(name, 'failed', e);
      tried.push(`${name}(오류)`);
    }
  }

  const anyKey = process.env.ALADIN_TTB_KEY || process.env.KAKAO_REST_KEY;
  return res.status(200).json({
    docs: [],
    provider: null,
    message: anyKey ? '그 책을 찾지 못했어요.' : '책 찾기 열쇠가 아직 없어요. 제목을 직접 적어주세요.',
    tried
  });
}
