#!/usr/bin/env python3
"""
SIN JAPAN TikTok診断ツール
Replit セットアップスクリプト

使い方:
1. このファイルをReplitにアップロード
2. Shellで: python setup.py
3. .envファイルにAPIキーを設定
4. python main.py で起動
"""

import os
import subprocess

files = {

# ============================================================
# main.py
# ============================================================
"main.py": '''
from fastapi import FastAPI, UploadFile, File, Form, Request
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
import anthropic
import uuid
import json
import os
from datetime import datetime
from database import get_db, save_user, get_stats, get_users, update_line
from dotenv import load_dotenv

load_dotenv()
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
def root():
    return FileResponse("static/index.html")

@app.get("/admin")
def admin():
    return FileResponse("static/admin.html")

@app.post("/api/diagnose")
async def diagnose(
    request: Request,
    image: UploadFile = File(...),
    device: str = Form(""),
    language: str = Form(""),
    screen: str = Form(""),
    referer: str = Form(""),
    network: str = Form(""),
    scroll_depth: int = Form(0),
    operation_count: int = Form(0),
    dwell_time: int = Form(0),
):
    # 画像保存
    image_data = await image.read()
    image_id = str(uuid.uuid4())
    image_path = f"static/uploads/{image_id}.jpg"
    os.makedirs("static/uploads", exist_ok=True)
    with open(image_path, "wb") as f:
        f.write(image_data)

    # Claude Vision API で解析
    client = anthropic.Anthropic(api_key=os.getenv("CLAUDE_API_KEY"))
    import base64
    b64 = base64.standard_b64encode(image_data).decode("utf-8")

    vision_prompt = """
このTikTokのプロフィール画面のスクリーンショットから以下の情報をJSONで返してください。
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

JSONのみ返してください。マークダウンは不要です。
"""

    vision_res = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=500,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}},
                {"type": "text", "text": vision_prompt}
            ]
        }]
    )

    try:
        tiktok_data = json.loads(vision_res.content[0].text)
    except:
        tiktok_data = {"tiktok_username": None, "followers": 0, "likes": 0, "bio": "", "genre": "その他"}

    # ランク・スコア算出
    followers = tiktok_data.get("followers") or 0
    likes = tiktok_data.get("likes") or 0
    engagement = (likes / followers * 100) if followers > 0 else 0

    buzz_potential = min(100, int(engagement * 2 + followers / 10000 * 10))
    engagement_score = min(100, int(engagement * 3))
    profile_score = 60 if tiktok_data.get("bio") else 30
    consistency_score = 65
    monetization_score = 50 if tiktok_data.get("is_business") else 35

    total = int((buzz_potential + engagement_score + profile_score + consistency_score + monetization_score) / 5)

    if total >= 90: rank = "GOD"
    elif total >= 78: rank = "S"
    elif total >= 65: rank = "A"
    elif total >= 50: rank = "B"
    else: rank = "C"

    rank_titles = {"GOD":"TikTokの申し子","S":"眠れる怪物","A":"隠れた本物","B":"爆発前夜","C":"伸びしろしかない"}
    rank_descs = {
        "GOD": "フォロワー数・エンゲージメント・コンテンツの質、すべてが規格外だ。このアカウントは本物。",
        "S": "フォロワー数の規模を超えたエンゲージメントを持つ。正しい戦略があれば3ヶ月以内に爆発的な成長が見込める。",
        "A": "影響力の核となる要素はすでに揃っている。あとは収益化の仕組みを乗せるだけ。",
        "B": "アルゴリズムに乗りかけているシグナルが出ている。あと一押しでバズの連鎖が始まる。",
        "C": "現状はまだ成長途中。改善ポイントが明確な分、伸びしろは全ランク中で最大だ。",
    }

    # IPから位置情報取得（簡易）
    client_ip = request.client.host
    pref = "不明"
    city = "不明"
    try:
        import httpx
        geo_res = httpx.get(f"http://ip-api.com/json/{client_ip}?lang=ja&fields=regionName,city", timeout=2)
        geo_data = geo_res.json()
        pref = geo_data.get("regionName", "不明")
        city = geo_data.get("city", "不明")
    except:
        pass

    # DB保存
    user_id = str(uuid.uuid4())
    save_user({
        "id": user_id,
        "created_at": datetime.utcnow().isoformat(),
        "tiktok_username": tiktok_data.get("tiktok_username"),
        "followers": followers,
        "rank": rank,
        "score": total,
        "pref": pref,
        "city": city,
        "device": device[:100],
        "browser": "",
        "language": language,
        "network": network,
        "screen_size": screen,
        "dwell_time": dwell_time,
        "scroll_depth": scroll_depth,
        "operation_count": operation_count,
        "revisit_count": 1,
        "line_registered": False,
        "saved": False,
        "image_url": f"/static/uploads/{image_id}.jpg",
        "referer": referer[:200],
        "genre": tiktok_data.get("genre", "その他"),
    })

    return {
        "rank": rank,
        "title": rank_titles[rank],
        "desc": rank_descs[rank],
        "total": total,
        "user_id": user_id,
        "tiktok_username": tiktok_data.get("tiktok_username") or "@あなたのアカウント",
        "scores": [
            {"name": "バズポテンシャル", "val": buzz_potential},
            {"name": "エンゲージメント率", "val": engagement_score},
            {"name": "プロフィール訴求力", "val": profile_score},
            {"name": "コンテンツの一貫性", "val": consistency_score},
            {"name": "収益化の準備度", "val": monetization_score},
        ],
        "goods": [
            f"フォロワー{followers:,}人に対してエンゲージメントが高水準を維持している",
            "プロフィールに独自性があり、ジャンルが明確に伝わる構成になっている",
        ],
        "bads": [
            "収益化への導線が設計されておらず、影響力が収益に転換されていない",
        ],
        "nexts": [
            "プロフィールリンクをLPに変えるだけで問い合わせが大幅に増加する",
            "最初の3秒のフックを強化することで視聴完了率を劇的に改善できる",
        ],
    }

@app.post("/api/save-result")
async def save_result_api(data: dict):
    from database import update_saved
    update_saved(data.get("user_id"))
    return {"ok": True}

@app.post("/api/line-register")
async def line_register(data: dict):
    update_line(data.get("user_id"))
    return {"ok": True}

@app.get("/api/admin/stats")
def admin_stats():
    return get_stats()

@app.get("/api/admin/users")
def admin_users():
    return get_users()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
''',

# ============================================================
# database.py
# ============================================================
"database.py": '''
import os
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv()
DATABASE_URL = os.getenv("DATABASE_URL")

def get_conn():
    return psycopg2.connect(DATABASE_URL, sslmode="require")

def init_db():
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        created_at TIMESTAMP,
        tiktok_username TEXT,
        followers INTEGER DEFAULT 0,
        rank TEXT,
        score INTEGER DEFAULT 0,
        pref TEXT,
        city TEXT,
        device TEXT,
        browser TEXT,
        language TEXT,
        network TEXT,
        screen_size TEXT,
        dwell_time INTEGER DEFAULT 0,
        scroll_depth INTEGER DEFAULT 0,
        operation_count INTEGER DEFAULT 0,
        revisit_count INTEGER DEFAULT 1,
        line_registered BOOLEAN DEFAULT FALSE,
        saved BOOLEAN DEFAULT FALSE,
        image_url TEXT,
        referer TEXT,
        genre TEXT
    )
    """)
    conn.commit()
    cur.close()
    conn.close()

def save_user(data: dict):
    init_db()
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("""
    INSERT INTO users (id,created_at,tiktok_username,followers,rank,score,pref,city,
        device,browser,language,network,screen_size,dwell_time,scroll_depth,
        operation_count,revisit_count,line_registered,saved,image_url,referer,genre)
    VALUES (%(id)s,%(created_at)s,%(tiktok_username)s,%(followers)s,%(rank)s,%(score)s,
        %(pref)s,%(city)s,%(device)s,%(browser)s,%(language)s,%(network)s,%(screen_size)s,
        %(dwell_time)s,%(scroll_depth)s,%(operation_count)s,%(revisit_count)s,
        %(line_registered)s,%(saved)s,%(image_url)s,%(referer)s,%(genre)s)
    """, data)
    conn.commit()
    cur.close()
    conn.close()

def update_line(user_id: str):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("UPDATE users SET line_registered=TRUE WHERE id=%s", (user_id,))
    conn.commit()
    cur.close()
    conn.close()

def update_saved(user_id: str):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("UPDATE users SET saved=TRUE WHERE id=%s", (user_id,))
    conn.commit()
    cur.close()
    conn.close()

def get_stats():
    conn = get_conn()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
    SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) as today,
        COUNT(*) FILTER (WHERE line_registered=TRUE) as line_total,
        COUNT(*) FILTER (WHERE line_registered=TRUE AND created_at::date=CURRENT_DATE) as line_today,
        ROUND(COUNT(*) FILTER (WHERE line_registered=TRUE)::numeric / NULLIF(COUNT(*),0) * 100, 1) as line_cvr,
        ROUND(COUNT(*) FILTER (WHERE saved=TRUE)::numeric / NULLIF(COUNT(*),0) * 100, 1) as save_rate,
        ROUND(AVG(dwell_time)) as avg_dwell,
        COUNT(DISTINCT tiktok_username) FILTER (WHERE revisit_count > 1)::numeric / NULLIF(COUNT(*),0) * 100 as revisit_rate
    FROM users
    """)
    overview = dict(cur.fetchone())

    cur.execute("""
    SELECT DATE(created_at) as date, COUNT(*) as cnt
    FROM users WHERE created_at >= NOW() - INTERVAL '14 days'
    GROUP BY DATE(created_at) ORDER BY date
    """)
    daily = [dict(r) for r in cur.fetchall()]

    cur.execute("""
    SELECT EXTRACT(HOUR FROM created_at) as hour, COUNT(*) as cnt
    FROM users GROUP BY hour ORDER BY hour
    """)
    hourly = [dict(r) for r in cur.fetchall()]

    cur.execute("""
    SELECT EXTRACT(DOW FROM created_at) as dow, COUNT(*) as cnt
    FROM users GROUP BY dow ORDER BY dow
    """)
    weekly = [dict(r) for r in cur.fetchall()]

    cur.execute("SELECT rank, COUNT(*) as cnt FROM users GROUP BY rank")
    rank_dist = [dict(r) for r in cur.fetchall()]

    cur.execute("""
    SELECT rank,
        ROUND(COUNT(*) FILTER (WHERE line_registered=TRUE)::numeric / NULLIF(COUNT(*),0) * 100, 1) as line_cvr,
        ROUND(COUNT(*) FILTER (WHERE saved=TRUE)::numeric / NULLIF(COUNT(*),0) * 100, 1) as save_rate
    FROM users GROUP BY rank
    """)
    rank_cvr = [dict(r) for r in cur.fetchall()]

    cur.execute("""
    SELECT pref, COUNT(*) as cnt FROM users
    WHERE pref IS NOT NULL GROUP BY pref ORDER BY cnt DESC LIMIT 10
    """)
    geo = [dict(r) for r in cur.fetchall()]

    cur.execute("""
    SELECT city, COUNT(*) as cnt FROM users
    WHERE city IS NOT NULL GROUP BY city ORDER BY cnt DESC LIMIT 8
    """)
    city = [dict(r) for r in cur.fetchall()]

    cur.close()
    conn.close()
    return {"overview": overview, "daily": daily, "hourly": hourly, "weekly": weekly,
            "rank_dist": rank_dist, "rank_cvr": rank_cvr, "geo": geo, "city": city}

def get_users(limit=20):
    conn = get_conn()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT * FROM users ORDER BY created_at DESC LIMIT %s", (limit,))
    rows = [dict(r) for r in cur.fetchall()]
    cur.close()
    conn.close()
    return rows
''',

# ============================================================
# requirements.txt
# ============================================================
"requirements.txt": '''fastapi
uvicorn
anthropic
psycopg2-binary
python-dotenv
python-multipart
httpx
''',

# ============================================================
# .env.example
# ============================================================
".env.example": '''CLAUDE_API_KEY=sk-ant-xxxxxxxx
DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/neondb
''',

}

# ファイル生成
for filename, content in files.items():
    dirpath = os.path.dirname(filename)
    if dirpath:
        os.makedirs(dirpath, exist_ok=True)
    with open(filename, "w", encoding="utf-8") as f:
        f.write(content.strip())
    print(f"✓ {filename}")

# staticディレクトリ作成
os.makedirs("static/uploads", exist_ok=True)
print("✓ static/uploads/")

print("""
====================================
セットアップ完了

次のステップ:
1. static/index.html  → 診断ツールのHTMLを配置
2. static/admin.html  → 管理画面のHTMLを配置
3. .env.example を .env にコピーしてAPIキーを設定
4. pip install -r requirements.txt
5. python main.py
====================================
""")
