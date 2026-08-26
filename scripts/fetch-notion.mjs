const TOKEN = process.env.NOTION_TOKEN;
const DB_ID = process.env.NOTION_DB_ID;

if (!TOKEN || !DB_ID) {
  console.error("NOTION_TOKEN / NOTION_DB_ID 시크릿이 설정되지 않았습니다.");
  process.exit(1);
}

const api = async (path, body) => {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
};

// 속성 타입에 상관없이 숫자/텍스트 꺼내기
const num = (p) => {
  if (!p) return 0;
  if (p.type === "number")  return p.number ?? 0;
  if (p.type === "formula") return p.formula?.number ?? 0;
  if (p.type === "rollup")  return p.rollup?.number ?? (p.rollup?.array?.length ?? 0);
  return 0;
};
const title = (props) => {
  const t = Object.values(props).find(p => p.type === "title");
  return t ? t.title.map(x => x.plain_text).join("").trim() : "";
};
// 이름에 특정 단어가 들어간 속성 찾기 (컬럼명이 조금 바뀌어도 동작)
const pick = (props, ...keys) => {
  const found = Object.keys(props).find(k => keys.some(w => k.includes(w)));
  return found ? props[found] : null;
};

// 전체 행 수집 (페이지네이션)
let rows = [], cursor;
do {
  const data = await api(`databases/${DB_ID}/query`, {
    page_size: 100,
    ...(cursor ? { start_cursor: cursor } : {})
  });
  rows.push(...data.results);
  cursor = data.has_more ? data.next_cursor : null;
} while (cursor);

const members = rows.map(r => ({
  name:       title(r.properties),
  goal:       num(pick(r.properties, "목표")),
  done:       num(pick(r.properties, "실적")),
  inProgress: num(pick(r.properties, "진행중")),
  order:      num(pick(r.properties, "순서"))
}))
  .filter(m => m.name)
  .sort((a, b) => (a.order || 999) - (b.order || 999));

const updated = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false
}).format(new Date()).replace(/\. /g, ".").replace(/\.$/, "");

const out = { updated, members };
await (await import("node:fs/promises")).writeFile(
  "data.json", JSON.stringify(out, null, 2) + "\n", "utf8"
);

console.log(`${members.length}명 동기화 완료 / 기준 ${updated}`);
