import { Router, type IRouter } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

const uploadsDir = path.resolve(import.meta.dirname, "../../static/uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, _file, cb) => cb(null, uuidv4() + ".jpg"),
});
const upload = multer({ storage });

const rankTitles: Record<string, string> = {
  GOD: "TikTokの申し子",
  S: "眠れる怪物",
  A: "隠れた本物",
  B: "爆発前夜",
  C: "伸びしろしかない",
};

const rankDescs: Record<string, string> = {
  GOD: "フォロワー数・エンゲージメント・コンテンツの質、すべてが規格外だ。このアカウントは本物。",
  S: "フォロワー数の規模を超えたエンゲージメントを持つ。正しい戦略があれば3ヶ月以内に爆発的な成長が見込める。",
  A: "影響力の核となる要素はすでに揃っている。あとは収益化の仕組みを乗せるだけ。",
  B: "アルゴリズムに乗りかけているシグナルが出ている。あと一押しでバズの連鎖が始まる。",
  C: "現状はまだ成長途中。改善ポイントが明確な分、伸びしろは全ランク中で最大だ。",
};

router.post("/diagnose", upload.single("image"), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "画像が必要です" });
    return;
  }

  const imageId = path.basename(file.filename, path.extname(file.filename));
  const imageUrl = `/api/static/uploads/${file.filename}`;

  const { device = "", language = "", screen = "", referer = "", network = "" } = req.body;
  const dwellTime = parseInt(req.body.dwell_time || "0", 10);
  const operationCount = parseInt(req.body.operation_count || "0", 10);
  const scrollDepth = parseInt(req.body.scroll_depth || "0", 10);

  let tiktokData: Record<string, unknown> = {
    tiktok_username: null,
    followers: 0,
    likes: 0,
    bio: "",
    is_business: false,
    genre: "その他",
  };

  try {
    const anthropic = new Anthropic({
      baseURL: process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"],
      apiKey: process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"],
    });

    const imageData = fs.readFileSync(file.path);
    const b64 = imageData.toString("base64");

    const visionPrompt = `このTikTokのプロフィール画面のスクリーンショットから以下の情報をJSONで返してください。
取得できない場合はnullとしてください。

{
  "tiktok_username": "@xxx",
  "followers": 数値（万の場合は10000倍に変換）,
  "following": 数値,
  "likes": 数値,
  "bio": "プロフィール文",
  "is_business": true/false,
  "genre": "推定ジャンル（料理/ダンス/ビジネス/ライフスタイル/エンタメ/その他）"
}

JSONのみ返してください。マークダウンは不要です。`;

    const visionRes = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: b64 },
            },
            { type: "text", text: visionPrompt },
          ],
        },
      ],
    });

    const textContent = visionRes.content[0];
    if (textContent.type === "text") {
      try {
        tiktokData = JSON.parse(textContent.text);
      } catch {
        req.log.warn("Failed to parse vision API response as JSON");
      }
    }
  } catch (err) {
    req.log.warn({ err }, "Vision API call failed, using defaults");
  }

  const followers = (tiktokData["followers"] as number) || 0;
  const likes = (tiktokData["likes"] as number) || 0;
  const engagement = followers > 0 ? (likes / followers) * 100 : 0;

  const buzzPotential = Math.min(100, Math.floor(engagement * 2 + (followers / 10000) * 10));
  const engagementScore = Math.min(100, Math.floor(engagement * 3));
  const profileScore = tiktokData["bio"] ? 60 : 30;
  const consistencyScore = 65;
  const monetizationScore = tiktokData["is_business"] ? 50 : 35;

  const total = Math.floor(
    (buzzPotential + engagementScore + profileScore + consistencyScore + monetizationScore) / 5,
  );

  let rank: string;
  if (total >= 90) rank = "GOD";
  else if (total >= 78) rank = "S";
  else if (total >= 65) rank = "A";
  else if (total >= 50) rank = "B";
  else rank = "C";

  let pref = "不明";
  let city = "不明";
  try {
    const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress || "";
    const geoRes = await fetch(`http://ip-api.com/json/${clientIp}?lang=ja&fields=regionName,city`, {
      signal: AbortSignal.timeout(2000),
    });
    const geoData = (await geoRes.json()) as Record<string, string>;
    pref = geoData["regionName"] || "不明";
    city = geoData["city"] || "不明";
  } catch {
    // geo lookup failed silently
  }

  const userId = uuidv4();

  await db.insert(usersTable).values({
    id: userId,
    tiktokUsername: (tiktokData["tiktok_username"] as string) || null,
    followers,
    rank,
    score: total,
    pref,
    city,
    device: device.substring(0, 100),
    browser: "",
    language,
    network,
    screenSize: screen,
    dwellTime,
    scrollDepth,
    operationCount,
    revisitCount: 1,
    lineRegistered: false,
    saved: false,
    imageUrl,
    referer: referer.substring(0, 200),
    genre: (tiktokData["genre"] as string) || "その他",
  });

  res.json({
    rank,
    title: rankTitles[rank],
    desc: rankDescs[rank],
    total,
    user_id: userId,
    tiktok_username: (tiktokData["tiktok_username"] as string) || "@あなたのアカウント",
    scores: [
      { name: "バズポテンシャル", val: buzzPotential },
      { name: "エンゲージメント率", val: engagementScore },
      { name: "プロフィール訴求力", val: profileScore },
      { name: "コンテンツの一貫性", val: consistencyScore },
      { name: "収益化の準備度", val: monetizationScore },
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
  });
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
