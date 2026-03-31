import { Router } from "express";
import crypto from "crypto";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";

const router = Router();

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "";
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET ?? "";

function verifySignature(rawBody: string, signature: string): boolean {
  if (!CHANNEL_SECRET) return false;
  const hash = crypto
    .createHmac("SHA256", CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");
  return hash === signature;
}

async function replyMessage(replyToken: string, messages: object[]) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
}

const RANK_EMOJI: Record<string, string> = {
  GOD: "👑", S: "⭐", A: "🔥", B: "📈", C: "🌱",
};

function buildDiagnosisMessages(user: typeof usersTable.$inferSelect): object[] {
  const rank = user.rank ?? "C";
  const emoji = RANK_EMOJI[rank] ?? "📊";
  const diagDate = user.createdAt
    ? new Date(user.createdAt).toLocaleDateString("ja-JP")
    : "—";

  return [
    {
      type: "text",
      text: [
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
        "",
        "📲 詳しい無料相談はこちら",
        "https://lin.ee/8j8NWHn",
      ].join("\n"),
    },
  ];
}

router.post("/line-webhook", async (req, res) => {
  const signature = req.headers["x-line-signature"] as string;
  const rawBody: string = (req as any).rawBody ?? "";

  if (!verifySignature(rawBody, signature)) {
    res.status(403).send("Invalid signature");
    return;
  }

  res.status(200).send("OK");

  const events: any[] = (req.body as any).events ?? [];

  for (const event of events) {
    try {
      if (event.type === "follow") {
        await replyMessage(event.replyToken, [
          {
            type: "text",
            text: [
              "SIN JAPANのTikTok診断ツールへようこそ！🎉",
              "",
              "診断結果をお届けします。",
              "あなたのTikTokユーザー名を送ってください。",
              "",
              "例: @yourusername",
            ].join("\n"),
          },
        ]);
      } else if (event.type === "message" && event.message?.type === "text") {
        const text: string = event.message.text.trim();
        const username = text.replace(/^@/, "").toLowerCase();

        if (!username || username.length < 1) continue;

        const rows = await db
          .select()
          .from(usersTable)
          .where(eq(usersTable.tiktokUsername, "@" + username))
          .orderBy(desc(usersTable.createdAt))
          .limit(1);

        if (rows.length > 0) {
          await replyMessage(event.replyToken, buildDiagnosisMessages(rows[0]));
        } else {
          await replyMessage(event.replyToken, [
            {
              type: "text",
              text: [
                `@${username} の診断データが見つかりませんでした。`,
                "",
                "まず下記で無料診断を受けてください👇",
                "https://tiktokshindan.com",
              ].join("\n"),
            },
          ]);
        }
      }
    } catch (err) {
      console.error("LINE webhook error:", err);
    }
  }
});

export default router;
