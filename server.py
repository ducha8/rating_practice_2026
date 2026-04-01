import os
import tempfile
import whisper
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

app = Flask(__name__)
CORS(app)

# ── OpenAI клиент ─────────────────────────────────────
client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

# ── Whisper модель ────────────────────────────────────
print("Загрузка модели Whisper (large-v3)...")
model = whisper.load_model("large-v3")
print("Модель загружена.")


# ── /api/transcribe — распознавание аудио ─────────────
@app.route("/api/transcribe", methods=["POST"])
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
        result = model.transcribe(tmp_path, language="ru")
        return jsonify({"text": result["text"].strip()})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        os.unlink(tmp_path)


# ── /api/chat — GPT-4o с веб-поиском ─────────────────
@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.get_json()
    if not data or "messages" not in data:
        return jsonify({"error": "Нет сообщений"}), 400

    try:
        response = client.responses.create(
            model="gpt-4o",
            tools=[{"type": "web_search_preview"}],
            input=data["messages"]
        )
        # Извлекаем текстовый ответ
        reply = next(
            item.content[0].text
            for item in response.output
            if item.type == "message"
        )
        return jsonify({"text": reply})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)