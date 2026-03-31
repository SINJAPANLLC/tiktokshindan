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

const RANK_EMOJI: Record<string, string> = {
  GOD: "👑", S: "⭐", A: "🔥", B: "📈", C: "🌱",
};

function buildDiagnosisText(user: typeof usersTable.$inferSelect): string {
  const rank = user.rank ?? "C";
  const emoji = RANK_EMOJI[rank] ?? "📊";
  const diagDate = user.createdAt
    ? new Date(user.createdAt).toLocaleDateString("ja-JP")
    : "—";
  return [
    `${emoji} TikTok診断結果`,
    "━━━━━━━━━━━━━━",
    `アカウント: ${user.tiktokUsername ?? "不明"}`,
    `ランク: ${rank} ${emoji}`,
    `総合スコア: ${user.score ?? 0}/100点`,
    `フォロワー: ${(user.followers ?? 0).toLocaleString()}人`,
    `診断日: ${diagDate}`,
    "━━━━━━━━━━━━━━",
    "SIN JAPANのTikTokコンサルタントが",
    "あなたのアカウント成長をサポートします！",
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
            { type: "text", text: "おかえりなさい！前回の診断結果をお届けします😊" },
            { type: "text", text: buildDiagnosisText(existing) },
          ]);
        } else {
          await replyMessage(event.replyToken, [
            {
              type: "text",
              text: [
                "SIN JAPANのTikTok診断ツールへようこそ！🎉",
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
                "あなたのTikTokユーザー名を送ってください👇",
                "（例: @yourusername）",
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
                  "あなたのTikTokユーザー名を送ってください👇",
                  "（例: @yourusername）",
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
              { type: "text", text: "紐付けが完了しました！診断結果をお届けします✅" },
              { type: "text", text: buildDiagnosisText(user) },
            ]);
          } else {
            await replyMessage(event.replyToken, [
              {
                type: "text",
                text: [
                  `「${text}」の診断データが見つかりませんでした。`,
                  "",
                  "先に診断を受けてからもう一度お試しください👇",
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
                  "まず下記で無料診断を受けてください👇",
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
