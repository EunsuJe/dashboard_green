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

// ── 캐시: 데이터 소스 스키마 / 페이지 ────────────────────────────────────────
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

const prefetchDs = async (dsId) => {
  if (prefetched.has(dsId)) return;
  prefetched.add(dsId);
  try {
    for (const pg of await queryAll(dsId)) pageCache.set(pg.id, pg);
  } catch (e) { console.warn(`데이터소스 프리페치 실패 ${dsId}: ${e.message}`); }
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

// 관계 대상 ID 목록 (25개 초과 시 속성 엔드포인트로 페이지네이션)
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

// ── 수식 평가기: prop("x"), 숫자, + - * / ( ), 소수 함수 ─────────────────────
const FUNCS = {
  round: (x) => Math.round(x), abs: Math.abs, floor: Math.floor, ceil: Math.ceil,
  min: (...a) => Math.min(...a), max: (...a) => Math.max(...a),
  tonumber: (x) => Number(x) || 0, unaryminus: (x) => -x
};

const evalFormula = async (expr, resolveProp) => {
  // 토큰화
  const tokens = [];
  const re = /\s*(prop\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)|[A-Za-z_]\w*|\d+(?:\.\d+)?|[()+\-*/,])/y;
  let pos = 0;
  while (pos < expr.length) {
    re.lastIndex = pos;
    const m = re.exec(expr);
    if (!m) throw new Error(`파싱 불가: ${expr.slice(pos, pos + 20)}`);
    pos = re.lastIndex;
    if (m[2] !== undefined) tokens.push({ t: "prop", v: m[2].replace(/\\"/g, '"') });
    else if (/^\d/.test(m[1])) tokens.push({ t: "num", v: parseFloat(m[1]) });
    else if (/^[A-Za-z_]/.test(m[1])) tokens.push({ t: "id", v: m[1].toLowerCase() });
    else tokens.push({ t: m[1] });
  }

  let i = 0;
  const peek = () => tokens[i];
  const eat = (t) => { if (tokens[i]?.t !== t) throw new Error(`'${t}' 기대`); return tokens[i++]; };

  const parseExpr = async () => {
    let v = await parseTerm();
    while (peek()?.t === "+" || peek()?.t === "-") {
      const op = tokens[i++].t, r = await parseTerm();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const parseTerm = async () => {
    let v = await parseUnary();
    while (peek()?.t === "*" || peek()?.t === "/") {
      const op = tokens[i++].t, r = await parseUnary();
      v = op === "*" ? v * r : (r === 0 ? 0 : v / r);
    }
    return v;
  };
  const parseUnary = async () => {
    if (peek()?.t === "-") { i++; return -(await parseUnary()); }
    return parseAtom();
  };
  const parseAtom = async () => {
    const tk = peek();
    if (!tk) throw new Error("수식이 갑자기 끝남");
    if (tk.t === "num")  { i++; return tk.v; }
    if (tk.t === "prop") { i++; return await resolveProp(tk.v); }
    if (tk.t === "(")    { i++; const v = await parseExpr(); eat(")"); return v; }
    if (tk.t === "id") {
      i++;
      const fn = FUNCS[tk.v];
      if (peek()?.t !== "(") throw new Error(`알 수 없는 식별자 ${tk.v}`);
      i++;
      const args = [];
      if (peek()?.t !== ")") {
        args.push(await parseExpr());
        while (peek()?.t === ",") { i++; args.push(await parseExpr()); }
      }
      eat(")");
      if (!fn) throw new Error(`미지원 함수 ${tk.v}`);
      return fn(...args);
    }
    throw new Error(`예상치 못한 토큰 ${tk.t}`);
  };

  const out = await parseExpr();
  if (i !== tokens.length) throw new Error("수식 잔여 토큰");
  return Number.isFinite(out) ? out : 0;
};

// ── 핵심: 속성 값을 재귀적으로 직접 계산 ────────────────────────────────────
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

const resolveValue = async (page, propName, depth = 0, trail = []) => {
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
      const expr = def?.formula?.expression;
      if (expr) {
        try {
          return await evalFormula(expr, (n) => resolveValue(page, n, depth + 1, [...trail, key]));
        } catch (e) {
          if (depth === 0) console.warn(`수식 직접계산 실패 [${key}]: ${e.message} → API 값 사용`);
        }
      }
      const f = p.formula ?? {};
      return f.type === "number" ? (f.number ?? 0) : f.type === "boolean" ? (f.boolean ? 1 : 0) : 0;
    }

    case "rollup": {
      const cfg = def?.rollup ?? p.rollup ?? {};
      const relName = cfg.relation_property_name;
      const tgtName = cfg.rollup_property_name;
      const fn = cfg.function ?? "sum";

      if (relName && tgtName) {
        const relKey = findKey(props, relName);
        if (relKey && props[relKey].type === "relation") {
          const ids = await relationIds(page, props[relKey]);
          const targetDs = schema[relKey]?.relation?.data_source_id;
          if (targetDs) await prefetchDs(targetDs);
          const vals = await mapLimit(ids, 3, async (id) => {
            const child = await pageOf(id, targetDs);
            return child ? await resolveValue(child, tgtName, depth + 1, [...trail, key]) : NaN;
          });
          return aggregate(fn, vals);
        }
      }
      const r = p.rollup ?? {};
      if (r.type === "number" && r.number != null) return r.number;
      if (r.type === "array") return aggregate(fn, r.array.map(it => it.type === "number" ? it.number ?? 0 : 0));
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
  const [goal, done, inProgress, order] = await Promise.all([
    resolveValue(r, "목표(Set)"),
    resolveValue(r, "실(Set)"),
    resolveValue(r, "진(Set)"),
    resolveValue(r, "순서")
  ]);
  return {
    name, goal, done, inProgress, order,
    rate: goal ? Math.round((done / goal) * 100) : 0
  };
})).sort((a, b) => (a.order || 999) - (b.order || 999));

const updated = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false
}).format(new Date()).replace(/\. /g, ".").replace(/\.$/, "");

console.log(`기준 ${updated}`);
members.forEach(m =>
  console.log(`  ${m.order}. ${m.name}  목표 ${m.goal} / 실적 ${m.done} / 진행중 ${m.inProgress} (${m.rate}%)`));

if (members.length && members.every(m => m.done === 0 && m.inProgress === 0) && members.some(m => m.goal > 0)) {
  console.error("실적이 전원 0 → data.json 갱신을 중단합니다(기존 데이터 보존).");
  process.exit(1);
}

await writeFile("data.json", JSON.stringify({ updated, members }, null, 2) + "\n", "utf8");
console.log(`${members.length}명 동기화 완료`);
