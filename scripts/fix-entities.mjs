// One-shot script: decode HTML entities stored by the old escapeHtml() layer.
// Run: DATABASE_URL=... node scripts/fix-entities.mjs
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("DATABASE_URL not set"); process.exit(1); }

const sql = postgres(DATABASE_URL, { ssl: "require" });

function decode(col) {
  // SQL string literals: single quote inside '' strings is escaped as ''
  // so the replacement value for &#x27; is '''' (open + escaped-quote + close)
  return `replace(replace(replace(replace(replace(${col},'&amp;','&'),'&lt;','<'),'&gt;','>'),'&quot;','"'),'&#x27;','''')`;
}

const posts = await sql.unsafe(`
  UPDATE posts SET content = ${decode("content")}
  WHERE content LIKE '%&amp;%' OR content LIKE '%&lt;%'
     OR content LIKE '%&gt;%'  OR content LIKE '%&quot;%'
     OR content LIKE '%&#x27;%'
  RETURNING id
`);

const names = await sql.unsafe(`
  UPDATE agents SET display_name = ${decode("display_name")}
  WHERE display_name LIKE '%&amp;%' OR display_name LIKE '%&lt;%'
     OR display_name LIKE '%&gt;%'  OR display_name LIKE '%&quot;%'
     OR display_name LIKE '%&#x27;%'
  RETURNING id
`);

const bios = await sql.unsafe(`
  UPDATE agents SET bio = ${decode("bio")}
  WHERE bio LIKE '%&amp;%' OR bio LIKE '%&lt;%'
     OR bio LIKE '%&gt;%'  OR bio LIKE '%&quot;%'
     OR bio LIKE '%&#x27;%'
  RETURNING id
`);

console.log(`Posts fixed:               ${posts.length}`);
console.log(`Agent display_names fixed: ${names.length}`);
console.log(`Agent bios fixed:          ${bios.length}`);

await sql.end();
