// Read-only comparison of the category tree and course links between the reference app's production data
// (through its public proxy, using the publishable key that ships in its client code) and the local test database.
// Prints only summaries and differing slugs. Never writes anything.
import "dotenv/config";
import fs from "node:fs";
import pg from "pg";

const refDir = "C:/Users/dell/Desktop/simlecdbtesting/simple-lecture-web--main (6)supabse/simple-lecture-web--main";
const src = fs.readFileSync(`${refDir}/src/integrations/supabase/client.ts`, "utf8");
const key = /SUPABASE_PUBLISHABLE_KEY = "([^"]+)"/.exec(src)[1];
const urlSrc = fs.readFileSync(`${refDir}/src/lib/supabaseUrl.ts`, "utf8");
const base = /SUPABASE_URL = "([^"]+)"/.exec(urlSrc)[1];

async function ref(path) {
  const r = await fetch(`${base}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`reference ${path}: HTTP ${r.status}`);
  return r.json();
}

const refCats = await ref("categories?select=id,name,slug,parent_id,level,is_active&limit=1000");
const refLinks = await ref("course_categories?select=course_id,category_id&limit=5000");
const refCourses = await ref("courses?select=id,slug,is_active&limit=1000");

const p = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const localCats = (await p.query("select id, name, slug, parent_id, level, is_active from public.categories")).rows;
const localLinks = (await p.query("select course_id, category_id from public.course_categories")).rows;
const localCourses = (await p.query("select id, slug, is_active from public.courses")).rows;

const slugOf = (rows) => new Map(rows.map((c) => [c.id, c.slug]));
const refSlug = slugOf(refCats);
const localSlug = slugOf(localCats);
const pairs = (links, slugs, courses) => {
  const cslug = new Map(courses.map((c) => [c.id, c.slug]));
  return new Set(links.map((l) => `${cslug.get(l.course_id) ?? l.course_id} -> ${slugs.get(l.category_id) ?? l.category_id}`));
};

console.log(`categories  reference=${refCats.length} local=${localCats.length}`);
const onlyRefCats = refCats.filter((c) => !localSlug.has(c.id)).map((c) => `${c.slug} (${c.id})`);
const onlyLocalCats = localCats.filter((c) => !refSlug.has(c.id)).map((c) => `${c.slug} (${c.id})`);
console.log("categories only in reference:", onlyRefCats.length, onlyRefCats.slice(0, 20));
console.log("categories only in local:", onlyLocalCats.length, onlyLocalCats.slice(0, 20));

const refPairs = pairs(refLinks, refSlug, refCourses);
const localPairs = pairs(localLinks, localSlug, localCourses);
const missingLocal = [...refPairs].filter((x) => !localPairs.has(x));
const extraLocal = [...localPairs].filter((x) => !refPairs.has(x));
console.log(`course links  reference=${refLinks.length} local=${localLinks.length}`);
console.log("links only in reference:", missingLocal.length, missingLocal.slice(0, 30));
console.log("links only in local:", extraLocal.length, extraLocal.slice(0, 30));

const refActive = refCourses.filter((c) => c.is_active).map((c) => c.slug).sort();
const localActive = localCourses.filter((c) => c.is_active && !c.slug.startsWith("test-course-")).map((c) => c.slug).sort();
console.log("active courses reference:", refActive.length, "local (excluding test courses):", localActive.length);
console.log("active only in reference:", refActive.filter((s) => !localActive.includes(s)));
console.log("active only in local:", localActive.filter((s) => !refActive.includes(s)));
await p.end();
