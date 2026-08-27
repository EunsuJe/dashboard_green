import { writeFile } from "node:fs/promises";

const DEFAULT_URL =
  "https://app.notion.com/p/3b11fd972c80807589b1dfe336b24d10?v=3b11fd972c8080938176000cd8c76dac";

const TOKEN    = process.env.NOTION_TOKEN;
const RAW_REF  = process.env.NOTION_DB_ID || process.env.NOTION_URL || DEFAULT_URL;
const DS_ENV   = process.env.NOTION_DATA_SOURCE_ID || "";
const REL_PROP = process.env.RELATION_PROP || "직원";   // 폴백 계산에 쓸 관계 컬럼
const DIAGNOSE = process.env.DIAGNOSE === "1";
const VERSION  = process.env.NOTION_VERSION || "2025-09-03";

if (!TOKEN) { console.error("NOTION_TOKEN 이 없습니다."); process.exit(1); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const toId = (ref) => {
  const m = String(ref).match(/[0-9a-f]{32}|[0-9a-f-]{36}/i);
  if (!m) throw new Error(`ID 추출 실패: ${ref}`);
  const h = m[0].replace(/-/g, "").toLowerCase();
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
};

const request = async (path, { version = VERSION, ...opt } = {}, attempt = 0) => {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    ...opt,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Notion-Version": version,
      "Content-Type": "application/json"
    }
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 4) throw Object.assign(new Error(`${res.status} ${await res.text()}`), { status: res.status });
    const wait = Number(res.headers.get("retry-after") || 0) * 1000 || 500 * 2 ** attempt;
    await sleep(wait);
    return request(path, { version, ...opt }, attempt + 1);
  }
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${await res.text()}`), { status: res.status });
  return res.json();
};
const post = (p, b, v) => request(p, { method: "POST", body: JSON.stringify(b), version: v });
const get  = (p, v) => request(p, { method: "GET", version: v });

const mapLimit = async (items, limit, fn) => {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
};

// ── 값 파싱: 반드시 {ok, value} 로 반환해 "못 읽음"과 "진짜 0"을 구분한다 ──────────
const FAIL = (reason) => ({ ok: false, value: 0, reason });
const OK   = (value)  => ({ ok: true, value });

const parseNum = (v) => {
  const n = parseFloat(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const plain = (arr) => (Array.isArray(arr) ? arr.map(t => t.plain_text).join("") : arr?.plain_text ?? "");

// 재조회 없이 즉시 판정 가능한 값
const readShallow = (p) => {
  if (!p) return FAIL("속성 없음");
  switch (p.type) {
    case "number":    return p.number == null ? OK(0) : OK(p.number);
    case "checkbox":  return OK(p.checkbox ? 1 : 0);
    case "rich_text":
    case "title": {
      const n = parseNum(plain(p[p.type]));
      return n == null ? FAIL("숫자 아님") : OK(n);
    }
    case "select":    { const n = parseNum(p.select?.name); return n == null ? FAIL("숫자 아님") : OK(n); }
    case "relation":  return Array.isArray(p.relation) ? OK(p.relation.length) : (p.relation ? OK(1) : OK(0));
    case "formula": {
      const f = p.formula ?? {};
      if (f.type === "number")      return f.number == null ? FAIL("formula number=null") : OK(f.number);
      if (f.type === "boolean")     return OK(f.boolean ? 1 : 0);
      if (f.type === "string")      { const n = parseNum(f.string); return n == null ? FAIL("formula 문자열") : OK(n); }
      if (f.type === "unsupported") return FAIL("formula unsupported (롤업 중첩 → API 계산 불가)");
      return FAIL(`formula ${f.type}`);
    }
    case "rollup": {
      const r = p.rollup ?? {};
      if (r.type === "number")      return r.number == null ? FAIL("rollup number=null") : OK(r.number);
      if (r.type === "unsupported") return FAIL("rollup unsupported");
      if (r.type === "incomplete")  return FAIL("rollup incomplete");
      if (r.type === "array") {
        if (r.array.length >= 25) return FAIL("rollup array 25개 절단");
        let sum = 0;
        for (const it of r.array) { const v = readShallow(it); if (v.ok) sum += v.value; }
        return OK(sum);
      }
      return FAIL(`rollup ${r.type}`);
    }
    default: return FAIL(`미지원 타입 ${p.type}`);
  }
};

// 속성 전용 엔드포인트 재조회. 롤업은 results 합계가 아니라 property_item.rollup 을 본다.
const readDeep = async (pageId, p) => {
  const first = readShallow(p);
  if (first.ok) return first;
  if (!["formula", "rollup", "relation"].includes(p?.type)) return first;

  try {
    let cursor, lastRollup = null, listSum = 0, sawList = false;
    do {
      const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : "?page_size=100";
      const data = await get(`pages/${pageId}/properties/${encodeURIComponent(p.id)}${qs}`);
      if (data.object !== "list") return readShallow(data);      // 단일 값 응답(수식 등)
      sawList = true;
      for (const it of data.results) { const v = readShallow(it); if (v.ok) listSum += v.value; }
      if (data.property_item?.type === "rollup") lastRollup = data.property_item.rollup;
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);

    if (lastRollup) {
      if (lastRollup.type === "number" && lastRollup.number != null) return OK(lastRollup.number);
      if (lastRollup.type === "unsupported") return FAIL("rollup unsupported (재조회 후에도)");
    }
    return sawList ? OK(listSum) : first;
  } catch (e) {
    return FAIL(`재조회 실패: ${e.message}`);
  }
};

const titleOf = (props) => {
  const t = Object.values(props).find(p => p.type === "title");
  return t ? plain(t.title).trim() : "";
};

const normalize = (s) => s.replace(/[\s()（）]/g, "").toLowerCase();

// 키워드에 걸리는 후보를 전부 모아 타입 선호 순으로 정렬 (number → rollup → formula)
const RANK = { number: 0, rollup: 1, formula: 2, rich_text: 3, select: 4, checkbox: 5, relation: 6 };
const candidates = (props, keys) =>
  Object.entries(props)
    .filter(([k]) => keys.some(w => normalize(k).includes(normalize(w))))
    .map(([k, v]) => ({ key: k, prop: v }))
    .sort((a, b) => (RANK[a.prop.type] ?? 9) - (RANK[b.prop.type] ?? 9));

const GROUPS = {
  goal:       { keys: ["목표"],                    label: "목표" },
  done:       { keys: ["실적", "실"],              label: "실적" },
  inProgress: { keys: ["진행중", "진행 중", "진"], label: "진행중" },
  order:      { keys: ["순서"],                    label: "순서" }
};

// ── 데이터 소스 해석 ────────────────────────────────────────────────────────
const resolveSource = async (ref) => {
  const id = toId(ref);
  if (DS_ENV) return { mode: "data_source", id: toId(DS_ENV) };
  try {
    const db = await get(`databases/${id}`);
    const list = db.data_sources ?? [];
    if (list.length > 1) {
      console.warn(`데이터 소스 ${list.length}개 → 첫 번째 사용. 다른 것은 NOTION_DATA_SOURCE_ID 로 지정:`);
      list.forEach(d => console.warn(`  - ${d.name}: ${d.id}`));
    }
    if (list.length) return { mode: "data_source", id: list[0].id };
    return { mode: "database", id };
  } catch (e) { if (e.status !== 404 && e.status !== 400) throw e; }

  try {
    let cursor;
    do {
      const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : "?page_size=100";
      const kids = await get(`blocks/${id}/children${qs}`);
      const child = kids.results.find(b => b.type === "child_database");
      if (child) return resolveSource(child.id);
      cursor = kids.has_more ? kids.next_cursor : null;
    } while (cursor);
  } catch { /* fallthrough */ }

  throw new Error(`대상을 찾을 수 없습니다(${id}). DB의 ••• > 연결 에서 통합을 초대했는지 확인하세요.`);
};

const src = await resolveSource(RAW_REF);

const queryAll = async () => {
  const tries = src.mode === "data_source"
    ? [{ p: `data_sources/${src.id}/query`, v: VERSION }, { p: `databases/${toId(RAW_REF)}/query`, v: "2022-06-28" }]
    : [{ p: `databases/${src.id}/query`, v: "2022-06-28" }];
  for (const [i, t] of tries.entries()) {
    try {
      const rows = []; let cursor;
      do {
        const d = await post(t.p, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }, t.v);
        rows.push(...d.results);
        cursor = d.has_more ? d.next_cursor : null;
      } while (cursor);
      return rows;
    } catch (e) {
      if (i === tries.length - 1) throw e;
      console.warn(`${t.p} 실패(${e.message}) → 폴백`);
    }
  }
};

const rows = (await queryAll()).filter(r => titleOf(r.properties));
console.log(`${rows.length}행 수집 (${src.mode} ${src.id})`);

if (DIAGNOSE && rows[0]) {
  console.log(`=== "${titleOf(rows[0].properties)}" 원본 속성 ===`);
  for (const [k, v] of Object.entries(rows[0].properties)) {
    console.log(`${k} → ${v.type} :: ${JSON.stringify(v[v.type])}`);
  }
  for (const g of ["done", "inProgress"]) {
    for (const c of candidates(rows[0].properties, GROUPS[g].keys)) {
      const raw = await get(`pages/${rows[0].id}/properties/${encodeURIComponent(c.prop.id)}?page_size=5`)
        .catch(e => ({ error: e.message }));
      console.log(`[속성 엔드포인트] ${c.key} → ${JSON.stringify(raw).slice(0, 600)}`);
    }
  }
  console.log("==============================");
}

// ── 관계를 직접 펼쳐 합산하는 최후 폴백 ─────────────────────────────────────
const relationIds = async (pageId, props) => {
  const rel = Object.values(props).find(p => p.type === "relation" &&
    Object.entries(props).some(([k, v]) => v === p && normalize(k).includes(normalize(REL_PROP))));
  const target = rel ?? Object.values(props).find(p => p.type === "relation");
  if (!target) return [];
  if (Array.isArray(target.relation) && target.relation.length < 25) return target.relation.map(r => r.id);
  const ids = []; let cursor;
  do {
    const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : "?page_size=100";
    const d = await get(`pages/${pageId}/properties/${encodeURIComponent(target.id)}${qs}`);
    for (const it of d.results ?? []) if (it.type === "relation") ids.push(it.relation.id);
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);
  return ids;
};

const relCache = new Map();
const fetchRelated = async (id) => {
  if (!relCache.has(id)) relCache.set(id, get(`pages/${id}`).catch(() => null));
  return relCache.get(id);
};

const viaRelation = async (pageId, props, keys) => {
  const ids = await relationIds(pageId, props);
  if (!ids.length) return FAIL("관계 비어 있음");
  const pages = (await mapLimit(ids, 3, fetchRelated)).filter(Boolean);
  let sum = 0, matched = false;
  for (const pg of pages) {
    for (const c of candidates(pg.properties ?? {}, keys)) {
      const v = readShallow(c.prop);
      if (v.ok) { sum += v.value; matched = true; break; }
    }
  }
  if (matched) return OK(sum);
  return OK(pages.length); // 값 컬럼을 못 찾으면 개수 집계로 간주
};

// ── 그룹별 값 결정 ─────────────────────────────────────────────────────────
const resolveGroup = async (row, groupKey) => {
  const { keys, label } = GROUPS[groupKey];
  const cands = candidates(row.properties, keys);
  const reasons = [];
  for (const c of cands) {
    const v = await readDeep(row.id, c.prop);
    if (v.ok) return { value: v.value, from: c.key };
    reasons.push(`${c.key}(${c.prop.type}): ${v.reason}`);
  }
  if (groupKey === "done" || groupKey === "inProgress") {
    const v = await viaRelation(row.id, row.properties, keys);
    if (v.ok) return { value: v.value, from: `${REL_PROP} 관계 직접 합산`, fallback: true, reasons };
  }
  return { value: 0, from: null, reasons: reasons.length ? reasons : [`'${label}' 속성 없음`] };
};

const problems = [];
const members = (await mapLimit(rows, 3, async (r) => {
  const name = titleOf(r.properties);
  const [goal, done, inProgress, order] = await Promise.all([
    resolveGroup(r, "goal"), resolveGroup(r, "done"),
    resolveGroup(r, "inProgress"), resolveGroup(r, "order")
  ]);
  for (const [k, v] of Object.entries({ 목표: goal, 실적: done, 진행중: inProgress })) {
    if (!v.from) problems.push(`${name} / ${k} → ${v.reasons.join(" | ")}`);
    else if (v.fallback) problems.push(`${name} / ${k} → 폴백 사용(${v.reasons.join(" | ")})`);
  }
  return {
    name,
    goal: goal.value, done: done.value, inProgress: inProgress.value,
    order: order.value,
    rate: goal.value ? Math.round((done.value / goal.value) * 100) : 0
  };
})).sort((a, b) => (a.order || 999) - (b.order || 999));

const updated = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false
}).format(new Date()).replace(/\. /g, ".").replace(/\.$/, "");

await writeFile("data.json", JSON.stringify({ updated, members }, null, 2) + "\n", "utf8");
console.log(`${members.length}명 동기화 완료 / 기준 ${updated}`);
members.forEach(m => console.log(`  ${m.order}. ${m.name}  목표 ${m.goal} / 실적 ${m.done} / 진행중 ${m.inProgress}`));

if (problems.length) {
  console.warn("⚠ 값 확보에 문제가 있던 항목:");
  problems.slice(0, 20).forEach(p => console.warn("  - " + p));
  console.warn("unsupported 가 보이면 통합이 '직원' 관계 대상 DB에도 초대돼 있는지 확인하세요.");
  console.warn("DIAGNOSE=1 로 실행하면 원본 응답을 그대로 출력합니다.");
}
