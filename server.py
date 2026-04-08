import os
import re
import gc
import base64
import hashlib
import tempfile
import datetime
import time
import atexit
import subprocess

import torch
import pymysql
import pymysql.cursors
from flask import Flask, request, jsonify, g, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
from openai import OpenAI
from faster_whisper import WhisperModel
import bcrypt
import jwt as pyjwt

# ── Принудительно используем NVIDIA, игнорируем Intel ─
os.environ["CUDA_VISIBLE_DEVICES"] = "0"
os.environ["CUDA_DEVICE_ORDER"]    = "PCI_BUS_ID"

load_dotenv()

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# ── Ollama клиент ─────────────────────────────────────
OLLAMA_MODEL        = os.environ.get("OLLAMA_MODEL", "qwen3:4b")
OLLAMA_VISION_MODEL = os.environ.get("OLLAMA_VISION_MODEL", "gemma3:4b")
WHISPER_MODEL_PATH  = "small"

ollama_client = OpenAI(
    base_url="http://localhost:11434/v1",
    api_key="ollama",
)

whisper_model = None


# ══════════════════════════════════════════════════════
#  OLLAMA — запуск / остановка / выгрузка модели
# ══════════════════════════════════════════════════════

def start_ollama():
    import socket, time
    try:
        s = socket.create_connection(("127.0.0.1", 11434), timeout=1)
        s.close()
        print("✅ Ollama уже запущена.")
        return
    except OSError:
        pass
    try:
        subprocess.Popen(
            ["ollama", "serve"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        for _ in range(20):
            time.sleep(0.5)
            try:
                s = socket.create_connection(("127.0.0.1", 11434), timeout=1)
                s.close()
                print("✅ Ollama запущена.")
                return
            except OSError:
                pass
    except Exception as e:
        print("⚠️ Не удалось запустить Ollama:", e)


def unload_ollama_model(model_name=None):
    """Выгружает указанную модель (или основную чат-модель) из VRAM"""
    target = model_name or OLLAMA_MODEL
    try:
        import requests
        requests.post(
            "http://localhost:11434/api/generate",
            json={"model": target, "keep_alive": 0},
            timeout=10
        )
        print(f"🗑️  Ollama модель {target} выгружена из VRAM.")
    except Exception as e:
        print(f"⚠️ Не удалось выгрузить Ollama модель {target}:", e)


def stop_ollama():
    try:
        subprocess.run(["ollama", "stop", OLLAMA_MODEL], timeout=5, capture_output=True)
        subprocess.run(["ollama", "stop", OLLAMA_VISION_MODEL], timeout=5, capture_output=True)
        subprocess.run(["taskkill", "/F", "/IM", "ollama.exe"], timeout=5, capture_output=True)
        print("✅ Ollama остановлена.")
    except Exception as e:
        print("⚠️ Не удалось остановить Ollama:", e)

atexit.register(stop_ollama)


# ══════════════════════════════════════════════════════
#  WHISPER — оптимизировано под RTX 3050 4 ГБ
# ══════════════════════════════════════════════════════

whisper_model = None


def load_whisper():
    """Загружает Whisper с настройками для 4 ГБ VRAM"""
    global whisper_model
    if whisper_model is not None:
        print("✅ Whisper уже загружен.")
        return

    print("⏸️  Выгружаю Ollama из VRAM перед загрузкой Whisper...")
    unload_ollama_model(OLLAMA_MODEL)
    unload_ollama_model(OLLAMA_VISION_MODEL)
    time.sleep(2.0)

    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    gc.collect()
    torch.cuda.synchronize()

    vram_free = torch.cuda.mem_get_info()[0] / (1024 ** 3)
    print(f"💾 Свободно VRAM перед загрузкой: {vram_free:.1f} ГБ")

    try:
        print("⏳ Загружаю модель small (int8_float16)...")
        whisper_model = WhisperModel(
            model_size_or_path="small",
            device="cuda",
            device_index=0,
            compute_type="int8_float16",
            cpu_threads=4,
            num_workers=2
        )
        print("✅ small успешно загружена на GPU")

        torch.cuda.synchronize()
        used = (torch.cuda.mem_get_info()[1] - torch.cuda.mem_get_info()[0]) / (1024 ** 3)
        print(f"📊 VRAM используется: ~{used:.1f} ГБ")

    except Exception as e:
        print(f"❌ Ошибка загрузки Whisper: {e}")
        unload_whisper()
        raise


def unload_whisper():
    """Безопасная выгрузка"""
    global whisper_model
    if whisper_model is not None:
        print("🗑️  Выгружаю Whisper из VRAM...")
        try:
            del whisper_model
        except:
            pass
        whisper_model = None
        gc.collect()
        torch.cuda.empty_cache()
        torch.cuda.synchronize()
        print("✅ Whisper выгружен.")
    else:
        print("ℹ️  Whisper уже выгружен.")


# ── Статические файлы ─────────────────────────────────
@app.route('/')
def root():
    return send_from_directory('.', 'login.html')

@app.route('/<path:filename>')
def static_files(filename):
    if filename.startswith('api/'):
        return jsonify({"error": "Not found"}), 404
    return send_from_directory('.', filename)


JWT_SECRET  = os.environ.get("JWT_SECRET") or "fallback_secret_change_me"
JWT_ALGO    = "HS256"
ACCESS_TTL  = datetime.timedelta(hours=24)
REFRESH_TTL = datetime.timedelta(days=30)


# ── БД ────────────────────────────────────────────────
def get_db():
    if "db" not in g:
        g.db = pymysql.connect(
            host        = os.environ.get("MYSQL_HOST", "localhost"),
            port        = int(os.environ.get("MYSQL_PORT", 3306)),
            user        = os.environ.get("MYSQL_USER", "root"),
            password    = os.environ.get("MYSQL_PASSWORD", ""),
            database    = os.environ.get("MYSQL_DATABASE", "chatapp"),
            charset     = "utf8mb4",
            cursorclass = pymysql.cursors.DictCursor,
            autocommit  = False,
        )
    return g.db

@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db:
        try: db.close()
        except: pass


# ── JWT ───────────────────────────────────────────────
def make_tokens(user_id, email):
    now = datetime.datetime.now(datetime.timezone.utc)
    access_payload  = {"sub": str(user_id), "email": email, "exp": now + ACCESS_TTL,  "type": "access"}
    refresh_payload = {"sub": str(user_id),                 "exp": now + REFRESH_TTL, "type": "refresh"}
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
            cur.execute("INSERT INTO users (email, password_hash) VALUES (%s, %s)", (email, pw_hash))
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
        cur.execute("SELECT id FROM refresh_tokens WHERE token_hash=%s AND expires_at > NOW()", (token_hash,))
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
            "SELECT id, name, created_at, updated_at FROM chats WHERE user_id=%s ORDER BY updated_at DESC",
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
    try:
        data = request.get_json(silent=True) or {}
    except:
        data = {}
    d    = datetime.datetime.now()
    name = (data.get("name") or "").strip() or ("Новый чат: " + d.strftime("%Y.%m.%d"))
    db = get_db()
    try:
        with db.cursor() as cur:
            cur.execute("INSERT INTO chats (user_id, name) VALUES (%s, %s)", (g.user_id, name))
            chat_id = cur.lastrowid
        db.commit()
        with db.cursor() as cur:
            cur.execute("SELECT id, name, created_at, updated_at FROM chats WHERE id=%s", (chat_id,))
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
    except:
        data = {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Пустое имя"}), 400
    db = get_db()
    with db.cursor() as cur:
        cur.execute("UPDATE chats SET name=%s WHERE id=%s AND user_id=%s", (name, chat_id, g.user_id))
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
        cur.execute("DELETE FROM chats WHERE id=%s AND user_id=%s", (chat_id, g.user_id))
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
        cur.execute("SELECT id FROM chats WHERE id=%s AND user_id=%s", (chat_id, g.user_id))
        if not cur.fetchone():
            return jsonify({"error": "Чат не найден"}), 404
        cur.execute(
            "SELECT id, role, content, created_at FROM messages WHERE chat_id=%s ORDER BY created_at ASC",
            (chat_id,)
        )
        rows = cur.fetchall()
    for r in rows:
        r["created_at"] = r["created_at"].isoformat()
    return jsonify(rows)


# ══════════════════════════════════════════════════════
#  OLLAMA CHAT
# ══════════════════════════════════════════════════════

@app.route("/api/chat", methods=["POST"])
@require_auth
def chat():
    try:
        data = request.get_json(silent=True) or {}
    except:
        data = {}
    messages = data.get("messages") or []
    if not messages:
        return jsonify({"error": "Нет сообщений"}), 400
    
    if messages and messages[-1].get("content", "").startswith("[IMAGE_ANALYSIS]"):
        clean_text = messages[-1]["content"].replace("[IMAGE_ANALYSIS]", "").strip()

        messages[-1]["content"] = (
            "Это результат анализа изображения. "
            "Ответь как обычный ассистент, НЕ создавай протокол и НЕ выделяй поручения.\n\n"
            + clean_text
        )

    chat_id          = data.get("chat_id")
    user_text        = messages[-1].get("content", "") if messages else ""
    is_first_message = data.get("is_first_message", False)

    db = get_db()

    if chat_id:
        with db.cursor() as cur:
            cur.execute("SELECT id, name FROM chats WHERE id=%s AND user_id=%s", (chat_id, g.user_id))
            if not cur.fetchone():
                return jsonify({"error": "Чат не найден"}), 404
    else:
        d    = datetime.datetime.now()
        name = "Новый чат: " + d.strftime("%Y.%m.%d")
        with db.cursor() as cur:
            cur.execute("INSERT INTO chats (user_id, name) VALUES (%s, %s)", (g.user_id, name))
            chat_id = cur.lastrowid
        db.commit()
        is_first_message = True

    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO messages (chat_id, role, content) VALUES (%s, 'user', %s)",
            (chat_id, user_text)
        )
        cur.execute("UPDATE chats SET updated_at=NOW() WHERE id=%s", (chat_id,))
    db.commit()

    try:
        response = ollama_client.chat.completions.create(
            model=OLLAMA_MODEL,
            messages=messages
        )
        reply = response.choices[0].message.content
        reply = re.sub(r'<think>.*?</think>', '', reply, flags=re.DOTALL).strip()
    except Exception as e:
        return jsonify({"error": "Ollama недоступна: " + str(e)}), 500
    finally:
        unload_ollama_model(OLLAMA_MODEL)

    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO messages (chat_id, role, content) VALUES (%s, 'assistant', %s)",
            (chat_id, reply)
        )
        cur.execute("UPDATE chats SET updated_at=NOW() WHERE id=%s", (chat_id,))
    db.commit()

    new_name = None
    if is_first_message and user_text and not user_text.startswith('📝 Транскрипция:'):
        try:
            words = user_text.strip().split()
            raw = " ".join(words[:5])
            if len(words) > 5:
                raw += "..."
            if raw:
                new_name = raw
                with db.cursor() as cur:
                    cur.execute("UPDATE chats SET name=%s WHERE id=%s", (new_name, chat_id))
                db.commit()
        except Exception:
            pass

    return jsonify({"text": reply, "chat_id": chat_id, "new_name": new_name})


# ══════════════════════════════════════════════════════
#  IMAGE RECOGNITION  (gemma3:4b — vision)
# ══════════════════════════════════════════════════════

@app.route("/api/recognize-image", methods=["POST"])
@require_auth
def recognize_image():
    """
    Принимает изображение (multipart/form-data, поле 'file') и
    необязательный вопрос (поле 'question').
    Возвращает {"text": "...", "model": "gemma3:4b"}.
    """
    if "file" not in request.files:
        return jsonify({"error": "Файл не передан"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Пустое имя файла"}), 400

    # Проверяем тип файла
    allowed_exts = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in allowed_exts:
        return jsonify({"error": f"Неподдерживаемый тип файла. Разрешены: {', '.join(allowed_exts)}"}), 400

    question = (request.form.get("question") or "").strip()
    if not question:
        question = "Подробно опиши что изображено на этой картинке. Укажи все важные детали: объекты, людей, текст, цвета, обстановку."

    # Читаем файл и конвертируем в base64
    file_bytes = file.read()
    if len(file_bytes) > 20 * 1024 * 1024:  # 20 MB лимит
        return jsonify({"error": "Файл слишком большой. Максимум 20 МБ."}), 400

    image_b64 = base64.b64encode(file_bytes).decode("utf-8")

    # Определяем MIME-тип
    mime_map = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".gif": "image/gif",
        ".webp": "image/webp", ".bmp": "image/bmp"
    }
    mime_type = mime_map.get(ext, "image/jpeg")

    print(f"🖼️  Распознаю изображение: {file.filename} ({len(file_bytes)//1024} КБ), модель: {OLLAMA_VISION_MODEL}")

    # Выгружаем чат-модель и Whisper перед загрузкой vision модели
    unload_ollama_model(OLLAMA_MODEL)
    unload_whisper()

    try:
        # Используем Ollama REST API напрямую (нативная поддержка изображений)
        import requests as req_lib

        payload = {
            "model": OLLAMA_VISION_MODEL,
            "messages": [
                {
                    "role": "user",
                    "content": question,
                    "images": [image_b64]
                }
            ],
            "stream": False,
            "options": {
                "temperature": 0.1,
                "num_predict": 1024,
            }
        }

        response = req_lib.post(
            "http://localhost:11434/api/chat",
            json=payload,
            timeout=120
        )
        response.raise_for_status()
        result = response.json()

        reply = result.get("message", {}).get("content", "")
        if not reply:
            return jsonify({"error": "Модель не вернула ответ"}), 500

        # Убираем теги размышлений если есть
        reply = re.sub(r'<think>.*?</think>', '', reply, flags=re.DOTALL).strip()

        print(f"✅ Распознавание завершено: {len(reply)} символов")
        return jsonify({
            "text": reply,
            "model": OLLAMA_VISION_MODEL,
            "filename": file.filename
        })

    except req_lib.exceptions.Timeout:
        return jsonify({"error": "Превышено время ожидания. Попробуйте изображение меньшего размера."}), 500
    except req_lib.exceptions.ConnectionError:
        return jsonify({"error": "Ollama недоступна. Убедитесь что сервер запущен."}), 500
    except Exception as e:
        error_str = str(e)
        if "model" in error_str.lower() and "not found" in error_str.lower():
            return jsonify({
                "error": f"Модель {OLLAMA_VISION_MODEL} не установлена. Выполните: ollama pull {OLLAMA_VISION_MODEL}"
            }), 500
        return jsonify({"error": f"Ошибка распознавания: {error_str}"}), 500
    finally:
        unload_ollama_model(OLLAMA_VISION_MODEL)


# ══════════════════════════════════════════════════════
#  SAVE MESSAGE
# ══════════════════════════════════════════════════════

@app.route("/api/chat/save-message", methods=["POST"])
@require_auth
def save_message():
    try:
        data = request.get_json(silent=True) or {}
    except:
        data = {}
    chat_id = data.get("chat_id")
    role    = data.get("role", "user")
    content = data.get("content", "")
    if not chat_id or not content:
        return jsonify({"error": "Нет данных"}), 400
    db = get_db()
    with db.cursor() as cur:
        cur.execute("SELECT id FROM chats WHERE id=%s AND user_id=%s", (chat_id, g.user_id))
        if not cur.fetchone():
            return jsonify({"error": "Чат не найден"}), 404
        cur.execute(
            "INSERT INTO messages (chat_id, role, content) VALUES (%s, %s, %s)",
            (chat_id, role, content)
        )
        cur.execute("UPDATE chats SET updated_at=NOW() WHERE id=%s", (chat_id,))
    db.commit()
    return jsonify({"ok": True})


# ══════════════════════════════════════════════════════
#  PROTOCOLS
# ══════════════════════════════════════════════════════

@app.route("/api/protocols", methods=["GET"])
@require_auth
def list_protocols():
    db = get_db()
    with db.cursor() as cur:
        cur.execute(
            "SELECT id, chat_id, chat_name, type, filename, created_at FROM protocols "
            "WHERE user_id=%s ORDER BY created_at DESC",
            (g.user_id,)
        )
        rows = cur.fetchall()
    for r in rows:
        r["created_at"] = r["created_at"].isoformat()
    return jsonify(rows)


@app.route("/api/protocols", methods=["POST"])
@require_auth
def save_protocol():
    try:
        data = request.get_json(silent=True) or {}
    except:
        data = {}
    chat_id   = data.get("chat_id")
    chat_name = data.get("chat_name", "Чат")
    ptype     = data.get("type", "full")
    filename  = data.get("filename", "protocol.md")
    content   = data.get("content", "")
    if not chat_id or not content:
        return jsonify({"error": "Нет данных"}), 400
    db = get_db()
    try:
        with db.cursor() as cur:
            cur.execute(
                "INSERT INTO protocols (user_id, chat_id, chat_name, type, filename, content) "
                "VALUES (%s, %s, %s, %s, %s, %s)",
                (g.user_id, chat_id, chat_name, ptype, filename, content)
            )
            protocol_id = cur.lastrowid
        db.commit()
        return jsonify({"ok": True, "id": protocol_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/protocols/<int:protocol_id>", methods=["GET"])
@require_auth
def get_protocol(protocol_id):
    db = get_db()
    with db.cursor() as cur:
        cur.execute(
            "SELECT id, chat_id, chat_name, type, filename, content, created_at FROM protocols "
            "WHERE id=%s AND user_id=%s",
            (protocol_id, g.user_id)
        )
        row = cur.fetchone()
    if not row:
        return jsonify({"error": "Протокол не найден"}), 404
    row["created_at"] = row["created_at"].isoformat()
    return jsonify(row)


@app.route("/api/protocols/<int:protocol_id>", methods=["DELETE"])
@require_auth
def delete_protocol(protocol_id):
    db = get_db()
    with db.cursor() as cur:
        cur.execute("DELETE FROM protocols WHERE id=%s AND user_id=%s", (protocol_id, g.user_id))
        affected = cur.rowcount
    db.commit()
    if not affected:
        return jsonify({"error": "Протокол не найден"}), 404
    return jsonify({"ok": True})


# ══════════════════════════════════════════════════════
#  TRANSCRIBE
# ══════════════════════════════════════════════════════

@app.route("/api/transcribe", methods=["POST"])
@require_auth
def transcribe():
    if "file" not in request.files:
        return jsonify({"error": "Файл не передан"}), 400
    
    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "Пустое имя файла"}), 400

    suffix = os.path.splitext(file.filename)[1].lower() or ".mp3"
    tmp_path = None
    wav_path = None

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            file.save(tmp.name)
            tmp_path = tmp.name

        wav_path = tmp_path + ".wav"
        subprocess.run(
            ["ffmpeg", "-y", "-i", tmp_path, "-ar", "16000", "-ac", "1", "-f", "wav", wav_path],
            capture_output=True,
            check=True
        )

        load_whisper()
        print(f"🎙️  Транскрибирую: {file.filename} (модель: small)")

        segments, info = whisper_model.transcribe(
            wav_path,
            language="ru",
            beam_size=1,
            best_of=1,
            patience=1.0,
            temperature=0.0,
            vad_filter=True,
            vad_parameters=dict(
                min_silence_duration_ms=700,
                max_speech_duration_s=25,
                threshold=0.5
            ),
            word_timestamps=False
        )

        text = " ".join(seg.text.strip() for seg in segments).strip()
        print(f"✅ Готово: {len(text)} символов | Длительность: {info.duration:.1f} сек")

        return jsonify({
            "text": text,
            "duration": round(info.duration, 1)
        })

    except Exception as e:
        error_str = str(e).lower()
        if any(x in error_str for x in ["out of memory", "cuda", "c10", "memory"]):
            msg = "Недостаточно VRAM на видеокарте. Файл слишком большой для 4 ГБ. Попробуйте более короткий файл или разбейте его."
        else:
            msg = f"Ошибка транскрипции: {str(e)}"
        return jsonify({"error": msg}), 500

    finally:
        unload_whisper()
        for path in [tmp_path, wav_path]:
            try:
                if path and os.path.exists(path):
                    os.unlink(path)
            except:
                pass
        torch.cuda.empty_cache()
        gc.collect()

if __name__ == "__main__":
    start_ollama()
    gpu_name = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "недоступна"
    print(f"🚀 Сервер запущен.")
    print(f"🤖 Модель чата:      {OLLAMA_MODEL} (выгружается после каждого ответа)")
    print(f"👁️  Модель зрения:   {OLLAMA_VISION_MODEL} (выгружается после каждого запроса)")
    print(f"🎙️  Транскрипция:    faster-whisper {WHISPER_MODEL_PATH} (GPU по запросу, int8)")
    print(f"💾 GPU:              {gpu_name}")
    print(f"⛔ Для остановки нажмите Ctrl+C")
    app.run(host="0.0.0.0", port=5000, debug=False)
    
    # Локальный доступ:  http://localhost:5000
    # Сеть / телефон:    http://10.43.42.24:5000