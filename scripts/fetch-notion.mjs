import { writeFile } from "node:fs/promises";

const TOKEN   = process.env.NOTION_TOKEN;
const ROOT_DS = process.env.NOTION_DATA_SOURCE_ID || "3b11fd97-2c80-8056-82f1-000b39c28f42";
const VERSION = "2025-09-03";
const MAX_DEPTH = 6;

if (!TOKEN) { console.error("NOTION_TOKEN 이 없습니다."); process.exit(1); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const api = async (path, opt = {}, attempt = 0) => {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    ...opt,
    headers: { Authorization: `Bearer ${TOKEN}`, "Notion-Version": VERSION, "Content-Type": "application/json" }
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 4) throw new Error(`${res.status} ${await res.text()}`);
    await sleep(Number(res.headers.get("retry-after") || 0) * 1000 || 500 * 2 ** attempt);
    return api(path, opt, attempt + 1);
  }
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${await res.text()}`), { status: res.status });
  return res.json();
};
const get  = (p) => api(p);
const post = (p, b) => api(p, { method: "POST", body: JSON.stringify(b) });

const mapLimit = async (items, limit, fn) => {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
};

// ── 캐시 ───────────────────────────────────────────────────────────────────
const schemaCache = new Map();   // dsId → properties
const pageCache   = new Map();   // pageId → page
const prefetched  = new Set();   // 통째로 읽어둔 dsId

const schemaOf = async (dsId) => {
  if (!schemaCache.has(dsId)) {
    const ds = await get(`data_sources/${dsId}`);
    schemaCache.set(dsId, ds.properties ?? {});
  }
  return schemaCache.get(dsId);
};

const queryAll = async (dsId) => {
  const rows = []; let cursor;
  do {
    const d = await post(`data_sources/${dsId}/query`,
      { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    rows.push(...d.results);
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);
  return rows;
};

// 자식 페이지를 한 건씩 가져오지 않고 데이터 소스 단위로 한 번에 캐싱
const prefetchDs = async (dsId) => {
  if (prefetched.has(dsId)) return;
  prefetched.add(dsId);
  try {
    for (const pg of await queryAll(dsId)) pageCache.set(pg.id, pg);
  } catch (e) { console.warn(`프리페치 실패 ${dsId}: ${e.message}`); }
};

const pageOf = async (pageId, dsHint) => {
  if (pageCache.has(pageId)) return pageCache.get(pageId);
  if (dsHint) { await prefetchDs(dsHint); if (pageCache.has(pageId)) return pageCache.get(pageId); }
  try {
    const pg = await get(`pages/${pageId}`);
    pageCache.set(pageId, pg);
    return pg;
  } catch { return null; }
};

// ── 유틸 ───────────────────────────────────────────────────────────────────
const plain = (a) => (Array.isArray(a) ? a.map(t => t.plain_text).join("") : a?.plain_text ?? "");
const titleOf = (props) => {
  const t = Object.values(props).find(p => p.type === "title");
  return t ? plain(t.title).trim() : "";
};
const normalize = (s) => String(s).replace(/[\s()（）]/g, "").toLowerCase();
const findKey = (obj, name) =>
  Object.keys(obj).find(k => k === name) ??
  Object.keys(obj).find(k => normalize(k) === normalize(name)) ??
  Object.keys(obj).find(k => normalize(k).includes(normalize(name)));

const dsIdOfPage = (page) => page?.parent?.data_source_id ?? null;

const relationIds = async (page, prop) => {
  if (Array.isArray(prop.relation) && prop.relation.length < 25) return prop.relation.map(r => r.id);
  const ids = []; let cursor;
  do {
    const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : "?page_size=100";
    const d = await get(`pages/${page.id}/properties/${encodeURIComponent(prop.id)}${qs}`);
    for (const it of d.results ?? []) if (it.type === "relation") ids.push(it.relation.id);
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);
  return ids;
};

const aggregate = (fn, values) => {
  const nums = values.filter(v => Number.isFinite(v));
  switch (fn) {
    case "sum": return nums.reduce((s, v) => s + v, 0);
    case "average": return nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : 0;
    case "min": return nums.length ? Math.min(...nums) : 0;
    case "max": return nums.length ? Math.max(...nums) : 0;
    case "count": case "count_values": return values.length;
    case "empty": return values.filter(v => !v).length;
    case "not_empty": return values.filter(v => !!v).length;
    default: return nums.reduce((s, v) => s + v, 0);
  }
};

// ── 값 해석: 수식은 API 값 신뢰, 중첩 롤업만 직접 계산 ──────────────────────
const resolveValue = async (page, propName, depth = 0) => {
  if (!page || depth > MAX_DEPTH) return 0;
  const props = page.properties ?? {};
  const key = findKey(props, propName);
  if (!key) return 0;
  const p = props[key];
  const dsId = dsIdOfPage(page);
  const schema = dsId ? await schemaOf(dsId).catch(() => ({})) : {};
  const def = schema[key] ?? p;

  switch (p.type) {
    case "number":   return p.number ?? 0;
    case "checkbox": return p.checkbox ? 1 : 0;
    case "rich_text":
    case "title":    return parseFloat(String(plain(p[p.type])).replace(/[^\d.-]/g, "")) || 0;
    case "select":   return parseFloat(String(p.select?.name ?? "").replace(/[^\d.-]/g, "")) || 0;
    case "relation": return (await relationIds(page, p)).length;

    case "formula": {
      // 자식 레벨 수식은 Notion이 정상 계산해 주므로 그대로 사용한다.
      const f = p.formula ?? {};
      if (f.type === "number")  return f.number ?? 0;
      if (f.type === "boolean") return f.boolean ? 1 : 0;
      if (f.type === "string")  return parseFloat(String(f.string).replace(/[^\d.-]/g, "")) || 0;
      return 0;
    }

    case "rollup": {
      const cfg = def?.rollup ?? p.rollup ?? {};
      const relName = cfg.relation_property_name;
      const tgtName = cfg.rollup_property_name;
      const fn = cfg.function ?? "sum";

      const r = p.rollup ?? {};
      if (r.type === "number" && r.number) return r.number;   // 0이 아닌 값이면 신뢰

      // 중첩이라 API가 0을 준 경우: 관계를 펼쳐 자식 값을 직접 집계
      if (relName && tgtName) {
        const relKey = findKey(props, relName);
        if (relKey && props[relKey].type === "relation") {
          const ids = await relationIds(page, props[relKey]);
          const targetDs = schema[relKey]?.relation?.data_source_id;
          if (targetDs) await prefetchDs(targetDs);
          const vals = await mapLimit(ids, 3, async (id) => {
            const child = await pageOf(id, targetDs);
            return child ? await resolveValue(child, tgtName, depth + 1) : NaN;
          });
          const out = aggregate(fn, vals);
          if (depth === 0) console.log(`    ↳ ${key}: ${ids.length}건 → [${vals.join(", ")}] = ${out}`);
          return out;
        }
      }
      if (r.type === "array") {
        return aggregate(fn, r.array.map(it => it.type === "number" ? it.number ?? 0 : 0));
      }
      return 0;
    }

    default: return 0;
  }
};

// ── 실행 ───────────────────────────────────────────────────────────────────
await schemaOf(ROOT_DS);
const rows = (await queryAll(ROOT_DS)).filter(r => titleOf(r.properties));
rows.forEach(r => pageCache.set(r.id, r));
console.log(`${rows.length}행 수집 (${ROOT_DS})`);

const members = (await mapLimit(rows, 2, async (r) => {
  const name = titleOf(r.properties);
  console.log(`[${name}]`);
  const goal       = await resolveValue(r, "목표(Set)");
  const done       = await resolveValue(r, "실적(Set)");
  const inProgress = await resolveValue(r, "진행중(Set)");
  const order      = await resolveValue(r, "순서");
  return { name, goal, done, inProgress, order, rate: goal ? Math.round((done / goal) * 100) : 0 };
})).sort((a, b) => (a.order || 999) - (b.order || 999));

const updated = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false
}).format(new Date()).replace(/\. /g, ".").replace(/\.$/, "");

console.log(`\n기준 ${updated}`);
members.forEach(m =>
  console.log(`  ${m.order}. ${m.name}  목표 ${m.goal} / 실적 ${m.done} / 진행중 ${m.inProgress} (${m.rate}%)`));

// 전원 0이면 기존 data.json 을 보존하고 실패 처리
if (members.length && members.every(m => m.done === 0 && m.inProgress === 0) && members.some(m => m.goal > 0)) {
  console.error("실적이 전원 0 → data.json 갱신을 중단합니다(기존 데이터 보존).");
  process.exit(1);
}

await writeFile("data.json", JSON.stringify({ updated, members }, null, 2) + "\n", "utf8");
console.log(`${members.length}명 동기화 완료`);
