import { Router, type IRouter, type Request } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

// ===== 1. 結果キャッシュ（ユーザー名ベース、TTL 10分） =====
interface CacheEntry { data: unknown; expiresAt: number; }
const resultCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10分
const CACHE_MAX = 1000;

function cacheGet(key: string): unknown | null {
  const entry = resultCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { resultCache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key: string, data: unknown) {
  if (resultCache.size >= CACHE_MAX) {
    // 最も古いエントリを削除
    const firstKey = resultCache.keys().next().value;
    if (firstKey) resultCache.delete(firstKey);
  }
  resultCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ===== 2. IPレート制限（診断エンドポイント: 5回/分） =====
interface RateEntry { count: number; resetAt: number; }
const ipRateMap = new Map<string, RateEntry>();
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 1000; // 1分

function getClientIp(req: Request): string {
  return ((req.headers["x-forwarded-for"] as string) || "").split(",")[0].trim()
    || req.socket.remoteAddress || "unknown";
}
function checkRateLimit(ip: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const entry = ipRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    ipRateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { allowed: true, retryAfterSec: 0 };
  }
  entry.count++;
  if (entry.count > RATE_LIMIT) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfterSec: 0 };
}
// 古いエントリを5分ごとにクリーンアップ
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipRateMap.entries()) {
    if (now > entry.resetAt) ipRateMap.delete(ip);
  }
}, 5 * 60 * 1000);

// ===== 3. GPT-4o 同時実行セマフォ（最大8件） =====
const MAX_CONCURRENT_AI = 8;
let activeAiCalls = 0;
const aiQueue: Array<() => void> = [];

async function withAiSemaphore<T>(fn: () => Promise<T>): Promise<T> {
  if (activeAiCalls >= MAX_CONCURRENT_AI) {
    await new Promise<void>(resolve => aiQueue.push(resolve));
  }
  activeAiCalls++;
  try {
    return await fn();
  } finally {
    activeAiCalls--;
    if (aiQueue.length > 0) {
      const next = aiQueue.shift();
      if (next) next();
    }
  }
}

// ===== TikTokプロフィール スクレイピング =====
interface TikTokProfile {
  tiktok_username: string | null;
  followers: number;
  following: number;
  likes: number;
  videoCount: number;
  bio: string;
  verified: boolean;
  is_business: boolean;
  genre: string;
}

