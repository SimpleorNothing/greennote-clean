// Cloudflare Worker (static assets + R2)
//   GET    /api/index       → R2의 index.json 반환 (없으면 빈 배열)
//   PUT    /api/index       → 요청 본문(JSON)을 index.json 으로 저장
//   GET    /api/image/{id}  → R2에서 사진 반환
//   PUT    /api/image/{id}  → 사진 업로드 (본문: 이미지 바이너리)
//   DELETE /api/image/{id}  → 사진 삭제
//   POST   /api/tags        → 이미지 바이너리를 받아 Claude Vision으로 한국어 태그 자동 생성
// 그 외 경로는 public/ 의 정적 파일(env.ASSETS)로 처리된다.
// R2 버킷 binding 이름은 "greennote".
// ANTHROPIC_API_KEY 는 Cloudflare Secret 으로 주입
//   → wrangler secret put ANTHROPIC_API_KEY

function imgKey(id) {
  const clean = String(id || "").replace(/[^a-z0-9]/gi, ""); // 경로 조작 방지
  return clean ? "img/" + clean : null;
}

async function handleIndex(request, env) {
  if (request.method === "GET") {
    const obj = await env.greennote.get("index.json");
    const body = obj ? obj.body : "[]";
    return new Response(body, {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  if (request.method === "PUT") {
    const text = await request.text();
    try { JSON.parse(text); } catch { return new Response("invalid json", { status: 400 }); }
    await env.greennote.put("index.json", text, {
      httpMetadata: { contentType: "application/json" },
    });
    return new Response("ok");
  }
  return new Response("method not allowed", { status: 405 });
}

async function handleImage(request, env, id) {
  const k = imgKey(id);
  if (!k) return new Response("bad id", { status: 400 });

  if (request.method === "GET") {
    const obj = await env.greennote.get(k);
    if (!obj) return new Response("not found", { status: 404 });
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("cache-control", "public, max-age=31536000, immutable");
    return new Response(obj.body, { headers });
  }
  if (request.method === "PUT") {
    const data = await request.arrayBuffer();
    await env.greennote.put(k, data, {
      httpMetadata: { contentType: request.headers.get("content-type") || "image/jpeg" },
    });
    return new Response("ok");
  }
  if (request.method === "DELETE") {
    await env.greennote.delete(k);
    return new Response("ok");
  }
  return new Response("method not allowed", { status: 405 });
}

// ArrayBuffer → base64 (Cloudflare Workers V8 환경용, btoa 활용)
function arrayBufferToBase64(buffer) {
  const uint8 = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < uint8.length; i += CHUNK) {
    binary += String.fromCharCode(...uint8.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// POST /api/tags — 이미지 바이너리를 받아 Claude Vision으로 한국어 태그 3개 반환
// ANTHROPIC_API_KEY 가 없으면 { tags: [] } 를 반환 (기능 비활성 상태, 업로드는 정상 동작)
async function handleTags(request, env) {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // API 키 없으면 조용히 빈 태그 반환
  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ tags: [] }), {
      headers: { "content-type": "application/json" },
    });
  }

  try {
    const imageBuffer = await request.arrayBuffer();
    const contentType = request.headers.get("content-type") || "image/jpeg";
    const base64Image = arrayBufferToBase64(imageBuffer);

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: contentType,
                  data: base64Image,
                },
              },
              {
                type: "text",
                text: '이 칠판 필기 사진을 보고 세부 주제를 나타내는 한국어 해시태그를 3개 내외로 생성하세요. 규칙: (1) 과목명(국어·영어·수학·한국사·사회·과학 등)은 태그에 넣지 마세요. (2) 각 태그는 띄어쓰기 없이 한 단어로 만드세요. (3) # 없이 태그 텍스트만, JSON 배열로만 응답하고 다른 텍스트는 출력하지 마세요. 예시: ["조선후기","붕당정치","탕평책"]',
              },
            ],
          },
        ],
      }),
    });

    if (!anthropicRes.ok) {
      console.error("Anthropic API error:", anthropicRes.status, await anthropicRes.text());
      return new Response(JSON.stringify({ tags: [] }), {
        headers: { "content-type": "application/json" },
      });
    }

    const data = await anthropicRes.json();
    const text = (data.content?.[0]?.text || "").trim();

    // 응답에서 JSON 배열 안전 파싱
    let tags = [];
    try {
      const match = text.match(/\[[\s\S]*?\]/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) {
          const SUBJECTS = ["국어", "영어", "수학", "한국사", "사회", "과학", "기타"];
          tags = parsed
            .filter((t) => typeof t === "string")
            .map((t) => t.trim().replace(/^#+/, "").replace(/\s+/g, ""))
            .filter((t) => t && !SUBJECTS.includes(t))
            .slice(0, 3);
        }
      }
    } catch (_) {}

    return new Response(JSON.stringify({ tags }), {
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    console.error("handleTags error:", e);
    return new Response(JSON.stringify({ tags: [] }), {
      headers: { "content-type": "application/json" },
    });
  }
}

// POST /api/quiz/{id} — R2의 칠판 사진(img/{id})을 Claude Vision으로 읽어
// 핵심 요약·키워드·복습 문제(객관식/단답/OX)를 JSON으로 생성한다.
// ANTHROPIC_API_KEY 가 없으면 503 을 반환한다 (퀴즈 기능만 비활성, 나머지는 정상 동작).
const QUIZ_MODEL = "claude-sonnet-4-20250514";

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function buildQuizPrompt(subject, level, count) {
  return [
    `너는 한국 고등학생의 공부를 돕는 출제 선생님이다. 첨부한 사진은 학생이 칠판(또는 노트)에 정리한 ${subject} 필기다. 손글씨를 최대한 정확히 읽어라.`,
    `1) 핵심 내용을 2~3문장으로 요약하고, 핵심 키워드 3~6개를 뽑아라.`,
    `2) ${level} 수준에 맞춰 복습용 문제 ${count}개를 만들어라. 유형은 객관식(choice, 4지선다)·단답형(short)·OX(ox)를 골고루 섞어라.`,
    `각 문제에 정답과 한 문장 해설을 붙여라. 사진에서 읽히는 내용만 근거로 출제하고, 사진에 없으면 지어내지 마라.`,
    ``,
    `반드시 아래 JSON 하나만 출력하라. 코드펜스·설명 금지.`,
    `{"summary":"요약","keywords":["키워드"],"questions":[{"type":"choice|short|ox","question":"문제","choices":["①..","②..","③..","④.."],"answer":"정답(객관식은 번호기호, OX는 O 또는 X)","explanation":"한 문장 해설"}]}`,
    `choices는 choice일 때만 채우고 short·ox에서는 빈 배열 []로 둬라.`,
  ].join("\n");
}

function parseQuizJSON(t) {
  if (!t) return null;
  t = t.replace(/```json/gi, "").replace(/```/g, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s === -1 || e === -1) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch (_) { return null; }
}

async function handleQuiz(request, env, id) {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const k = imgKey(id);
  if (!k) return jsonResponse({ error: "bad id" }, 400);

  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY가 설정되지 않았습니다." }, 503);
  }

  let opt = {};
  try { opt = await request.json(); } catch (_) {}
  const subject = opt.subject || "공부 내용";
  const level   = opt.level   || "고2";
  const count   = Math.min(Math.max(parseInt(opt.count, 10) || 3, 1), 10);

  const obj = await env.greennote.get(k);
  if (!obj) return jsonResponse({ error: "이미지를 찾을 수 없습니다." }, 404);

  const b64 = arrayBufferToBase64(await obj.arrayBuffer());
  let mediaType = obj.httpMetadata?.contentType || "image/jpeg";
  if (!/^image\/(jpeg|png|gif|webp)$/.test(mediaType)) mediaType = "image/jpeg";

  const prompt = buildQuizPrompt(subject, level, count);

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: QUIZ_MODEL,
        max_tokens: 2000,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
          { type: "text", text: prompt },
        ]}],
      }),
    });
  } catch (e) {
    return jsonResponse({ error: "모델 호출 중 네트워크 오류", detail: String(e).slice(0, 300) }, 502);
  }

  if (!res.ok) {
    const t = await res.text();
    return jsonResponse({ error: `모델 호출 실패 (${res.status})`, detail: t.slice(0, 300) }, 502);
  }

  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  const parsed = parseQuizJSON(text);
  if (!parsed || !Array.isArray(parsed.questions)) {
    return jsonResponse({ error: "문제 생성 결과를 해석하지 못했습니다." }, 502);
  }
  return jsonResponse(parsed, 200);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/index") return handleIndex(request, env);
    if (pathname === "/api/tags")  return handleTags(request, env);

    const quizPrefix = "/api/quiz/";
    if (pathname.startsWith(quizPrefix)) {
      return handleQuiz(request, env, pathname.slice(quizPrefix.length));
    }

    const imgPrefix = "/api/image/";
    if (pathname.startsWith(imgPrefix)) {
      return handleImage(request, env, pathname.slice(imgPrefix.length));
    }

    return env.ASSETS.fetch(request);
  },
};
