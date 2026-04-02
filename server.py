import os
import hashlib
import tempfile
import datetime

import whisper
import pymysql
import pymysql.cursors
from flask import Flask, request, jsonify, g, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
from openai import OpenAI
import bcrypt
import jwt as pyjwt

load_dotenv()

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# ── Статические файлы ─────────────────────────────────
@app.route('/')
def root():
    return send_from_directory('.', 'login.html')

@app.route('/<path:filename>')
def static_files(filename):
    if filename.startswith('api/'):
        return jsonify({"error": "Not found"}), 404
    return send_from_directory('.', filename)

# ── Клиенты ───────────────────────────────────────────
openai_client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

print("Загрузка модели Whisper (large-v3)...")
whisper_model = whisper.load_model("large-v3")
print("Модель загружена.")

JWT_SECRET  = os.environ.get("JWT_SECRET") or "fallback_secret_change_me"
JWT_ALGO    = "HS256"
ACCESS_TTL  = datetime.timedelta(hours=24)
REFRESH_TTL = datetime.timedelta(days=30)


# ── БД ────────────────────────────────────────────────
def get_db():
    if "db" not in g:
        g.db = pymysql.connect(
            host     = os.environ.get("MYSQL_HOST", "localhost"),
            port     = int(os.environ.get("MYSQL_PORT", 3306)),
            user     = os.environ.get("MYSQL_USER", "root"),
            password = os.environ.get("MYSQL_PASSWORD", ""),
            database = os.environ.get("MYSQL_DATABASE", "chatapp"),
            charset  = "utf8mb4",
            cursorclass = pymysql.cursors.DictCursor,
            autocommit  = False,
        )
    return g.db

@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db:
        try:
            db.close()
        except Exception:
            pass


# ── JWT ───────────────────────────────────────────────
def make_tokens(user_id, email):
    now = datetime.datetime.now(datetime.timezone.utc)
    access_payload = {
        "sub":   str(user_id),
        "email": email,
        "exp":   now + ACCESS_TTL,
        "type":  "access"
    }
    refresh_payload = {
        "sub":  str(user_id),
        "exp":  now + REFRESH_TTL,
        "type": "refresh"
    }
    access  = pyjwt.encode(access_payload,  JWT_SECRET, algorithm=JWT_ALGO)
    refresh = pyjwt.encode(refresh_payload, JWT_SECRET, algorithm=JWT_ALGO)

    token_hash = hashlib.sha256(refresh.encode()).hexdigest()
    db = get_db()
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (%s, %s, %s)",
            (user_id, token_hash, now + REFRESH_TTL)
        )
    db.commit()
    return access, refresh


def require_auth(f):
    from functools import wraps
    @wraps(f)
    def wrapper(*args, **kwargs):
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return jsonify({"error": "Нет токена"}), 401
        token = auth[7:].strip()
        try:
            payload = pyjwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
            if payload.get("type") != "access":
                return jsonify({"error": "Неверный тип токена"}), 401
            g.user_id    = int(payload["sub"])
            g.user_email = payload.get("email", "")
        except pyjwt.ExpiredSignatureError:
            return jsonify({"error": "Токен истёк"}), 401
        except pyjwt.InvalidTokenError as e:
            return jsonify({"error": "Недействительный токен: " + str(e)}), 401
        return f(*args, **kwargs)
    return wrapper


# ══════════════════════════════════════════════════════
#  AUTH
# ══════════════════════════════════════════════════════

@app.route("/api/auth/register", methods=["POST"])
def register():
    data     = request.get_json() or {}
    email    = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    if not email or not password:
        return jsonify({"error": "Заполните все поля"}), 400
    if len(password) < 6:
        return jsonify({"error": "Пароль минимум 6 символов"}), 400

    pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    db = get_db()
    try:
        with db.cursor() as cur:
            cur.execute(
                "INSERT INTO users (email, password_hash) VALUES (%s, %s)",
                (email, pw_hash)
            )
            user_id = cur.lastrowid
        db.commit()
    except pymysql.IntegrityError:
        return jsonify({"error": "Email уже зарегистрирован"}), 409
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    access, refresh = make_tokens(user_id, email)
    return jsonify({"access_token": access, "refresh_token": refresh, "email": email}), 201