async function scrapeTikTokProfile(username: string): Promise<TikTokProfile> {
  const cleanName = username.replace(/^@/, "").trim();
  const url = `https://www.tiktok.com/@${cleanName}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(12000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();

  // __UNIVERSAL_DATA_FOR_REHYDRATION__ から JSON を抽出
  const scriptMatch = html.match(
    /<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([^<]+)<\/script>/,
  );
  if (!scriptMatch) throw new Error("TikTok data script not found");

  const data = JSON.parse(scriptMatch[1]) as Record<string, unknown>;
  const scope = data["__DEFAULT_SCOPE__"] as Record<string, unknown> | undefined;
  const userDetail = scope?.["webapp.user-detail"] as Record<string, unknown> | undefined;
  const userInfo = userDetail?.["userInfo"] as Record<string, unknown> | undefined;
  const user = userInfo?.["user"] as Record<string, unknown> | undefined;
  const stats = userInfo?.["stats"] as Record<string, unknown> | undefined;

  if (!user || !stats) throw new Error("User data not found in TikTok response");

  const followers = Number(stats["followerCount"] ?? 0);
  // heartCount はオーバーフローで負になる場合がある。heart フィールドを優先
  const rawLikes = Number(stats["heart"] ?? stats["heartCount"] ?? 0);
  const likes = Math.max(0, rawLikes);
  const videoCount = Number(stats["videoCount"] ?? 0);
  const bio = String(user["signature"] ?? "");
  const verified = Boolean(user["verified"]);
  const is_business = Boolean((user["commerceUserInfo"] as Record<string, unknown>)?.["commerceUser"]);

  // フォロワー数・投稿数からジャンルは推定困難なので「その他」
  return {
    tiktok_username: "@" + String(user["uniqueId"] ?? cleanName),
    followers,
    following: Number(stats["followingCount"] ?? 0),
    likes,
    videoCount,
    bio,
    verified,
    is_business,
    genre: "その他",
  };
}

const router: IRouter = Router();

const uploadsDir = path.resolve(import.meta.dirname, "../../static/uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, _file, cb) => cb(null, uuidv4() + ".jpg"),
});
const upload = multer({ storage });

const rankTitles: Record<string, string> = {
  GOD: "完全にバズる人間",
  S: "止まれない怪物",
  A: "爆発まで秒読み",
  B: "まだ本気出してない",
  C: "伸びしろしか見えない",
};

const rankDescs: Record<string, string> = {
  GOD: "規格外。フォロワー数・エンゲージメント・影響力、全部が別次元だ。このアカウントはもはや現象。",
  S: "すでに持っている影響力が別格。正しく動けば3桁万フォロワーも現実になる。",
  A: "必要なものはほぼ揃ってる。一本のバズ動画がきっかけで、今の10倍に化ける素質がある。",
  B: "ちゃんとやれば普通に伸びる。アルゴリズムが動き始めているシグナルが出てる。あとはやるかやらないか。",
  C: "今はまだ仮の姿。正しく動けば半年後には別人のように成長している可能性がある。",
};

// ===== 共通スコア計算（フォールバック用） =====
function calcScores(followers: number, likes: number, hasBio: boolean, isBusiness: boolean, videoCount = 0) {
  const safeFollowers = Math.max(followers || 0, 1);

  // フォロワー数ベースの基礎スコア（主軸）
  const buzzPotential = (() => {
    if (safeFollowers >= 50_000_000) return 96;
    if (safeFollowers >= 10_000_000) return 88;
    if (safeFollowers >= 5_000_000)  return 82;
    if (safeFollowers >= 1_000_000)  return 74;
    if (safeFollowers >= 500_000)    return 66;
    if (safeFollowers >= 100_000)    return 58;
    if (safeFollowers >= 50_000)     return 50;
    if (safeFollowers >= 10_000)     return 41;
    if (safeFollowers >= 5_000)      return 34;
    if (safeFollowers >= 1_000)      return 26;
    return 14;
  })();

  // 動画1本あたり平均いいね÷フォロワー（実態に近いエンゲージメント）
  const avgLikesPerVideo = videoCount > 0 ? (likes || 0) / videoCount : 0;
  const perVideoEngRate = safeFollowers > 0 ? (avgLikesPerVideo / safeFollowers) * 100 : 0;
  const engagementScore = Math.min(100, Math.max(0, Math.floor(perVideoEngRate * 6)));

  // プロフィール充実度
  const profileScore = hasBio ? 62 : 22;

  // 継続性（計測不能なので中立）
  const consistencyScore = 52;

  // マネタイズ
  const monetizationScore = isBusiness ? 55 : 28;

  // totalはフォロワー基礎点＋小ボーナス（平均ではなく直接計算）
  const engBonus  = Math.min(6, Math.floor(perVideoEngRate * 1.5));
  const bioBonus  = hasBio ? 3 : 0;
  const bizBonus  = isBusiness ? 2 : 0;
  const base = (() => {
    if (safeFollowers >= 50_000_000) return 91;
    if (safeFollowers >= 10_000_000) return 85;
    if (safeFollowers >= 5_000_000)  return 79;
    if (safeFollowers >= 1_000_000)  return 71;
    if (safeFollowers >= 500_000)    return 63;
    if (safeFollowers >= 100_000)    return 55;
    if (safeFollowers >= 50_000)     return 48;
    if (safeFollowers >= 10_000)     return 40;
    if (safeFollowers >= 5_000)      return 34;
    if (safeFollowers >= 1_000)      return 26;
    return 14;
  })();
  const total = Math.min(100, base + engBonus + bioBonus + bizBonus);

  let rank: string;
  if (total >= 84) rank = "GOD";
  else if (total >= 71) rank = "S";
  else if (total >= 58) rank = "A";
  else if (total >= 44) rank = "B";
  else rank = "C";
  return { buzzPotential, engagementScore, profileScore, consistencyScore, monetizationScore, total, rank };
}

// ===== GPT-4o AI解析 =====
interface AiAnalysis {
  rank: string; title: string; desc: string;
  buzzPotential: number; engagementScore: number;
  profileScore: number; consistencyScore: number; monetizationScore: number;
  total: number;
  goods: string[]; bads: string[]; nexts: string[];
}

async function analyzeWithAI(profile: TikTokProfile, lang = "ja"): Promise<AiAnalysis> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  // 動画1本あたりの平均いいね率（より実態に近いエンゲージメント指標）
  const avgLikesPerVideo = profile.videoCount > 0 ? Math.floor(profile.likes / profile.videoCount) : 0;
  const perVideoEngagement = profile.followers > 0
    ? ((avgLikesPerVideo / profile.followers) * 100).toFixed(2)
    : "0";

  const prompt = `あなたはTikTokマーケティングの専門家です。以下のアカウントデータを分析し、診断結果をJSONのみで返してください（Markdownコードブロック不要）。

アカウント: ${profile.tiktok_username}
フォロワー数: ${profile.followers.toLocaleString()}人
総いいね数: ${profile.likes.toLocaleString()}
動画本数: ${profile.videoCount}本
動画1本あたりの平均いいね: ${avgLikesPerVideo.toLocaleString()}
平均エンゲージメント率(平均いいね÷フォロワー): ${perVideoEngagement}%
プロフィール文: "${profile.bio || "（未設定）"}"
公認バッジ: ${profile.verified ? "あり" : "なし"}
ビジネスアカウント: ${profile.is_business ? "はい" : "いいえ"}

【重要】スコアリングガイドライン（フォロワー数ベース・現実的評価）:
- totalスコアは主にフォロワー数で決まる（下記ティア参照）
- 1,000人未満 → total 14〜20（ほぼC確定）
- 1,000〜9,999人 → total 26〜35（C〜B下位）
- 1万〜4.9万人 → total 40〜48（B）
- 5万〜9.9万人 → total 48〜55（B上位〜A下位）
- 10万〜49.9万人 → total 55〜63（A）
- 50万〜99.9万人 → total 63〜70（A上位〜S下位）
- 100万〜499万人 → total 71〜78（S）
- 500万〜4999万人 → total 79〜84（S上位〜GOD）
- 5000万人以上 → total 85〜100（GOD確定）
- engagementScore・bioBonus・bizBonusで最大+11点の補正可（基本上振れのみ）
- GODは本物の有名人・世界的インフルエンサーのみ。一般クリエイターには絶対に付けない
- 日本の一般TikTokerはほぼB〜C。10万フォロワーあってようやくAが見えてくるレベル
- 公認バッジありは+3点ボーナス

返却JSON形式:
{
  "rank": "A",
  "title": "診断タイトル（15文字以内のキャッチコピー）",
  "desc": "このアカウントの診断説明（60文字以内、具体的に）",
  "buzzPotential": 75,
  "engagementScore": 72,
  "profileScore": 65,
  "consistencyScore": 70,
  "monetizationScore": 60,
  "total": 68,
  "goods": ["強み1（具体的に）", "強み2（具体的に）"],
  "bads": ["改善点1（具体的に）", "改善点2（具体的に）"],
  "nexts": ["今すぐできる具体的アクション1", "今すぐできる具体的アクション2"]
}

titleは「完全にバズる人間」「爆発まで秒読み」のような、インパクトがあってTikTokっぽい面白いコピーにすること。

ランク基準（totalスコアで判定）:
- GOD: 84以上（有名人・世界級インフルエンサーのみ）
- S: 71〜83（100万フォロワー超の実力派）
- A: 58〜70（10万フォロワー超・バズってる人）
- B: 44〜57（1万〜10万フォロワー・成長中）
- C: 43以下（一般クリエイター・これからの人）

ランク分布目安: GOD 2%、S 8%、A 20%、B 40%、C 30%
（一般的なTikTokerの大多数はB〜Cになるよう、フォロワー数を軸に厳しく評価すること）${
  lang === "en" ? "\n\nIMPORTANT: Respond entirely in English. All fields (title, desc, goods, bads, nexts) must be written in English." :
  lang === "ko" ? "\n\n중요: title, desc, goods, bads, nexts 모든 필드를 한국어로 작성하세요." :
  lang === "zh" ? "\n\n重要：title, desc, goods, bads, nexts 所有字段请用简体中文。" : ""
}`;

  const aiRes = await withAiSemaphore(() => openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 900,
    temperature: 0.6,
    messages: [{ role: "user", content: prompt }],
  }));

  const raw = aiRes.choices[0]?.message?.content || "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("AI response parse failed");
  const p = JSON.parse(jsonMatch[0]);

  const clamp = (v: unknown) => Math.min(100, Math.max(0, Number(v) || 0));
  const total = clamp(p.total);
  // totalから正確にランクを再計算（AIの申告ランクとズレを防ぐ）
  let rank: string;
  if (total >= 84) rank = "GOD";
  else if (total >= 71) rank = "S";
  else if (total >= 58) rank = "A";
  else if (total >= 44) rank = "B";
  else rank = "C";
  return {
    rank,
    title: String(p.title || rankTitles[rank] || ""),
    desc: String(p.desc || rankDescs[rank] || ""),
    buzzPotential: clamp(p.buzzPotential),
    engagementScore: clamp(p.engagementScore),
    profileScore: clamp(p.profileScore),
    consistencyScore: clamp(p.consistencyScore),
    monetizationScore: clamp(p.monetizationScore),
    total,
    goods: Array.isArray(p.goods) ? p.goods.map(String) : [],
    bads: Array.isArray(p.bads) ? p.bads.map(String) : [],
    nexts: Array.isArray(p.nexts) ? p.nexts.map(String) : [],
  };
}

async function getGeo(req: { headers: Record<string, string | string[] | undefined>, socket: { remoteAddress?: string } }) {
  let pref = "不明", city = "不明";
  try {
    const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress || "";
    const geoRes = await fetch(`http://ip-api.com/json/${clientIp}?lang=ja&fields=regionName,city`, { signal: AbortSignal.timeout(2000) });
    const geoData = (await geoRes.json()) as Record<string, string>;
    pref = geoData["regionName"] || "不明";
    city = geoData["city"] || "不明";
  } catch { /* silent */ }
  return { pref, city };
}

