import { writeFile } from "node:fs/promises";

const TOKEN = process.env.NOTION_TOKEN;
const DB_ID = process.env.NOTION_DB_ID;
const DEBUG = process.env.DEBUG === "1";

if (!TOKEN || !DB_ID) {
  console.error("NOTION_TOKEN / NOTION_DB_ID 시크릿이 설정되지 않았습니다.");
  process.exit(1);
}

const HEADERS = {
  "Authorization": `Bearer ${TOKEN}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json"
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 429/5xx 자동 재시도
const request = async (path, options = {}, attempt = 0) => {
  const res = await fetch(`https://api.notion.com/v1/${path}`, { headers: HEADERS, ...options });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 4) throw new Error(`${res.status} ${await res.text()}`);
    const wait = Number(res.headers.get("retry-after") || 0) * 1000 || 500 * 2 ** attempt;
    await sleep(wait);
    return request(path, options, attempt + 1);
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
};

const post = (path, body) => request(path, { method: "POST", body: JSON.stringify(body) });
const get  = (path) => request(path, { method: "GET" });

const toNumber = (v) => {
  const n = parseFloat(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

// 속성 타입에 상관없이 숫자 꺼내기 (롤업 배열은 개수가 아니라 합계)
const num = (p) => {
  if (!p) return 0;
  switch (p.type) {
    case "number":   return p.number ?? 0;
    case "rich_text":return toNumber(p.rich_text?.map(t => t.plain_text).join(""));
    case "title":    return toNumber(p.title?.map(t => t.plain_text).join(""));
    case "select":   return toNumber(p.select?.name);
    case "relation": return Array.isArray(p.relation) ? p.relation.length : 0;
    case "checkbox": return p.checkbox ? 1 : 0;
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
      // "incomplete": DB 쿼리 시점에 롤업이 아직 계산되지 않아 값이 비어 오는
      // Notion API의 알려진 동작. isTruncated()가 이를 감지해 numDeep()에서
      // 속성 전용 엔드포인트로 재조회하므로 여기서는 0으로 처리(재조회 전 임시값).
      return 0;
    }
    default: return 0;
  }
};

// 아래 두 경우엔 DB 쿼리 응답만으로 정확한 값을 알 수 없어
// 속성 전용 엔드포인트(pages/{id}/properties/{prop_id})로 다시 조회해야 함:
//  1) 롤업/관계가 25개 이상이라 배열이 페이지당 잘려서 온 경우
//  2) 롤업이 "incomplete" 상태 - Notion이 DB 쿼리 시점엔 관계형 롤업 계산을
//     끝내지 못해 값 없이 반환하는 경우가 있음(문서화되지 않은 동작).
//     이걸 처리하지 않으면 rollup 기반 실적/진행중 값이 항상 0으로 나온다.
const isTruncated = (p) =>
  !!p && (
    (p.type === "rollup"   && p.rollup?.type === "array" && p.rollup.array.length >= 25) ||
    (p.type === "relation" && Array.isArray(p.relation) && p.relation.length >= 25) ||
    (p.type === "rollup"   && p.rollup?.type === "number" && p.rollup.number == null) ||
    (p.type === "rollup"   && p.rollup?.type === "incomplete")
  );

const numDeep = async (pageId, p) => {
  if (!p) return 0;
  if (!isTruncated(p)) return num(p);
  try {
    let total = 0, cursor, aggregate = null;
    do {
      const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : "?page_size=100";
      const data = await get(`pages/${pageId}/properties/${encodeURIComponent(p.id)}${qs}`);
      if (data.object !== "list") return num(data);           // 단일 값 응답
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

// 공백/괄호 무시하고 컬럼명 매칭
const normalize = (s) => s.replace(/[\s()（）]/g, "");
const pick = (props, ...keys) => {
  const found = Object.keys(props).find(k => keys.some(w => normalize(k).includes(normalize(w))));
  if (!found) console.warn(`속성 못 찾음: [${keys.join(", ")}] / 실제 키: ${Object.keys(props).join(" | ")}`);
  return found ? props[found] : null;
};

// 전체 행 수집 (페이지네이션)
let rows = [], cursor;
do {
  const data = await post(`databases/${DB_ID}/query`, {
    page_size: 100,
    ...(cursor ? { start_cursor: cursor } : {})
  });
  rows.push(...data.results);
  cursor = data.has_more ? data.next_cursor : null;
} while (cursor);

const dumpRow = (row) => {
  console.log(`--- "${title(row.properties)}" 행 속성 타입 ---`);
  for (const [k, v] of Object.entries(row.properties)) {
    console.log(`${k} → ${v.type} :: ${JSON.stringify(v[v.type])}`);
  }
  console.log("----------------------");
};

if (DEBUG && rows[0]) dumpRow(rows[0]);

const members = [];
for (const r of rows) {
  const name = title(r.properties);
  if (!name) continue;
  const [goal, done, inProgress, order] = await Promise.all([
    numDeep(r.id, pick(r.properties, "목표")),
    numDeep(r.id, pick(r.properties, "실적")),
    numDeep(r.id, pick(r.properties, "진행중", "진행 중")),
    numDeep(r.id, pick(r.properties, "순서"))
  ]);
  members.push({ name, goal, done, inProgress, order });
}
members.sort((a, b) => (a.order || 999) - (b.order || 999));

const updated = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false
}).format(new Date()).replace(/\. /g, ".").replace(/\.$/, "");

await writeFile("data.json", JSON.stringify({ updated, members }, null, 2) + "\n", "utf8");

const zero = members.filter(m => m.done === 0 && m.inProgress === 0).length;
console.log(`${members.length}명 동기화 완료 / 기준 ${updated}`);
if (zero === members.length && members.length > 0) {
  console.warn("⚠ 전원 실적/진행중이 0입니다. 원본 속성 구조를 자동 출력합니다 (DEBUG 없이도 확인 가능):");
  if (rows[0]) dumpRow(rows[0]);
  console.warn("→ 위 목록에서 '실적'/'진행중' 관련 컬럼의 type과 실제 값을 확인하세요.");
  console.warn("  - rollup인데 값이 null/빈 배열이면: 롤업이 참조하는 원본 관계형 DB가 이 integration에 연결(Share)되지 않았을 가능성이 높습니다.");
  console.warn("  - formula/rollup 결과 타입이 date/string 등 숫자가 아니면 집계 로직 보완이 필요합니다.");
}