@app.route("/api/auth/login", methods=["POST"])
def login():
    data     = request.get_json() or {}
    email    = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    if not email or not password:
        return jsonify({"error": "Заполните все поля"}), 400

    db = get_db()
    try:
        with db.cursor() as cur:
            cur.execute("SELECT id, password_hash FROM users WHERE email=%s", (email,))
            user = cur.fetchone()
    except Exception as e:
        return jsonify({"error": "Ошибка БД: " + str(e)}), 500

    if not user or not bcrypt.checkpw(password.encode(), user["password_hash"].encode()):
        return jsonify({"error": "Неверный email или пароль"}), 401

    access, refresh = make_tokens(user["id"], email)
    return jsonify({"access_token": access, "refresh_token": refresh, "email": email})


@app.route("/api/auth/refresh", methods=["POST"])
def refresh_token():
    data  = request.get_json() or {}
    token = data.get("refresh_token") or ""
    if not token:
        return jsonify({"error": "Нет токена"}), 401

    try:
        payload = pyjwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
        if payload.get("type") != "refresh":
            return jsonify({"error": "Неверный тип токена"}), 401
    except pyjwt.ExpiredSignatureError:
        return jsonify({"error": "Refresh токен истёк"}), 401
    except Exception as e:
        return jsonify({"error": "Недействительный токен: " + str(e)}), 401

    token_hash = hashlib.sha256(token.encode()).hexdigest()
    db = get_db()
    with db.cursor() as cur:
        cur.execute(
            "SELECT id FROM refresh_tokens WHERE token_hash=%s AND expires_at > NOW()",
            (token_hash,)
        )
        row = cur.fetchone()
    if not row:
        return jsonify({"error": "Токен отозван или истёк"}), 401

    with db.cursor() as cur:
        cur.execute("DELETE FROM refresh_tokens WHERE token_hash=%s", (token_hash,))
    db.commit()

    user_id = int(payload["sub"])
    with db.cursor() as cur:
        cur.execute("SELECT email FROM users WHERE id=%s", (user_id,))
        u = cur.fetchone()
    email = u["email"] if u else ""
    access, new_refresh = make_tokens(user_id, email)
    return jsonify({"access_token": access, "refresh_token": new_refresh})


@app.route("/api/auth/change-password", methods=["POST"])
@require_auth
def change_password():
    data   = request.get_json() or {}
    old_pw = data.get("old_password") or ""
    new_pw = data.get("new_password") or ""
    if not old_pw or not new_pw:
        return jsonify({"error": "Заполните все поля"}), 400
    if len(new_pw) < 6:
        return jsonify({"error": "Пароль минимум 6 символов"}), 400

    db = get_db()
    with db.cursor() as cur:
        cur.execute("SELECT password_hash FROM users WHERE id=%s", (g.user_id,))
        user = cur.fetchone()
    if not user or not bcrypt.checkpw(old_pw.encode(), user["password_hash"].encode()):
        return jsonify({"error": "Неверный текущий пароль"}), 400

    new_hash = bcrypt.hashpw(new_pw.encode(), bcrypt.gensalt()).decode()
    with db.cursor() as cur:
        cur.execute("UPDATE users SET password_hash=%s WHERE id=%s", (new_hash, g.user_id))
        cur.execute("DELETE FROM refresh_tokens WHERE user_id=%s", (g.user_id,))
    db.commit()
    return jsonify({"ok": True})


# ══════════════════════════════════════════════════════
#  CHATS
# ══════════════════════════════════════════════════════

@app.route("/api/chats", methods=["GET"])
@require_auth
def list_chats():
    db = get_db()
    with db.cursor() as cur:
        cur.execute(
            "SELECT id, name, created_at, updated_at FROM chats "
            "WHERE user_id=%s ORDER BY updated_at DESC",
            (g.user_id,)
        )
        rows = cur.fetchall()
    for r in rows:
        r["created_at"] = r["created_at"].isoformat()
        r["updated_at"] = r["updated_at"].isoformat()
    return jsonify(rows)


@app.route("/api/chats", methods=["POST"])
@require_auth
def create_chat():
    # Принимаем как JSON так и пустой body
    try:
        data = request.get_json(silent=True) or {}
    except Exception:
        data = {}

    d    = datetime.datetime.now()
    name = (data.get("name") or "").strip()
    if not name:
        name = "Новый чат: " + d.strftime("%Y.%m.%d")

    db = get_db()
    try:
        with db.cursor() as cur:
            cur.execute(
                "INSERT INTO chats (user_id, name) VALUES (%s, %s)",
                (g.user_id, name)
            )
            chat_id = cur.lastrowid
        db.commit()
        with db.cursor() as cur:
            cur.execute(
                "SELECT id, name, created_at, updated_at FROM chats WHERE id=%s",
                (chat_id,)
            )
            chat = cur.fetchone()
        chat["created_at"] = chat["created_at"].isoformat()
        chat["updated_at"] = chat["updated_at"].isoformat()
        return jsonify(chat), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/chats/<int:chat_id>", methods=["PATCH"])
