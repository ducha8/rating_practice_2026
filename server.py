import os
import tempfile
import whisper
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)  # разрешаем запросы с localhost (из браузера)

# Загружаем модель один раз при старте
print("Загрузка модели Whisper (large-v3)...")
model = whisper.load_model("large-v3")
print("Модель загружена.")

@app.route("/api/transcribe", methods=["POST"])
def transcribe():
    if "file" not in request.files:
        return jsonify({"error": "Файл не передан"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "Пустое имя файла"}), 400

    # Сохраняем во временный файл
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
        os.unlink(tmp_path)  # удаляем временный файл

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)