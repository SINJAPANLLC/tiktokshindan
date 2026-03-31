import { Router } from "express";
import crypto from "crypto";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq, desc, isNotNull, and } from "drizzle-orm";

const router = Router();

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "";
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET ?? "";

// ユーザー名入力待ち状態の管理（line_user_id → true）
const pendingUsername = new Map<string, boolean>();

function verifySignature(rawBody: string, signature: string): boolean {
  if (!CHANNEL_SECRET) return false;
  const hash = crypto
    .createHmac("SHA256", CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");
  return hash === signature;
}

async function replyMessage(replyToken: string, messages: object[]) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("LINE reply error:", res.status, body);
  }
}

const RANK_DETAIL: Record<string, {
  summary: string;
  goods: [string, string];
  bads: [string, string];
  nexts: [string, string];
}> = {
  GOD: {
    summary: "圧倒的なフォロワー規模と影響力を持つトップクリエイターです。",
    goods: [
      "フォロワー規模が国内トップクラスで、ブランド案件・スポンサー獲得に十分な実績がある",
      "コンテンツの継続発信が定着しており、固定ファン層が形成されている",
    ],
    bads: [
      "影響力に対してマネタイズ導線が最適化されていない可能性がある",
      "コンテンツのジャンル拡張やコラボ施策で更なる新規層の獲得が見込める",
    ],
    nexts: [
      "ブランドパートナーシップや自社商品開発に向けたLP・販売導線を整える",
      "定期的なライブ配信やファンとの双方向コンテンツでエンゲージメントを強化する",
    ],
  },
  S: {
    summary: "100万フォロワー超えの実力派。プロの戦略次第でさらなる飛躍が狙えます。",
    goods: [
      "フォロワー規模が収益化の閾値を大きく超えており、影響力が確立されている",
      "継続的な投稿実績があり、アルゴリズムからの評価が安定している",
    ],
    bads: [
      "エンゲージメント率のさらなる改善で、おすすめ表示の拡大が期待できる",
      "プロフィールのCV導線（外部リンクやLINE誘導）が最適化されていない可能性がある",
    ],
    nexts: [
      "投稿の最初の3秒のフックを強化し、視聴完了率を上げることを優先する",
      "プロフィールリンクをLP or LINE公式に変更し、ファンの収益化導線を作る",
    ],
  },
  A: {
    summary: "バズの素地がある有望なアカウントです。戦略を整えれば急成長が見込めます。",
    goods: [
      "フォロワー規模が一定の水準に達しており、アルゴリズムへの露出が増えてきている",
      "コンテンツに独自性があり、新規ユーザーへの訴求力が育ってきている",
    ],
    bads: [
      "投稿頻度・時間帯の最適化が不十分で、リーチの取りこぼしが起きている可能性がある",
      "プロフィール文やアイコンのブランディングを強化することでCVRが改善できる",
    ],
    nexts: [
      "週3〜5回の投稿スケジュールを固定し、アルゴリズムへの継続シグナルを強化する",
      "他のAランク以上のクリエイターとのコラボ動画で相互フォロワーを獲得する",
    ],
  },
  B: {
    summary: "成長軌道に乗り始めているアカウントです。質と頻度を改善すれば次のステージへ進めます。",
    goods: [
      "継続して投稿できており、アカウントとしての基盤が整ってきている",
      "フォロワーが一定数いることで、新規コンテンツへの初動反応が生まれやすい",
    ],
    bads: [
      "動画の最初の1〜3秒のフックが弱く、スクロール離脱が多い可能性がある",
      "ハッシュタグやキャプション戦略が未最適化で、検索流入が少ない",
    ],
    nexts: [
      "バズっている同ジャンルの動画を分析し、最初の3秒の構成を真似てテストする",
      "投稿時間を19〜21時に固定し、アクティブユーザーへのリーチを増やす",
    ],
  },
  C: {
    summary: "これから伸びる可能性を秘めたアカウントです。正しい方向性で動けば半年後に大きく変わります。",
    goods: [
      "アカウントの方向性が固まれば、ターゲットに刺さるコンテンツを作れる段階にある",
      "競合が少ないニッチジャンルに特化することで一気に頭角を現す可能性がある",
    ],
    bads: [
      "投稿本数・頻度が不足しており、アルゴリズムからの評価が蓄積されていない",
      "プロフィールの完成度が低く、訪問ユーザーがフォローする理由が見つかりにくい",
    ],
    nexts: [
      "まず30本の動画を投稿し、どのコンテンツが反応されるかデータを集める",
      "プロフィール文・アイコン・ヘッダーを整え、アカウントの第一印象を強化する",
    ],
  },
};

function buildDiagnosisText(user: typeof usersTable.$inferSelect): string {
  const rank = user.rank ?? "C";
  const detail = RANK_DETAIL[rank] ?? RANK_DETAIL["C"];
  const diagDate = user.createdAt
    ? new Date(user.createdAt).toLocaleDateString("ja-JP")
    : "—";

  return [
    "[ TikTok診断結果 ]",
    "─────────────────",
    `アカウント : ${user.tiktokUsername ?? "不明"}`,
    `ランク     : ${rank}`,
    `総合スコア : ${user.score ?? 0} / 100点`,
    `フォロワー : ${(user.followers ?? 0).toLocaleString()}人`,
    `診断日     : ${diagDate}`,
    "",
    detail.summary,
    "",
    "[ 強み ]",
    `- ${detail.goods[0]}`,
    `- ${detail.goods[1]}`,
    "",
    "[ 改善点 ]",
    `- ${detail.bads[0]}`,
    `- ${detail.bads[1]}`,
    "",
    "[ 今すぐできるアクション ]",
    `1. ${detail.nexts[0]}`,
    `2. ${detail.nexts[1]}`,
  ].join("\n");
}

