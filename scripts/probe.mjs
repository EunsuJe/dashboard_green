const T = process.env.NOTION_TOKEN;
const H = { Authorization: `Bearer ${T}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" };
const DS = "3b11fd97-2c80-8056-82f1-000b39c28f42";
const g = async (p) => (await fetch(`https://api.notion.com/v1/${p}`, { headers: H })).json();
const q = async (ds, body = {}) => (await fetch(`https://api.notion.com/v1/data_sources/${ds}/query`,
  { method: "POST", headers: H, body: JSON.stringify({ page_size: 100, ...body }) })).json();

// 조영재 행 찾기
const rows = (await q(DS)).results;
const row = rows.find(r => Object.values(r.properties)
  .some(p => p.type === "title" && p.title.map(x => x.plain_text).join("").includes("조영재")));

const relKey = "프로젝트 참여 기여율";
const ids = row.properties[relKey].relation.map(r => r.id);
console.log(`조영재 → ${relKey} ${ids.length}건`);

// 대상 DB 스키마
const schema = await g(`data_sources/${DS}`);
const targetDs = schema.properties[relKey].relation.data_source_id;
const target = await g(`data_sources/${targetDs}`);
console.log(`\n=== "${target.title?.[0]?.plain_text}" 속성 정의 ===`);
for (const [k, p] of Object.entries(target.properties)) {
  let extra = "";
  if (p.type === "formula") extra = ` :: ${p.formula.expression}`;
  if (p.type === "rollup")  extra = ` :: 관계"${p.rollup.relation_property_name}"의 "${p.rollup.rollup_property_name}" ${p.rollup.function}`;
  if (p.type === "relation") extra = ` :: → ${p.relation.data_source_id}`;
  console.log(`  ${k} → ${p.type}${extra}`);
}

// 자식 페이지들의 실제 값
console.log(`\n=== 자식 ${ids.length}건의 실/진 값 ===`);
for (const id of ids) {
  const pg = await g(`pages/${id}`);
  const t = Object.values(pg.properties).find(p => p.type === "title");
  const name = t?.title.map(x => x.plain_text).join("") || id.slice(0, 8);
  const vals = Object.entries(pg.properties)
    .filter(([k]) => /실|진|당사/.test(k))
    .map(([k, v]) => `${k}(${v.type})=${JSON.stringify(v[v.type])}`)
    .join("  ");
  console.log(`  [${name}] ${vals}`);
}

console.log(`\n=== 자식 페이지 전체 속성명 목록 (첫 1건) ===`);
if (ids.length) {
  const pg = await g(`pages/${ids[0]}`);
  console.log(Object.keys(pg.properties).join(" | "));
}
