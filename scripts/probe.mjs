// 진단 전용: "당사PJ" 수식이 실제로 무엇을 참조하고, 어디서 0이 나오는지 추적한다.
// 실행: NOTION_TOKEN 있는 GitHub Actions에서 workflow_dispatch로 실행.
const TOKEN = process.env.NOTION_TOKEN;
const VERSION = "2025-09-03";
const H = { Authorization: `Bearer ${TOKEN}`, "Notion-Version": VERSION, "Content-Type": "application/json" };
const ROOT_DS = "3b11fd97-2c80-8056-82f1-000b39c28f42";

// 사용자가 알려준 페이지(실제 숫자 입력 페이지)의 URL에서 추출한 ID
const USER_PAGE_ID = "3d51fd97-2c80-8041-ba70-c0d3b524711a";

const get = async (p) => {
  const res = await fetch(`https://api.notion.com/v1/${p}`, { headers: H });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) { console.log(`  ✗ GET ${p} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`); return null; }
  return json;
};
const post = async (p, b) => {
  const res = await fetch(`https://api.notion.com/v1/${p}`, { method: "POST", headers: H, body: JSON.stringify(b) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) { console.log(`  ✗ POST ${p} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`); return null; }
  return json;
};

console.log("=== 1) 사용자가 알려준 페이지/DB 자체 조회 시도 ===");
console.log(`ID: ${USER_PAGE_ID}`);
const asPage = await get(`pages/${USER_PAGE_ID}`);
if (asPage) console.log(`  → pages/{id} 성공. object=${asPage.object}, parent=${JSON.stringify(asPage.parent)}`);
const asDs = await get(`data_sources/${USER_PAGE_ID}`);
if (asDs) console.log(`  → data_sources/{id} 성공. title=${asDs.title?.[0]?.plain_text}, properties=${Object.keys(asDs.properties ?? {}).join(", ")}`);
const asDb = await get(`databases/${USER_PAGE_ID}`);
if (asDb) console.log(`  → databases/{id} 성공. title=${asDb.title?.[0]?.plain_text}`);

console.log("\n=== 2) ROOT_DS 스키마에서 '프로젝트 참여 기여율' 관계 대상 DS 찾기 ===");
const rootSchema = await get(`data_sources/${ROOT_DS}`);
const relProp = rootSchema?.properties?.["프로젝트 참여 기여율"];
const midDs = relProp?.relation?.data_source_id;
console.log(`중간 DS(midDs) = ${midDs}`);

if (midDs) {
  console.log("\n=== 3) 중간 DS 스키마 전체 속성 (당사PJ 포함) ===");
  const midSchema = await get(`data_sources/${midDs}`);
  for (const [k, v] of Object.entries(midSchema?.properties ?? {})) {
    let extra = "";
    if (v.type === "formula") extra = ` :: expression="${v.formula.expression}"`;
    if (v.type === "rollup") extra = ` :: relation="${v.rollup.relation_property_name}" target="${v.rollup.rollup_property_name}" fn=${v.rollup.function}`;
    if (v.type === "relation") extra = ` :: → data_source_id=${v.relation.data_source_id}`;
    console.log(`  "${k}" (${v.id}) → ${v.type}${extra}`);
  }

  console.log("\n=== 4) 중간 DS에서 '당사PJ'가 참조하는 하위 relation의 대상 DS도 확인 ===");
  const dansaPj = midSchema?.properties?.["당사PJ"];
  console.log(`당사PJ 정의: ${JSON.stringify(dansaPj)}`);

  // formula라면 expression에서 참조하는 prop들을 재귀적으로 추적
  if (dansaPj?.type === "formula") {
    const expr = dansaPj.formula.expression;
    console.log(`  수식: ${expr}`);
    const refs = [...expr.matchAll(/prop\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g)].map(m => m[1].replace(/\\"/g, '"'));
    console.log(`  참조하는 속성들: ${refs.join(", ")}`);
    for (const r of refs) {
      const def = midSchema.properties[r];
      console.log(`    - "${r}" → type=${def?.type} ${def ? JSON.stringify(def[def.type] ?? {}) : "(스키마에 없음!)"}`);
    }
  }

  console.log("\n=== 5) 중간 DS에서 샘플 1건 조회해서 당사PJ 실제 원시값 확인 ===");
  const q = await post(`data_sources/${midDs}/query`, { page_size: 3 });
  for (const row of q?.results ?? []) {
    const titleProp = Object.values(row.properties).find(p => p.type === "title");
    const title = titleProp ? titleProp.title.map(t => t.plain_text).join("") : row.id;
    console.log(`  [${title}] (${row.id})`);
    for (const [k, v] of Object.entries(row.properties)) {
      if (/당사|기여|실적|진행/.test(k)) {
        console.log(`    "${k}" (${v.type}) = ${JSON.stringify(v[v.type])}`);
      }
    }
    // 속성 전용 엔드포인트로 당사PJ 재조회
    const propId = midSchema.properties["당사PJ"]?.id;
    if (propId) {
      const fresh = await get(`pages/${row.id}/properties/${encodeURIComponent(propId)}`);
      console.log(`    → 속성 전용 엔드포인트 재조회 결과: ${JSON.stringify(fresh)}`);
    }
  }
}

console.log("\n=== 완료 ===");