@require_auth
def rename_chat(chat_id):
    try:
        data = request.get_json(silent=True) or {}
    except Exception:
        data = {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Пустое имя"}), 400
    db = get_db()
    with db.cursor() as cur:
        cur.execute(
            "UPDATE chats SET name=%s WHERE id=%s AND user_id=%s",
            (name, chat_id, g.user_id)
        )
        affected = cur.rowcount
    db.commit()
    if not affected:
        return jsonify({"error": "Чат не найден"}), 404
    return jsonify({"ok": True, "name": name})


@app.route("/api/chats/<int:chat_id>", methods=["DELETE"])
@require_auth
def delete_chat(chat_id):
    db = get_db()
    with db.cursor() as cur:
        cur.execute(
            "DELETE FROM chats WHERE id=%s AND user_id=%s",
            (chat_id, g.user_id)
        )
        affected = cur.rowcount
    db.commit()
    if not affected:
        return jsonify({"error": "Чат не найден"}), 404
    return jsonify({"ok": True})


@app.route("/api/chats/<int:chat_id>/messages", methods=["GET"])
@require_auth
def get_messages(chat_id):
    db = get_db()
    with db.cursor() as cur:
        cur.execute(
            "SELECT id FROM chats WHERE id=%s AND user_id=%s",
            (chat_id, g.user_id)
        )
        if not cur.fetchone():
            return jsonify({"error": "Чат не найден"}), 404
        cur.execute(
            "SELECT id, role, content, created_at FROM messages "
            "WHERE chat_id=%s ORDER BY created_at ASC",
            (chat_id,)
        )
        rows = cur.fetchall()
    for r in rows:
        r["created_at"] = r["created_at"].isoformat()
    return jsonify(rows)


# ══════════════════════════════════════════════════════
#  GPT-4o
# ══════════════════════════════════════════════════════

@app.route("/api/chat", methods=["POST"])
@require_auth
def chat():
    try:
        data = request.get_json(silent=True) or {}
    except Exception:
        data = {}

    messages = data.get("messages") or []
    if not messages:
        return jsonify({"error": "Нет сообщений"}), 400

    chat_id   = data.get("chat_id")
    user_text = messages[-1].get("content", "") if messages else ""

    db = get_db()

    # Проверяем или создаём чат
    if chat_id:
        with db.cursor() as cur:
            cur.execute(
                "SELECT id FROM chats WHERE id=%s AND user_id=%s",
                (chat_id, g.user_id)
            )
            if not cur.fetchone():
                return jsonify({"error": "Чат не найден"}), 404
    else:
        d    = datetime.datetime.now()
        name = "Новый чат: " + d.strftime("%Y.%m.%d")
        with db.cursor() as cur:
            cur.execute(
                "INSERT INTO chats (user_id, name) VALUES (%s, %s)",
                (g.user_id, name)
            )
            chat_id = cur.lastrowid
        db.commit()

    # Сохраняем сообщение пользователя
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO messages (chat_id, role, content) VALUES (%s, 'user', %s)",
            (chat_id, user_text)
        )
        cur.execute("UPDATE chats SET updated_at=NOW() WHERE id=%s", (chat_id,))
    db.commit()

    # GPT-4o запрос
    try:
        response = openai_client.responses.create(
            model="gpt-4o",
            tools=[{"type": "web_search_preview"}],
            input=messages
        )
        reply = next(
            item.content[0].text
            for item in response.output
            if item.type == "message"
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    # Сохраняем ответ
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO messages (chat_id, role, content) VALUES (%s, 'assistant', %s)",
            (chat_id, reply)
        )
        cur.execute("UPDATE chats SET updated_at=NOW() WHERE id=%s", (chat_id,))
    db.commit()

    return jsonify({"text": reply, "chat_id": chat_id})


# ══════════════════════════════════════════════════════
#  WHISPER
# ══════════════════════════════════════════════════════

@app.route("/api/transcribe", methods=["POST"])
@require_auth
def transcribe():
    if "file" not in request.files:
        return jsonify({"error": "Файл не передан"}), 400
    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "Пустое имя файла"}), 400

    suffix = os.path.splitext(file.filename)[1] or ".mp3"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        file.save(tmp.name)
        tmp_path = tmp.name

    try:
        result = whisper_model.transcribe(tmp_path, language="ru")
        return jsonify({"text": result["text"].strip()})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        os.unlink(tmp_path)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)