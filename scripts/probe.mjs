const T = process.env.NOTION_TOKEN;
const H = { Authorization: `Bearer ${T}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" };
const DS = "3b11fd97-2c80-8056-82f1-000b39c28f42";

// 1) 데이터 소스 스키마에서 관계 컬럼의 대상 DB를 찾는다
const schema = await (await fetch(`https://api.notion.com/v1/data_sources/${DS}`, { headers: H })).json();
console.log("현재 DB:", schema.title?.[0]?.plain_text ?? "(제목 없음)");

const relations = Object.entries(schema.properties ?? {}).filter(([, v]) => v.type === "relation");
if (!relations.length) console.log("관계 컬럼이 없습니다.");

for (const [name, prop] of relations) {
  const targetDb = prop.relation?.database_id;
  const targetDs = prop.relation?.data_source_id;
  console.log(`\n[관계 컬럼] ${name}`);
  console.log(`  대상 database_id: ${targetDb}`);

  const res = await fetch(`https://api.notion.com/v1/databases/${targetDb}`, { headers: H });
  const body = await res.json();
  if (res.ok) {
    console.log(`  ✅ 접근 가능 (HTTP 200) — 이름: "${body.title?.[0]?.plain_text ?? "?"}"`);
  } else {
    console.log(`  ❌ 접근 불가 (HTTP ${res.status}) — ${body.message ?? ""}`);
    console.log(`  → 이 데이터베이스에 통합을 초대해야 합니다.`);
  }
  if (targetDs) {
    const r2 = await fetch(`https://api.notion.com/v1/data_sources/${targetDs}`, { headers: H });
    console.log(`  data_source 접근: HTTP ${r2.status}`);
  }
}

// 2) 통합이 현재 볼 수 있는 DB 목록 (초대된 곳이 어디인지 확인용)
const s = await (await fetch("https://api.notion.com/v1/search", {
  method: "POST", headers: H,
  body: JSON.stringify({ filter: { value: "data_source", property: "object" }, page_size: 50 })
})).json();
console.log(`\n[통합이 접근 가능한 데이터 소스 ${s.results?.length ?? 0}개]`);
for (const r of s.results ?? []) console.log(`  - ${r.title?.[0]?.plain_text ?? "(제목 없음)"}  ${r.id}`);
