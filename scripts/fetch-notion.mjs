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
      return 0;
    }
    default: return 0;
  }
};

// 롤업/관계가 25개에서 잘렸을 때 전용 엔드포인트로 정확히 다시 조회
const isTruncated = (p) =>
  !!p && (
    (p.type === "rollup"   && p.rollup?.type === "array" && p.rollup.array.length >= 25) ||
    (p.type === "relation" && Array.isArray(p.relation) && p.relation.length >= 25) ||
    (p.type === "rollup"   && p.rollup?.type === "number" && p.rollup.number == null)
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

if (DEBUG && rows[0]) {
  console.log("--- 첫 행 속성 타입 ---");
  for (const [k, v] of Object.entries(rows[0].properties)) {
    console.log(`${k} → ${v.type} :: ${JSON.stringify(v[v.type])}`);
  }
  console.log("----------------------");
}

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

const zero = members.filter(m => m.done === 0).length;
console.log(`${members.length}명 동기화 완료 / 기준 ${updated}`);
if (zero === members.length && members.length > 0) {
  console.warn("⚠ 전원 실적 0입니다. DEBUG=1 로 실행해 속성 타입을 확인하고, 롤업이 참조하는 원본 DB가 integration에 연결됐는지 확인하세요.");
}
