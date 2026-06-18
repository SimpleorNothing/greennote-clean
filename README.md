# 📋 greennote — 판서 → 확장 문제

판서(칠판) 사진을 올리면 **같은 단원 범위지만 판서에는 없는 내용**으로 복습 문제를 곧바로 만들어 주는 웹 도구.
판서를 그대로 외웠는지가 아니라, 그 단원에서 함께 알아둘 내용까지 점검하는 데 초점을 둔다.

사진은 서버에 저장하지 않고(요청 본문으로만 전달) **Google Gemini Vision**이 읽어 문제를 생성한다.

🔗 배포 후 주소에서 사용

## 동작

1. 판서 사진을 올린다(끌어다 놓거나 눌러서).
2. Gemini Vision이 판서를 읽어 **과목·단원·핵심 요약**을 파악한다.
3. 같은 단원 범위에서 **판서에는 없는** 4지선다 문제 **5개**를 낸다.
4. **한 문제씩** 풀되 채점은 미루고, 각 문제에는 **힌트 보기**가 있다. 보기를 고르고 「다음」으로 넘어간다.
5. **5문제를 다 푼 뒤 「채점하기」로 한 번에 채점**하고, 결과 화면에서 점수와 문항별 정답·해설을 본다.
6. **같은 범위로 새 5문제**로 같은 단원의 다른 문제를 더 받을 수 있다.
6. 문제를 다 풀어 **결과 화면에 도달하면** 올린 판서 이미지를 **R2에 저장**한다(과목·단원·요약·키워드를 `index.json`에 함께 기록).

## 구조

```
greennote/
├─ public/
│  └─ index.html           # 화면 (정적)
├─ src/
│  └─ index.js             # Worker — /api 라우팅 + R2 처리
└─ wrangler.toml           # Worker 설정 (main · assets · R2 바인딩)
```

- 화면(`public/index.html`)은 `/api/...` 만 호출한다.
- Worker(`src/index.js`)가 API를 처리한다:
  - `POST /api/quiz-image`       — 판서 사진(본문 이미지)을 읽어 '같은 범위·판서엔 없는' 문제 생성
  - `POST /api/quiz-more`        — 1차 요약·키워드를 바탕으로 같은 범위의 새 문제 추가 생성(중복 회피)
  - `GET/PUT/DELETE /api/image/{id}` — 판서 사진 (풀이 완료 후 저장)
  - `GET/PUT /api/index`         — 저장된 판서 목록 `index.json`
  - `POST /api/tags`             — (구 노트 기능용 엔드포인트)
- `/api` 외의 경로는 `public/` 의 정적 파일(env.ASSETS)로 서빙된다.
- Gemini 호출은 서버 측 **Worker**가 처리한다 → 브라우저에 API 키가 노출되지 않는다.
- 사진: 업로드 시 1200px·JPEG로 압축해 전송한다. 문제 생성 단계에서는 저장하지 않고, **문제를 다 푼 뒤** R2(`img/{id}`)에 저장한다.

## 배포 (Cloudflare Workers + R2)

1. 이 저장소(`greennote`)를 GitHub에 올린다.
2. Cloudflare 대시보드 → **Workers & Pages**에서 이 저장소를 연결한다(Workers 빌드).
   - 배포 명령(Deploy command): `npx wrangler deploy`
   - 빌드 명령(Build command): 비움
3. R2 버킷이 이미 있다(`greennote`). `wrangler.toml`의 `[[r2_buckets]]` 설정으로 자동 바인딩된다.
   - 변수 이름: `greennote`  /  R2 bucket: `greennote`
4. 배포(또는 Retry deployment)하면 적용된다.

> 풀이 완료 후 판서 이미지 저장에 R2(`/api/image`, `/api/index`)를 쓴다. R2 바인딩이 없어도 문제 생성·풀이 자체는 동작하며, 이때 저장만 실패한다(화면에 안내).

## 도메인

- Worker에 **Custom domains** 로 원하는 주소를 연결한다 (예: `greennote.simpleornothing.com`).
- 같은 Worker에서 화면과 `/api`가 함께 서비스되므로 CORS 설정이 필요 없다.

## 문제 생성 (Gemini Vision)

판서 사진을 올리면 **Google Gemini Vision**(`gemini-2.5-flash`)이 판서를 읽어 과목·단원을 판단하고,
같은 범위에서 **판서에는 없는** 4지선다 문제 5개(각 문제에 힌트·해설 포함)를 만든다.
응답은 `responseMimeType: application/json` 으로 받아 JSON 파싱이 안정적이다.
API 키가 없으면 화면에 안내 배너가 뜨고 문제 생성만 비활성화된다.

### GEMINI_API_KEY 설정

API 키를 코드나 `wrangler.toml`에 직접 넣지 말고 **Cloudflare Secret**으로 관리한다.
키는 [Google AI Studio](https://aistudio.google.com/apikey) 에서 발급한다.

**방법 A — CLI (권장)**
```bash
wrangler secret put GEMINI_API_KEY
# 프롬프트가 뜨면 API 키 붙여넣기 → Enter
```

**방법 B — 대시보드**
Cloudflare 대시보드 → Workers & Pages → `greennote`
→ **Settings** → **Variables and Secrets** → **Add secret**
- 이름: `GEMINI_API_KEY`
- 값: Google AI Studio에서 발급한 API 키

Secret을 설정하면 재배포 없이 바로 적용된다.
API 키가 없으면 `/api/quiz-image` 는 503을 반환하고 화면에 안내가 표시된다.

## 접근 보호 (권장)

이 API에는 로그인이 없어서 주소를 아는 사람은 누구나 읽고 쓸 수 있다.
가족만 쓰려면 **Cloudflare Zero Trust → Access** 로 이 사이트에 이메일 인증을 걸면 코드 수정 없이 보호된다.

## 기술
바닐라 JavaScript · Cloudflare Workers (static assets) · R2 · Pretendard. 외부 빌드·의존성 없음.
