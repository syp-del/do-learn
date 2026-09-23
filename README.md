# Do-Learn Do-Learn

초등학교 1학년 쌍둥이 자매를 위한 읽기·낱말·할 일 앱.

- **앱**: 단일 HTML 파일 `index.html` (빌드 도구 없음)
- **배포**: Vercel 정적 호스팅 + 서버리스 함수 두 개
- **데이터**: Supabase (Postgres + Storage)

---

## 구조

```
index.html      앱 전체 (HTML/CSS/JS 한 파일)
api/dict.js     사전 — Gemini(무료) 또는 Claude를 서버에서 대신 호출 (GET 이면 연결 확인 페이지)
api/book.js     책 찾기 — 알라딘 → 카카오 순으로 서버에서 조회
package.json    type: module (Vercel 함수가 ESM), 의존성은 @anthropic-ai/sdk 하나
```

앱은 열린 환경을 스스로 알아본다.

| 어디서 열렸나 | 저장 | 사전 | 책 찾기 |
|---|---|---|---|
| Vercel(일반 웹) | Supabase | `/api/dict` | `/api/book` |
| claude.ai Artifact | Artifact `db` | Claude `sample` | 브라우저에서 카카오 직접 |
| 그 외(파일 열기 등) | 메모리(경고 배너) | 불가 | 수동 입력 |

---

## 배포하기

### 1. Vercel에 연결
1. https://vercel.com/new 접속
2. `syp-del/do-learn` 저장소를 **Import**
3. Framework Preset은 **Other**, 빌드 설정은 건드리지 않는다 (빌드 과정이 없다)
4. **Deploy**

이후 `main`에 푸시할 때마다 자동 배포된다.

### 2. 환경변수 (Vercel → Settings → Environment Variables)

| 이름 | 쓰임 | 없으면 |
|---|---|---|
| `GEMINI_API_KEY` | 사전 (1순위, 무료) | Claude 키가 있으면 Claude, 둘 다 없으면 "아직 준비되지 않았어요" 안내 |
| `ANTHROPIC_API_KEY` (또는 `CLAUDE_API_KEY`) | 사전 (2순위, 유료 크레딧) | 〃 |
| `GEMINI_MODEL` | 사전 모델 바꾸기 (선택) | `gemini-3.5-flash-lite` |
| `ALADIN_TTB_KEY` (또는 `ALADDIN_API_KEY`) | 책 정보·표지·종류 (1순위) | 카카오로 넘어감 |
| `KAKAO_REST_KEY` | 책 정보·표지 (2순위) | 제목 직접 입력 |
| `TELEGRAM_BOT_TOKEN` | 승인 요청 알림 | 부모님이 앱을 열어야 카드가 보임 |
| `TELEGRAM_CHAT_ID` | 알림 받을 대화방 | 〃 |

**하나도 없어도 앱은 완전히 돌아간다.** 책은 바코드로 ISBN을 읽고 표지를 직접 찍어 등록하면 되고,
단어는 직접 뜻을 적어 담을 수 있다.

키 받는 곳
- Gemini API (무료): https://aistudio.google.com/apikey → Create API key
- Claude API: https://console.anthropic.com → API Keys
- 알라딘 TTB: https://www.aladin.co.kr/ttb/wblog_manage.aspx (회원가입 후 신청)
- 카카오 REST: https://developers.kakao.com → 내 애플리케이션 → 앱 키

### 3. Supabase
프로젝트 `do-learn` (서울 리전)에 이미 스키마가 들어가 있다. 추가 설정은 없다.
`index.html` 상단의 `SB_URL`, `SB_KEY`가 그 프로젝트를 가리킨다.

---

## 데이터가 보호되는 방식

가족마다 UUID 하나(`familyId`)를 갖는다. 주소 끝에 `#f=<UUID>` 로 붙고, 이 기기에도 저장된다.

- 앱은 모든 요청에 `x-family-id` 헤더를 실어 보낸다.
- Postgres RLS가 그 헤더와 `family_id`가 일치하는 행만 돌려준다.
- 공개 키(`SB_KEY`)만 알고 헤더가 없으면 **읽기는 빈 결과, 쓰기는 401**이다.

즉 **주소를 아는 사람만** 기록을 본다. 다른 기기에서 이어 쓰려면
부모님 화면 → 설정 → `우리 가족 주소`를 복사해 그 주소로 열면 된다.
아무에게나 알려주면 안 되는 주소다.

