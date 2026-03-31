import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { sql, desc } from "drizzle-orm";

const router: IRouter = Router();

router.get("/admin/stats", async (req, res) => {
  try {
    const overviewResult = await db.execute(sql`
      SELECT
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE)::int as today,
        COUNT(*) FILTER (WHERE line_registered=TRUE)::int as line_total,
        COUNT(*) FILTER (WHERE line_registered=TRUE AND created_at::date=CURRENT_DATE)::int as line_today,
        ROUND(COUNT(*) FILTER (WHERE line_registered=TRUE)::numeric / NULLIF(COUNT(*),0) * 100, 1) as line_cvr,
        ROUND(COUNT(*) FILTER (WHERE saved=TRUE)::numeric / NULLIF(COUNT(*),0) * 100, 1) as save_rate,
        ROUND(AVG(dwell_time))::int as avg_dwell
      FROM tiktok_users
    `);
    const overview = overviewResult.rows[0];

    const dailyResult = await db.execute(sql`
      SELECT DATE(created_at) as date, COUNT(*)::int as cnt
      FROM tiktok_users WHERE created_at >= NOW() - INTERVAL '14 days'
      GROUP BY DATE(created_at) ORDER BY date
    `);

    const hourlyResult = await db.execute(sql`
      SELECT EXTRACT(HOUR FROM created_at)::int as hour, COUNT(*)::int as cnt
      FROM tiktok_users GROUP BY hour ORDER BY hour
    `);

    const weeklyResult = await db.execute(sql`
      SELECT EXTRACT(DOW FROM created_at)::int as dow, COUNT(*)::int as cnt
      FROM tiktok_users GROUP BY dow ORDER BY dow
    `);

    const rankDistResult = await db.execute(sql`
      SELECT rank, COUNT(*)::int as cnt FROM tiktok_users WHERE rank IS NOT NULL GROUP BY rank
    `);

    const rankCvrResult = await db.execute(sql`
      SELECT rank,
        ROUND(COUNT(*) FILTER (WHERE line_registered=TRUE)::numeric / NULLIF(COUNT(*),0) * 100, 1) as line_cvr,
        ROUND(COUNT(*) FILTER (WHERE saved=TRUE)::numeric / NULLIF(COUNT(*),0) * 100, 1) as save_rate
      FROM tiktok_users WHERE rank IS NOT NULL GROUP BY rank
    `);

    const geoResult = await db.execute(sql`
      SELECT pref, COUNT(*)::int as cnt FROM tiktok_users
      WHERE pref IS NOT NULL AND pref != '不明' GROUP BY pref ORDER BY cnt DESC LIMIT 10
    `);

    const cityResult = await db.execute(sql`
      SELECT city, COUNT(*)::int as cnt FROM tiktok_users
      WHERE city IS NOT NULL AND city != '不明' GROUP BY city ORDER BY cnt DESC LIMIT 8
    `);

    res.json({
      overview,
      daily: dailyResult.rows,
      hourly: hourlyResult.rows,
      weekly: weeklyResult.rows,
      rank_dist: rankDistResult.rows,
      rank_cvr: rankCvrResult.rows,
      geo: geoResult.rows,
      city: cityResult.rows,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch admin stats");
    res.status(500).json({ error: "統計の取得に失敗しました" });
  }
});

router.get("/recent-users", async (req, res) => {
  try {
    const result = await db.execute(sql`
      SELECT tiktok_username, image_url, rank
      FROM tiktok_users
      WHERE rank IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 30
    `);
    res.json(result.rows);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch recent users");
    res.status(500).json({ error: "ユーザーの取得に失敗しました" });
  }
});

router.get("/admin/users", async (req, res) => {
  try {
    const users = await db
      .select()
      .from(usersTable)
      .orderBy(desc(usersTable.createdAt))
      .limit(50);
    res.json(users);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch users");
    res.status(500).json({ error: "ユーザーの取得に失敗しました" });
  }
});

export default router;
