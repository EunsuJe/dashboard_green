import { writeFile } from "node:fs/promises";

// ── 대상: https://app.notion.com/p/3b11fd972c80807589b1dfe336b24d10?v=...
const DEFAULT_URL =
  "https://app.notion.com/p/3b11fd972c80807589b1dfe336b24d10?v=3b11fd972c8080938176000cd8c76dac";

const TOKEN     = process.env.NOTION_TOKEN;
const RAW_REF   = process.env.NOTION_DB_ID || process.env.NOTION_URL || DEFAULT_URL;
const DS_ENV    = process.env.NOTION_DATA_SOURCE_ID || "";   // 있으면 탐색 생략
const DEBUG     = process.env.DEBUG === "1";

const V_NEW = "2025-09-03";   // 데이터 소스 분리 이후
const V_OLD = "2022-06-28";   // 폴백용

if (!TOKEN) {
  console.error("NOTION_TOKEN 시크릿이 설정되지 않았습니다.");
  process.exit(1);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// URL / 하이픈 없는 ID / 하이픈 있는 ID 모두 허용
const toId = (ref) => {
  const m = String(ref).match(/[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!m) throw new Error(`ID를 추출할 수 없습니다: ${ref}`);
  const h = m[0].replace(/-/g, "").toLowerCase();
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
};

// ── HTTP (429/5xx 재시도 + 버전 지정 가능)
const request = async (path, { version = V_NEW, ...options } = {}, attempt = 0) => {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Notion-Version": version,
      "Content-Type": "application/json"
    }
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 4) throw new Error(`${res.status} ${await res.text()}`);
    const wait = Number(res.headers.get("retry-after") || 0) * 1000 || 500 * 2 ** attempt;
    await sleep(wait);
    return request(path, { version, ...options }, attempt + 1);
  }
  if (!res.ok) {
    const err = new Error(`${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
};

const post = (path, body, version) => request(path, { method: "POST", body: JSON.stringify(body), version });
const get  = (path, version) => request(path, { method: "GET", version });

// 동시 요청 제한 (Notion 권장 ~3 rps)
const mapLimit = async (items, limit, fn) => {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
};

// ── 값 추출
const toNumber = (v) => {
  const n = parseFloat(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const num = (p) => {
  if (!p) return 0;
  switch (p.type) {
    case "number":    return p.number ?? 0;
    case "rich_text": return toNumber((p.rich_text?.map?.(t => t.plain_text) ?? [p.rich_text?.plain_text]).join(""));
    case "title":     return toNumber((p.title?.map?.(t => t.plain_text) ?? [p.title?.plain_text]).join(""));
    case "select":    return toNumber(p.select?.name);
    // DB 쿼리 응답은 배열, 속성 엔드포인트 응답은 단일 객체 → 둘 다 처리
    case "relation":  return Array.isArray(p.relation) ? p.relation.length : (p.relation ? 1 : 0);
    case "checkbox":  return p.checkbox ? 1 : 0;
    case "formula": {
      const f = p.formula ?? {};
      if (f.type === "number")  return f.number ?? 0;
      if (f.type === "string")  return toNumber(f.string);
      if (f.type === "boolean") return f.boolean ? 1 : 0;
      return 0;
    }
    case "rollup": {
      const r = p.rollup ?? {};
      if (r.type === "number") return r.number ?? 0;
      if (r.type === "array")  return r.array.reduce((s, it) => s + num(it), 0);
      return 0; // incomplete → numDeep에서 재조회
    }
    default: return 0;
  }
};

// 쿼리 응답만으로 정확한 값을 알 수 없어 pages/{id}/properties/{prop_id} 재조회가 필요한 경우
const isTruncated = (p) =>
  !!p && (
    (p.type === "rollup"   && p.rollup?.type === "array" && p.rollup.array.length >= 25) ||
    (p.type === "relation" && Array.isArray(p.relation) && p.relation.length >= 25) ||
    (p.type === "rollup"   && p.rollup?.type === "number" && p.rollup.number == null) ||
    (p.type === "rollup"   && p.rollup?.type === "incomplete") ||
    (p.type === "formula")   // 롤업 참조 수식은 쿼리 시점 값이 낡아 있을 수 있음
  );

const numDeep = async (pageId, p) => {
  if (!p) return 0;
  if (!isTruncated(p)) return num(p);
  try {
    let total = 0, cursor, aggregate = null;
    do {
      const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : "?page_size=100";
      const data = await get(`pages/${pageId}/properties/${encodeURIComponent(p.id)}${qs}`);
      if (data.object !== "list") return num(data);
      total += data.results.reduce((s, it) => s + num(it), 0);
      const agg = data.property_item?.rollup;
      if (agg && agg.type === "number" && agg.number != null) aggregate = agg.number;
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);
    return aggregate ?? total;
  } catch (e) {
    console.warn(`속성 재조회 실패(${p.id}): ${e.message}`);
    return num(p);
  }
};

const title = (props) => {
  const t = Object.values(props).find(p => p.type === "title");
  return t ? t.title.map(x => x.plain_text).join("").trim() : "";
};

const normalize = (s) => s.replace(/[\s()（）]/g, "");
const pick = (props, ...keys) => {
  const found = Object.keys(props).find(k => keys.some(w => normalize(k).includes(normalize(w))));
  if (!found) console.warn(`속성 못 찾음: [${keys.join(", ")}] / 실제 키: ${Object.keys(props).join(" | ")}`);
  return found ? props[found] : null;
};

// ── 1) URL의 ID → data_source_id 해석
const resolveSource = async (ref) => {
  const id = toId(ref);
  if (DS_ENV) return { mode: "data_source", id: toId(DS_ENV) };

  // (a) 데이터베이스로 시도
  try {
    const db = await get(`databases/${id}`, V_NEW);
    const list = db.data_sources ?? [];
    if (list.length > 1) {
      console.warn(`데이터 소스가 ${list.length}개입니다. 첫 번째(${list[0].name})를 사용합니다. ` +
                   `다른 소스를 쓰려면 NOTION_DATA_SOURCE_ID를 지정하세요.`);
      list.forEach(d => console.warn(`  - ${d.name}: ${d.id}`));
    }
    if (list.length) return { mode: "data_source", id: list[0].id, dbTitle: db.title?.[0]?.plain_text };
    return { mode: "database", id }; // 구형 응답(데이터 소스 미분리)
  } catch (e) {
    if (e.status !== 404 && e.status !== 400) throw e;
  }

  // (b) 페이지로 보고 자식 블록에서 인라인 DB 찾기
  try {
    let cursor;
    do {
      const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : "?page_size=100";
      const kids = await get(`blocks/${id}/children${qs}`, V_NEW);
      const child = kids.results.find(b => b.type === "child_database");
      if (child) return resolveSource(child.id);
      cursor = kids.has_more ? kids.next_cursor : null;
    } while (cursor);
  } catch { /* 아래 안내로 */ }

  throw new Error(
    `대상을 찾을 수 없습니다(${id}).\n` +
    `→ Notion에서 해당 DB의 ••• 메뉴 > 연결(Connections)에서 통합을 초대했는지 확인하세요.\n` +
    `→ 또는 DB 설정 > 데이터 소스 관리 > "데이터 소스 ID 복사"로 얻은 값을 ` +
    `NOTION_DATA_SOURCE_ID 시크릿에 넣어주세요.`
  );
};

const src = await resolveSource(RAW_REF);
console.log(`대상: ${src.mode} ${src.id}${src.dbTitle ? ` (${src.dbTitle})` : ""}`);

// ── 2) 전체 행 수집 (신 엔드포인트 우선, 실패 시 구 엔드포인트 폴백)
const queryAll = async () => {
  const attempts = src.mode === "data_source"
    ? [{ path: `data_sources/${src.id}/query`, version: V_NEW },
       { path: `databases/${toId(RAW_REF)}/query`, version: V_OLD }]
    : [{ path: `databases/${src.id}/query`, version: V_OLD }];

  for (const [i, a] of attempts.entries()) {
    try {
      const rows = [];
      let cursor;
      do {
        const data = await post(a.path, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }, a.version);
        rows.push(...data.results);
        cursor = data.has_more ? data.next_cursor : null;
      } while (cursor);
      if (i > 0) console.warn(`구버전 엔드포인트(${a.version})로 폴백했습니다.`);
      return rows;
    } catch (e) {
      if (i === attempts.length - 1) throw e;
      console.warn(`${a.path} 실패(${e.message}) → 폴백 시도`);
    }
  }
};

const rows = await queryAll();

const dumpRow = (row) => {
  console.log(`--- "${title(row.properties)}" 행 속성 타입 ---`);
  for (const [k, v] of Object.entries(row.properties)) {
    console.log(`${k} → ${v.type} :: ${JSON.stringify(v[v.type])}`);
  }
  console.log("----------------------");
};
if (DEBUG && rows[0]) dumpRow(rows[0]);

// ── 3) 값 계산 (행 4개씩 병렬 = 최대 4 요청 동시)
const members = (await mapLimit(rows.filter(r => title(r.properties)), 4, async (r) => {
  const name = title(r.properties);
  const [goal, done, inProgress, order] = await Promise.all([
    numDeep(r.id, pick(r.properties, "목표")),
    numDeep(r.id, pick(r.properties, "실적")),
    numDeep(r.id, pick(r.properties, "진행중", "진행 중")),
    numDeep(r.id, pick(r.properties, "순서"))
  ]);
  return { name, goal, done, inProgress, order };
})).sort((a, b) => (a.order || 999) - (b.order || 999));

const updated = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false
}).format(new Date()).replace(/\. /g, ".").replace(/\.$/, "");

await writeFile("data.json",
  JSON.stringify({ updated, source: { mode: src.mode, id: src.id }, members }, null, 2) + "\n", "utf8");

const zero = members.filter(m => m.done === 0 && m.inProgress === 0).length;
console.log(`${members.length}명 동기화 완료 / 기준 ${updated}`);
if (members.length > 0 && zero === members.length) {
  console.warn("⚠ 전원 실적/진행중이 0입니다. 원본 속성 구조를 출력합니다:");
  if (rows[0]) dumpRow(rows[0]);
  console.warn("→ formula/rollup은 속성 전용 엔드포인트로 재조회하고 있으니, 여전히 0이면 Notion 원본 수식을 확인하세요.");
}