표지 사진은 `covers` 버킷에 `<familyId>/<랜덤>.jpg` 경로로 올라간다.
버킷은 공개라 표지 주소로는 누구나 볼 수 있지만, 목록 보기·올리기·지우기는
`x-family-id` 헤더의 가족 폴더 안에서만 된다(storage 정책 `covers_read_own` / `covers_write_own` / `covers_delete_own`).
그래서 버킷 목록으로 다른 가족의 폴더 이름(가족 ID)을 알아낼 수 없다.

### 테이블

| 테이블 | 내용 |
|---|---|
| `items` | 앱의 모든 기록. `coll`(books/words/todos/sessions/unlocks/requests/profiles/dict) + `data` jsonb |
| `settings` | 가족별 설정 한 줄 (PIN, 게임 시간, 카테고리, 날씨 등) |

기록을 jsonb 한 칸에 담아 앱이 쓰는 객체 모양을 그대로 저장한다.
필드를 늘려도 마이그레이션이 필요 없다.

동기화는 실시간 구독 대신 **5초 폴링**이다(화면이 보일 때만). 승인 알림에는 충분하고,
RLS 헤더 방식과 충돌하지 않는다.

---

## 사전 연결 (Gemini / Claude)

단어 탭의 사전은 `api/dict.js`가 AI에게 낱말 뜻을 물어 온다.
`GEMINI_API_KEY`가 있으면 Gemini(`gemini-3.5-flash-lite`, 무료 등급 — 찾은 낱말이 구글 서비스 개선에 쓰일 수 있다),
없고 Claude 키가 있으면 Claude(Haiku 4.5)를 쓴다.
설정은 **https://<배포 주소>/api/dict** 페이지가 단계별로 안내하고,
키가 보이는지와 실제로 찾아지는지(`?test=1`)를 확인해 준다.

1. https://aistudio.google.com/apikey → Create API key (`AIza`로 시작, 결제 정보 필요 없음)
2. 버셀 환경변수 `GEMINI_API_KEY`에 붙여넣기 → Redeploy
3. 확인 페이지에서 **시험해 보기**

키가 틀리면 "사전 열쇠가 맞지 않아요", 무료 사용량을 넘으면 "사전이 조금 바빠요",
(Claude) 크레딧이 없으면 "사전 이용권이 다 됐어요"가 아이 화면에 뜬다.

---

## 텔레그램 승인 알림

아이가 `🔔 부모님께 승인 받기`를 누르면 `api/notify.js`가 부모님 텔레그램으로 메시지를 보낸다.
메시지의 버튼을 누르면 앱이 열리고, PIN을 입력해 승인한다.

설정은 **https://<배포 주소>/api/telegram-setup** 페이지가 단계별로 안내한다.
토큰이 맞는지, chat id가 무엇인지 보여주고, 테스트 메시지를 보낼 수 있다.

1. 텔레그램 **@BotFather** → `/newbot` → 이름 → 아이디(`_bot`으로 끝남) → 토큰 받기
2. 버셀 환경변수 `TELEGRAM_BOT_TOKEN` 추가 → Redeploy
3. 텔레그램에서 만든 봇에게 **시작(Start)** 또는 아무 메시지
4. 설정 페이지에서 chat id 복사 → `TELEGRAM_CHAT_ID` 추가 → Redeploy
5. 설정 페이지에서 **테스트 메시지 보내기**

봇 토큰은 서버 환경변수에만 둔다. 앱 코드나 저장소에 넣지 않는다.

---

## 화면

| 탭 | 하는 일 |
|---|---|
| 오늘 | 할 일 체크, 시작/끝 버튼으로 공부 시간 재기, 이번 주 딸기 스트립 |
| 책장 | 카테고리별 책탑. 6개 종류가 한 화면에 모두 보인다(좌우 스크롤 없음). 10권마다 리본 |
| 단어 | 영한·영영·한글 사전, 말로 찾기, 발음 듣기, 5단계 복습 카드 |
| 대결 | 두 아이의 이번 주 책·단어·할 일을 나란히. 책왕/단어왕/성실왕 + 함께 모으기 |
| 게임 | 부모님 승인 후 열림. 그림 찾기·별똥별·단어 짝 맞추기·반짝 새총(손가락으로 당기기, ✋ 손 제스처는 선택) |

시작 화면에 오늘 날짜·요일·날씨와 응원 문구가 뜨고, 두 아이 카드에 이번 주 성과와
오늘 할 일 진행률이 함께 보인다.

---

## 게임 승인이 동작하는 방식

1. 아이가 오늘 할 일을 모두 마치면 `🔔 부모님께 승인 받기`가 열린다.
2. 누르면 `requests` 문서가 생기고, **같은 계정으로 앱을 열어둔 모든 기기**
   (부모님 휴대폰 포함)에 `○○이가 게임을 하고 싶대요!` 카드가 몇 초 안에 뜬다.
