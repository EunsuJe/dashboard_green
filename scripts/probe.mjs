const T = process.env.NOTION_TOKEN;
const H = { Authorization: `Bearer ${T}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" };
const DS = "3b11fd97-2c80-8056-82f1-000b39c28f42";

const q = await (await fetch(`https://api.notion.com/v1/data_sources/${DS}/query`,
  { method: "POST", headers: H, body: JSON.stringify({ page_size: 1 }) })).json();

const row = q.results[0];
const rel = Object.entries(row.properties).find(([, v]) => v.type === "relation");
console.log("관계 컬럼:", rel?.[0], "→ 연결 수:", rel?.[1].relation?.length ?? 0);

for (const r of (rel?.[1].relation ?? []).slice(0, 5)) {
  const res = await fetch(`https://api.notion.com/v1/pages/${r.id}`, { headers: H });
  console.log(`  ${r.id} → HTTP ${res.status}`);
}
