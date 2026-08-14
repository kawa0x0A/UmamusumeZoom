// 公式ポータル (umamusume.jp) の Nuxt ペイロードからキャラ情報と公式画像URLを収集し、
// data/characters.js を生成する。画像そのものは保存せず、URL だけを参照する。
//
//   node tools/fetch-characters.mjs
//
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://umamusume.jp';
const ASSET_BASE = 'https://images.microcms-assets.io/assets/973fc097984b400db8729642ddff5938/';
const CONCURRENCY = 6;

/**
 * Nuxt (devalue) のフラット配列を復元する。
 * オブジェクト/配列の各値は「配列内のインデックス」なので、再帰的に引き直す。
 */
function hydrate(flat) {
  const cache = new Map();
  const resolve = (i) => {
    if (typeof i !== 'number') return i;
    if (cache.has(i)) return cache.get(i);
    const v = flat[i];
    if (v === null || typeof v !== 'object') {
      cache.set(i, v);
      return v;
    }
    if (Array.isArray(v)) {
      // devalue は特殊値を ["Tag", ...] で表現する
      if (typeof v[0] === 'string') {
        if (v[0] === 'Reactive' || v[0] === 'Ref' || v[0] === 'ShallowRef') return resolve(v[1]);
        if (v[0] === 'Date') return flat[v[1]];
        if (v[0] === 'NuxtError' || v[0] === 'EmptyRef') return null;
      }
      const out = [];
      cache.set(i, out);
      for (const x of v) out.push(resolve(x));
      return out;
    }
    const out = {};
    cache.set(i, out);
    for (const k of Object.keys(v)) out[k] = resolve(v[k]);
    return out;
  };
  return resolve;
}

/** 復元したツリーから id === slug のキャラレコードを探す */
function findRecord(root, slug) {
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (!Array.isArray(node) && node.id === slug && Array.isArray(node.visual)) return node;
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

const shorten = (url) => (url && url.startsWith(ASSET_BASE) ? url.slice(ASSET_BASE.length) : url);

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 UmamusumeZoom/1.0' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function fetchSlugs() {
  const res = await fetch(`${ORIGIN}/character/`, {
    headers: { 'user-agent': 'Mozilla/5.0 UmamusumeZoom/1.0' },
  });
  if (!res.ok) throw new Error(`character list: ${res.status}`);
  const html = await res.text();
  const slugs = [...html.matchAll(/\/character\/([a-z0-9_-]+)"/g)].map((m) => m[1]);
  return [...new Set(slugs)];
}

async function fetchCharacter(slug) {
  const flat = await getJson(`${ORIGIN}/character/${slug}/_payload.json`);
  const rec = findRecord(hydrate(flat)(0), slug);
  if (!rec) throw new Error(`record not found: ${slug}`);

  const images = (rec.visual || [])
    .filter((v) => v && v.image && v.image.url)
    .map((v) => ({
      t: (v.name && v.name.title ? v.name.title : '').replace(/<[^>]*>/g, '').trim(),
      u: shorten(v.image.url),
      w: v.image.width,
      h: v.image.height,
    }))
    // 拡大クイズに耐える解像度のものだけ
    .filter((im) => (im.w || 0) >= 700);

  return {
    id: slug,
    ja: rec.name || '',
    en: rec.en || '',
    cv: rec.cv || '',
    cat: Array.isArray(rec.category) ? rec.category[0] : rec.category || '',
    thumb: shorten(rec.list_thumb && rec.list_thumb.url),
    images,
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

const slugs = await fetchSlugs();
console.log(`character pages: ${slugs.length}`);

let done = 0;
const results = await mapLimit(slugs, CONCURRENCY, async (slug) => {
  try {
    const c = await fetchCharacter(slug);
    process.stdout.write(`\r${++done}/${slugs.length} ${slug.padEnd(24)}`);
    return c;
  } catch (e) {
    process.stdout.write(`\r${++done}/${slugs.length} ${slug} -> SKIP (${e.message})\n`);
    return null;
  }
});

const chars = results.filter((c) => c && c.images.length > 0 && c.ja);
chars.sort((a, b) => a.ja.localeCompare(b.ja, 'ja'));

const body = chars
  .map((c) => `  ${JSON.stringify(c)}`)
  .join(',\n');

const js = `// 自動生成: node tools/fetch-characters.mjs
// 画像は公式ポータル (umamusume.jp / microCMS CDN) の URL を参照しています。
// (C) Cygames, Inc.
window.UMA_DATA = {
  base: ${JSON.stringify(ASSET_BASE)},
  generatedAt: ${JSON.stringify(new Date().toISOString())},
  characters: [
${body}
  ]
};
`;

await mkdir(join(ROOT, 'data'), { recursive: true });
await writeFile(join(ROOT, 'data', 'characters.js'), js, 'utf8');

const imgCount = chars.reduce((n, c) => n + c.images.length, 0);
console.log(`\n-> data/characters.js  characters: ${chars.length}  images: ${imgCount}`);
console.log(
  'categories: ' +
    JSON.stringify(
      chars.reduce((m, c) => ((m[c.cat] = (m[c.cat] || 0) + 1), m), {})
    )
);