3. 부모님이 `승인`을 누르고 PIN을 입력하면 아이 패드가 즉시 열리고 타이머가 돈다.
4. 시간이 끝나면 자동으로 다시 잠긴다.

> **카카오톡 알림이나 휴대폰 푸시는 이 페이지에서 보낼 수 없다.** 브라우저 페이지가
> 외부로 메시지를 보내려면 서버가 필요하다. 지금은 부모님이 앱을 열었을 때 알림 카드를
> 보는 방식이다. 카카오톡까지 원하면 Supabase Edge Function을 하나 세워야 한다.
>
> 승인 로직은 `requestUnlock()` / `approveRequest()` 두 함수로 분리돼 있어
> 나중에 카카오를 붙일 때 그 자리만 바꾸면 된다.

---

## 책 등록이 동작하는 방식

`책 등록` → 카메라로 뒤표지 바코드 → ISBN을 읽는다. 제목은 이 순서로 채운다.

1. **카카오 책 검색** — 부모님 설정에 REST 키가 있으면
   `GET https://dapi.kakao.com/v3/search/book?target=isbn&query=<ISBN>`,
   헤더 `Authorization: KakaoAK <키>`. 제목으로 찾기(`target=title`)도 지원한다.
2. **Claude에게 묻기** — 카카오가 없거나 실패하면 ISBN으로 책을 추정한다(아이가 고칠 수 있다).
3. **직접 적기** — 그래도 없으면 손으로 적는다.

어느 경우든 **표지를 사진으로 찍어** 책장에 남길 수 있고, 바코드가 안 읽히는 책도
`바코드 없이 직접 적을래요`로 등록된다.

### 카카오 REST 키 받는 법
1. https://developers.kakao.com 로그인 → 내 애플리케이션 → 애플리케이션 추가하기
2. 앱 키 화면의 **REST API 키**를 복사
3. 앱에서 부모님 화면 → 설정 → `카카오 책 검색 REST 키`에 붙여넣기

키는 코드에 박혀 있지 않고 설정에만 저장된다. 하루 호출 한도는 넉넉하다.

> **알라딘·네이버 API는 쓸 수 없다.** 두 곳 다 `Access-Control-Allow-Origin` 헤더를
> 보내지 않아 브라우저에서 원천적으로 호출이 막힌다(알라딘은 JSONP도 CORB에 걸린다).
> 프록시 서버를 세우면 가능하지만 이 앱에는 서버가 없다. 카카오는 `Authorization`
> 헤더까지 허용하는 CORS를 정식 지원해서 고른 것이다.

> **카카오 표지 이미지(`thumbnail`)는 표시되지 않을 수 있다.** Artifact CSP가 외부
> 이미지도 막기 때문이다. 그래서 표지는 직접 찍은 사진을 기본으로 삼는다.

---

## 날씨

부모님이 한 번 `📍 자동으로 가져오기`를 누르면 위치를 기억해 매일
Open-Meteo에서 자동으로 채운다(키 불필요). 막히거나 거절하면 날짜 옆 칩을 눌러
아이가 직접 고른다 — 아침에 창밖을 보고 고르는 것 자체가 1학년에게 좋은 활동이다.

---

## 데이터와 백업

기록은 `db`에, 사진은 `assets`에 저장된다. 로그인하지 않고 열면 노란 경고 배너가
뜨고 기록이 저장되지 않는다.

- **백업**: 부모님 화면 → 설정 → `전체 기록 내보내기`
- **샘플 데이터**: 설정에서 넣고 뺄 수 있다. 예시로 넣은 항목은 `sample:true`로
  표시돼 있어 아이가 직접 넣은 기록은 건드리지 않고 한 번에 지운다.

---

## 코드 구조

단일 파일 안에서 역할별로 나뉘어 있다.

| 구역 | 내용 |
|---|---|
| `Store` | `db`가 있으면 db, 없으면 메모리. 모든 쓰기가 여기를 지난다 |
| `connect()` | `claude.use()`로 기능을 붙이고 컬렉션마다 `onSnapshot` 구독 |
| `view*()` | 화면별 HTML 문자열. 상태를 바꾸고 `render()`를 부르면 다시 그린다 |
| `kakaoSearch()` | 카카오 책 검색. 실패 사유(`nokey`/`badkey`/`blocked`…)를 구분해 돌려준다 |
| `lookupWord()` | Claude에게 JSON 스키마를 고정해 묻고 `dict` 컬렉션에 캐시 |
| `seedSample()` / `clearSample()` | 예시 데이터 |

PIN은 아이의 충동을 막는 잠금이지 보안 장치가 아니다(개발자 도구로 우회 가능).
