const T = process.env.NOTION_TOKEN;
const H = { Authorization: `Bearer ${T}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" };
const DS = "3b11fd97-2c80-8056-82f1-000b39c28f42";
const g = async (p) => (await fetch(`https://api.notion.com/v1/${p}`, { headers: H })).json();

// 1) 롤업이 무엇을 참조하는지 (설정 자체를 확인)
const schema = await g(`data_sources/${DS}`);
console.log("=== 목표 대비 실적 : 롤업/수식 설정 ===");
for (const [name, p] of Object.entries(schema.properties)) {
  if (p.type === "rollup") {
    const r = p.rollup;
    console.log(`[${name}] 롤업 → 관계"${r.relation_property_name}" 의 "${r.rollup_property_name}" 를 ${r.function}`);
  }
  if (p.type === "formula") console.log(`[${name}] 수식 → ${p.formula.expression}`);
  if (p.type === "relation") console.log(`[${name}] 관계 → ${p.relation.data_source_id}`);
}

// 2) 직원 DB에서 그 대상 속성이 또 롤업/수식인지 (= 중첩 여부)
const empDs = schema.properties["직원"]?.relation?.data_source_id;
const emp = await g(`data_sources/${empDs}`);
console.log(`\n=== 직원 DB 속성 타입 ===`);
for (const [name, p] of Object.entries(emp.properties)) console.log(`  ${name} → ${p.type}`);

// 3) 전 행의 관계 연결 수와 롤업 원본값
const q = await (await fetch(`https://api.notion.com/v1/data_sources/${DS}/query`,
  { method: "POST", headers: H, body: JSON.stringify({ page_size: 100 }) })).json();
console.log(`\n=== 행별 실측 (${q.results.length}행) ===`);
for (const row of q.results) {
  const t = Object.values(row.properties).find(p => p.type === "title");
  const name = t?.title.map(x => x.plain_text).join("") || "(무제)";
  const rels = Object.entries(row.properties)
    .filter(([, v]) => v.type === "relation")
    .map(([k, v]) => `${k}=${v.relation.length}`).join(" ");
  const rolls = Object.entries(row.properties)
    .filter(([, v]) => v.type === "rollup")
    .map(([k, v]) => `${k}:${JSON.stringify(v.rollup)}`).join(" ");
  console.log(`${name} | 관계 ${rels} | ${rolls}`);
}