function buildResponse(rank: string, total: number, userId: string, tiktokUsername: string, followers: number, scores: ReturnType<typeof calcScores>) {
  return {
    rank,
    title: rankTitles[rank],
    desc: rankDescs[rank],
    total,
    user_id: userId,
    tiktok_username: tiktokUsername,
    scores: [
      { name: "バズポテンシャル", val: scores.buzzPotential },
      { name: "エンゲージメント率", val: scores.engagementScore },
      { name: "プロフィール訴求力", val: scores.profileScore },
      { name: "コンテンツの一貫性", val: scores.consistencyScore },
      { name: "収益化の準備度", val: scores.monetizationScore },
    ],
    goods: [
      `フォロワー${followers.toLocaleString()}人に対してエンゲージメントが高水準を維持している`,
      "プロフィールに独自性があり、ジャンルが明確に伝わる構成になっている",
    ],
    bads: ["収益化への導線が設計されておらず、影響力が収益に転換されていない"],
    nexts: [
      "プロフィールリンクをLPに変えるだけで問い合わせが大幅に増加する",
      "最初の3秒のフックを強化することで視聴完了率を劇的に改善できる",
    ],
  };
}

// ===== 画像アップロードで診断 =====
router.post("/diagnose", upload.single("image"), async (req, res) => {
  const file = req.file;
  if (!file) { res.status(400).json({ error: "画像が必要です" }); return; }

  const imageUrl = `/api/static/uploads/${file.filename}`;
  const { device = "", language = "", screen = "", referer = "", network = "" } = req.body;
  const dwellTime = parseInt(req.body.dwell_time || "0", 10);
  const operationCount = parseInt(req.body.operation_count || "0", 10);
  const scrollDepth = parseInt(req.body.scroll_depth || "0", 10);

  let tiktokData: Record<string, unknown> = { tiktok_username: null, followers: 0, likes: 0, bio: "", is_business: false, genre: "その他" };

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const b64 = fs.readFileSync(file.path).toString("base64");
    const mimeType = file.mimetype || "image/jpeg";
    const visionRes = await openai.chat.completions.create({
      model: "gpt-4o", max_tokens: 500,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${b64}`, detail: "high" } },
        { type: "text", text: `このTikTokのプロフィール画面から以下のJSONを返してください。取得できない場合はnull。\n{"tiktok_username":"@xxx","followers":数値,"following":数値,"likes":数値,"bio":"プロフィール文","is_business":true/false,"genre":"料理/ダンス/ビジネス/ライフスタイル/エンタメ/その他"}\nJSONのみ、マークダウン不要。` },
      ]}],
    });
    try { tiktokData = JSON.parse(visionRes.choices[0]?.message?.content || ""); } catch { /* ignore */ }
  } catch (err) { req.log.warn({ err }, "Vision API failed"); }

  const followers = (tiktokData["followers"] as number) || 0;
  const likes = (tiktokData["likes"] as number) || 0;
  const scores = calcScores(followers, likes, !!tiktokData["bio"], !!tiktokData["is_business"], (tiktokData["videoCount"] as number) || 0);
  const { pref, city } = await getGeo(req as Parameters<typeof getGeo>[0]);
  const userId = uuidv4();

  await db.insert(usersTable).values({
    id: userId,
    tiktokUsername: (tiktokData["tiktok_username"] as string) || null,
    followers, rank: scores.rank, score: scores.total,
    pref, city,
    device: device.substring(0, 100), browser: "", language, network,
    screenSize: screen, dwellTime, scrollDepth, operationCount,
    revisitCount: 1, lineRegistered: false, saved: false,
    imageUrl, referer: referer.substring(0, 200),
    genre: (tiktokData["genre"] as string) || "その他",
  });

  res.json(buildResponse(scores.rank, scores.total, userId, (tiktokData["tiktok_username"] as string) || "@あなたのアカウント", followers, scores));
});

// ===== ユーザー名で診断（スクレイピング） =====
router.post("/diagnose-by-username", async (req, res) => {
  const ip = getClientIp(req);
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    res.status(429).json({
      error: `リクエストが多すぎます。${rateCheck.retryAfterSec}秒後に再試行してください。`,
    });
    return;
  }

  const { username, device = "", language = "", screen = "", referer = "", network = "", lang = "ja" } = req.body as Record<string, string>;
  if (!username) { res.status(400).json({ error: "ユーザー名が必要です" }); return; }

  // キャッシュを確認（同じユーザー名は10分間再利用）
  const cacheKey = username.toLowerCase().replace(/^@/, "") + ":" + lang;
  const cached = cacheGet(cacheKey);
  if (cached) {
    // キャッシュヒット: ユーザーIDだけ新しく発行してDBに記録
    const cachedData = cached as Record<string, unknown>;
    const userId = uuidv4();
    const { pref, city } = await getGeo(req as Parameters<typeof getGeo>[0]);
    await db.insert(usersTable).values({
      id: userId,
      tiktokUsername: cachedData.tiktok_username as string | null,
      followers: (cachedData.followers as number) || 0,
      rank: cachedData.rank as string,
      score: (cachedData.total as number) || 0,
      pref, city,
      device: device.substring(0, 100), browser: "", language, network,
      screenSize: screen, dwellTime: 0, scrollDepth: 0, operationCount: 0,
      revisitCount: 1, lineRegistered: false, saved: false,
      imageUrl: null, referer: referer.substring(0, 200),
      genre: "その他",
    });
    res.json({ ...cachedData, user_id: userId, _cached: true });
    return;
  }

  let profile: TikTokProfile;
  try {
    profile = await scrapeTikTokProfile(username);
  } catch (err) {
    req.log.warn({ err }, "TikTok scrape failed");
    res.status(422).json({ error: "TikTokのプロフィールを取得できませんでした。ユーザー名を確認してください。" });
    return;
  }

  // GPT-4o AI解析（失敗時は数式フォールバック）
  let ai: AiAnalysis;
  try {
    ai = await analyzeWithAI(profile, lang);
  } catch (err) {
    req.log.warn({ err }, "AI analysis failed, falling back to formula");
    const s = calcScores(profile.followers, profile.likes, !!profile.bio, profile.is_business, profile.videoCount || 0);
    ai = {
      rank: s.rank, title: rankTitles[s.rank], desc: rankDescs[s.rank],
      buzzPotential: s.buzzPotential, engagementScore: s.engagementScore,
      profileScore: s.profileScore, consistencyScore: s.consistencyScore,
      monetizationScore: s.monetizationScore, total: s.total,
      goods: [], bads: [], nexts: [],
    };
  }

  const { pref, city } = await getGeo(req as Parameters<typeof getGeo>[0]);
  const userId = uuidv4();

  await db.insert(usersTable).values({
    id: userId,
    tiktokUsername: profile.tiktok_username,
    followers: profile.followers, rank: ai.rank, score: ai.total,
    pref, city,
    device: device.substring(0, 100), browser: "", language, network,
    screenSize: screen, dwellTime: 0, scrollDepth: 0, operationCount: 0,
    revisitCount: 1, lineRegistered: false, saved: false,
    imageUrl: null, referer: referer.substring(0, 200),
    genre: profile.genre,
  });

  const tiktokUsername = profile.tiktok_username || "@" + username.replace(/^@/, "");
  const responseData = {
    rank: ai.rank,
    title: ai.title,
    desc: ai.desc,
    total: ai.total,
    tiktok_username: tiktokUsername,
    scores: [
      { key: "buzzPotential",    val: ai.buzzPotential },
      { key: "engagementScore",  val: ai.engagementScore },
      { key: "profileScore",     val: ai.profileScore },
      { key: "consistencyScore", val: ai.consistencyScore },
      { key: "monetizationScore",val: ai.monetizationScore },
    ],
    goods: ai.goods,
    bads: ai.bads,
    nexts: ai.nexts,
    verified: profile.verified,
    followers: profile.followers,
    following: profile.following,
    likes: profile.likes,
    videoCount: profile.videoCount,
    bio: profile.bio,
  };

  // キャッシュに保存
  cacheSet(cacheKey, responseData);

  res.json({ ...responseData, user_id: userId });
});

router.post("/save-result", async (req, res) => {
  const { user_id } = req.body as { user_id?: string };
  if (user_id) {
    await db.update(usersTable).set({ saved: true }).where(eq(usersTable.id, user_id));
  }
  res.json({ ok: true });
});

router.post("/line-register", async (req, res) => {
  const { user_id } = req.body as { user_id?: string };
  if (user_id) {
    await db.update(usersTable).set({ lineRegistered: true }).where(eq(usersTable.id, user_id));
  }
  res.json({ ok: true });
});

export default router;