// LINE user ID で紐付けられた最新診断を取得
async function getDiagnosisByLineId(lineUserId: string) {
  const rows = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.lineUserId, lineUserId), isNotNull(usersTable.tiktokUsername)))
    .orderBy(desc(usersTable.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

// TikTokユーザー名で最新診断を取得し、LINE user ID を紐付け
async function linkAndGetDiagnosis(lineUserId: string, rawUsername: string) {
  const username = "@" + rawUsername.replace(/^@/, "").toLowerCase();
  const rows = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.tiktokUsername, username))
    .orderBy(desc(usersTable.createdAt))
    .limit(1);
  if (rows.length === 0) return null;
  // LINE user ID を紐付け
  await db
    .update(usersTable)
    .set({ lineUserId, lineRegistered: true })
    .where(eq(usersTable.id, rows[0].id));
  return rows[0];
}

router.post("/line-webhook", async (req, res) => {
  const signature = req.headers["x-line-signature"] as string;
  const rawBody: string = (req as any).rawBody ?? "";

  if (!verifySignature(rawBody, signature)) {
    res.status(403).send("Invalid signature");
    return;
  }

  // LINE Platform には即200を返す
  res.status(200).send("OK");

  const events: any[] = (req.body as any).events ?? [];
  console.log(`[LINE] received ${events.length} event(s)`);

  for (const event of events) {
    try {
      console.log(`[LINE] event type=${event.type} text=${event.message?.text ?? event.postback?.data ?? ""}`);
      const lineUserId: string = event.source?.userId ?? "";

      // ===== 友達追加 =====
      if (event.type === "follow") {
        // すでに紐付けがあれば診断結果を送信
        const existing = lineUserId ? await getDiagnosisByLineId(lineUserId) : null;
        if (existing) {
          await replyMessage(event.replyToken, [
            { type: "text", text: "前回の診断結果をお届けします。" },
            { type: "text", text: buildDiagnosisText(existing) },
          ]);
        } else {
          await replyMessage(event.replyToken, [
            {
              type: "text",
              text: [
                "SIN JAPANのTikTok診断ツールへようこそ。",
                "",
                "リッチメニューの「診断結果を見る」を",
                "タップして診断結果を受け取ってください。",
              ].join("\n"),
            },
          ]);
        }

      // ===== postback（リッチメニューボタン）=====
      } else if (event.type === "postback") {
        const data: string = (event.postback?.data ?? "").trim();
        const existing = lineUserId ? await getDiagnosisByLineId(lineUserId) : null;
        if (existing) {
          await replyMessage(event.replyToken, [
            { type: "text", text: buildDiagnosisText(existing) },
          ]);
        } else {
          if (lineUserId) pendingUsername.set(lineUserId, true);
          await replyMessage(event.replyToken, [
            {
              type: "text",
              text: [
                "診断結果を取得します。",
                "",
                "あなたのTikTokユーザー名を送ってください。",
                "例: @yourusername",
              ].join("\n"),
            },
          ]);
        }

      // ===== テキストメッセージ =====
      } else if (event.type === "message" && event.message?.type === "text") {
        const text: string = event.message.text.trim();

        // ① リッチメニューの「診断結果を見る」トリガー（全角スペース等に対応）
        if (text === "診断結果を見る" || text.includes("診断結果を見る")) {
          const existing = lineUserId ? await getDiagnosisByLineId(lineUserId) : null;
          if (existing) {
            // 紐付け済み → すぐに診断結果を送信
            await replyMessage(event.replyToken, [
              { type: "text", text: buildDiagnosisText(existing) },
            ]);
          } else {
            // 未紐付け → TikTokユーザー名を聞く
            if (lineUserId) pendingUsername.set(lineUserId, true);
            await replyMessage(event.replyToken, [
              {
                type: "text",
                text: [
                  "診断結果を取得します。",
                  "",
                  "あなたのTikTokユーザー名を送ってください。",
                  "例: @yourusername",
                ].join("\n"),
              },
            ]);
          }

        // ② ユーザー名入力待ち中のメッセージ → TikTokユーザー名として処理
        } else if (lineUserId && pendingUsername.has(lineUserId)) {
          pendingUsername.delete(lineUserId);
          const user = await linkAndGetDiagnosis(lineUserId, text);
          if (user) {
            await replyMessage(event.replyToken, [
              { type: "text", text: "診断結果をお届けします。" },
              { type: "text", text: buildDiagnosisText(user) },
            ]);
          } else {
            await replyMessage(event.replyToken, [
              {
                type: "text",
                text: [
                  `「${text}」の診断データが見つかりませんでした。`,
                  "",
                  "先に診断を受けてからもう一度お試しください。",
                  "https://tiktokshindan.com",
                ].join("\n"),
              },
            ]);
          }

        // ③ それ以外のメッセージ → TikTokユーザー名として試みる
        } else if (text.startsWith("@") || /^[a-zA-Z0-9._]+$/.test(text)) {
          const user = lineUserId ? await linkAndGetDiagnosis(lineUserId, text) : null;
          if (user) {
            await replyMessage(event.replyToken, [
              { type: "text", text: buildDiagnosisText(user) },
            ]);
          } else {
            await replyMessage(event.replyToken, [
              {
                type: "text",
                text: [
                  `「${text}」の診断データが見つかりませんでした。`,
                  "",
                  "まず下記で無料診断を受けてください。",
                  "https://tiktokshindan.com",
                ].join("\n"),
              },
            ]);
          }
        }
      }
    } catch (err) {
      console.error("LINE webhook error:", err);
    }
  }
});

export default router;
