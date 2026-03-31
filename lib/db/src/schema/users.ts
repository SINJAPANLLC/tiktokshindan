import { pgTable, text, integer, boolean, timestamp, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("tiktok_users", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  tiktokUsername: text("tiktok_username"),
  followers: integer("followers").default(0),
  rank: text("rank"),
  score: integer("score").default(0),
  pref: text("pref"),
  city: text("city"),
  device: text("device"),
  browser: text("browser"),
  language: text("language"),
  network: text("network"),
  screenSize: text("screen_size"),
  dwellTime: integer("dwell_time").default(0),
  scrollDepth: integer("scroll_depth").default(0),
  operationCount: integer("operation_count").default(0),
  revisitCount: integer("revisit_count").default(1),
  lineRegistered: boolean("line_registered").default(false),
  saved: boolean("saved").default(false),
  imageUrl: text("image_url"),
  referer: text("referer"),
  genre: text("genre"),
  apiCostUsd: numeric("api_cost_usd", { precision: 10, scale: 6 }).default("0"),
  lineUserId: text("line_user_id"),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type TiktokUser = typeof usersTable.$inferSelect;
