# 🤖 ChatApp — Система анализа совещаний и детекции объектов

Веб-приложение на Flask/Python с локальным ИИ (Ollama), транскрипцией речи (Faster-Whisper), детекцией ям и мусора (YOLOv8).

---

## 📋 Содержание

- [Описание](#описание)
- [Стек технологий](#стек-технологий)
- [Требования](#требования)
- [Установка и развёртка](#установка-и-развёртка)
- [Настройка .env](#настройка-env)
- [Запуск](#запуск)
- [Обучение моделей](#обучение-моделей)
- [Вспомогательные скрипты](#вспомогательные-скрипты)
- [Структура проекта](#структура-проекта)

---

## Описание

Система предназначена для:
- **Транскрипции аудиозаписей совещаний** и автоматического составления протоколов поручений
- **Распознавания изображений** через vision-модель
- **Детекции ям и дефектов дорожного полотна** на фото и видео (YOLOv8)
- **Детекции ТБО (твёрдо-бытовых отходов)** на фото и видео (YOLOv8)
- **Общения с локальным ИИ** через интерфейс чата

---

## Стек технологий

| Компонент | Технология |
|-----------|-----------|
| Backend | Python 3.12, Flask |
| База данных | MySQL 8.0 |
| Авторизация | JWT (access + refresh токены), bcrypt |
| Локальный ИИ (чат) | Ollama — qwen3:4b |
| Локальный ИИ (vision) | Ollama — gemma3:4b |
| Транскрипция речи | faster-whisper (small, GPU) |
| Детекция объектов | YOLOv8 (Ultralytics) |
| Frontend | Vanilla JS, HTML, CSS |

---

## Требования

### Железо
- **GPU**: NVIDIA с поддержкой CUDA (рекомендуется RTX 3050+ / 4GB VRAM)
- **RAM**: минимум 16 GB
- **Диск**: ~10 GB свободного места

### Программное обеспечение
- Python 3.12
- MySQL 8.0
- [Ollama](https://ollama.com/download) — для локального ИИ
- [ffmpeg](https://ffmpeg.org/download.html) — для обработки аудио
- CUDA 12.x + cuDNN

---

## Установка и развёртка

### 1. Клонировать репозиторий

```bash
git clone https://github.com/ducha8/rating_practice_2026.git
cd rating_practice_2026
```

### 2. Установить зависимости Python

```bash
pip install flask flask-cors python-dotenv pymysql bcrypt pyjwt
pip install faster-whisper
pip install ultralytics opencv-python-headless
pip install torch --index-url https://download.pytorch.org/whl/cu121
pip install openai requests
```

### 3. Установить Ollama и модели

Скачать Ollama: https://ollama.com/download

```bash
# Модель для чата
ollama pull qwen3:4b

# Модель для распознавания изображений
ollama pull gemma3:4b
```

### 4. Установить ffmpeg

**Windows:**
```powershell
winget install ffmpeg
```

### 5. Настроить базу данных MySQL

```powershell
# PowerShell — применить схему БД
Get-Content init.sql | & "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p
```

Или через MySQL Workbench — выполнить файл `init.sql`.

### 6. Создать файл .env

Скопировать `.env.example` и заполнить:

```bash
cp .env.example .env
```

---

## Настройка .env

```env
# JWT — обязательно сменить на случайную строку!
JWT_SECRET=ваш_секретный_ключ_минимум_32_символа

# MySQL
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=ваш_пароль_mysql
MYSQL_DATABASE=chatapp

# Ollama модели
OLLAMA_MODEL=qwen3:4b
OLLAMA_VISION_MODEL=gemma3:4b

# Whisper — путь к модели (если скачана вручную)
# WHISPER_MODEL_PATH=C:\whisper-large-v2

# HuggingFace зеркало (для загрузки Whisper в РК/РФ)
HF_ENDPOINT=https://hf-mirror.com
HF_HUB_DISABLE_SYMLINKS_WARNING=1
```

---

## Запуск

```powershell
python server.py
```

- Локальный доступ: http://localhost:5000
- Сетевой доступ: http://[ваш_ip]:5000

При первом запуске Whisper-модель скачается автоматически (~244 MB для small).

---

## Обучение моделей

### Модель детекции ям (`pothole_model.pt`)

**Датасет:** собственный датасет дорожных дефектов  
**Базовая модель:** `yolov8n-seg.pt` (nano segmentation)  
**Скрипт обучения:** `train_pothole.py`

```powershell
python train_pothole.py
```

После обучения модель сохраняется как `pothole_model.pt`.  
Без дообученной модели детектор работает на базовой `yolov8n-seg.pt`.

---

### Модель детекции мусора (`trash_model.pt`)

**Датасет:** [Garbage Classification — Roboflow Universe](https://universe.roboflow.com/material-identification/garbage-classification-3/dataset/1)  
**Лицензия датасета:** CC BY 4.0  
**Классы:** BIODEGRADABLE, CARDBOARD, GLASS, METAL, PAPER, PLASTIC (6 классов)  
**Базовая модель:** `yolov8s.pt` (small detection)  
**Скрипт обучения:** `train_trash.py`

**Шаги:**

1. Скачать датасет с Roboflow в формате YOLOv8
2. Распаковать в папку `trash_dataset/`
3. Запустить обучение:

```powershell
python train_trash.py
```

4. После обучения модель автоматически копируется как `trash_model.pt`

**Параметры обучения:**
- Эпохи: 100 (с early stopping patience=20)
- Размер изображения: 640×640
- Batch size: 8 (оптимально для 4GB VRAM)
- Оптимайзер: AdamW
- AMP: включён (ускорение на GPU)
- Устройство: CUDA (NVIDIA GPU)

**Продолжение обучения после остановки:**

Если обучение было прервано — в `train_trash.py` изменить CONFIG:

```python
"model":  r"runs/segment/trash_detector/weights/last.pt",
"resume": True,
```

---

### Загрузка Whisper large-v2 (опционально)

Для более точной транскрипции можно скачать большую модель:

```powershell
$env:HF_ENDPOINT = "https://hf-mirror.com"
python download_model.py
```

Затем в `server.py` изменить путь:
```python
whisper_model = WhisperModel(r"C:\whisper-large-v2", device="cuda", compute_type="int8_float16")
```

---

## Вспомогательные скрипты

| Файл | Назначение |
|------|-----------|
| `train_trash.py` | Обучение детектора мусора YOLOv8 |
| `train_pothole.py` | Обучение детектора ям YOLOv8 |
| `download_model.py` | Загрузка Whisper large-v2 с HuggingFace |
| `init.sql` | Схема базы данных MySQL |
| `pothole_detector.py` | Модуль детекции ям (Flask маршруты) |
| `trash_detector.py` | Модуль детекции мусора (Flask маршруты) |

---

## Структура проекта

```
chatbott/
├── server.py              # Основной Flask сервер
├── pothole_detector.py    # Детектор ям (YOLOv8)
├── trash_detector.py      # Детектор мусора (YOLOv8)
├── train_trash.py         # Скрипт обучения модели мусора
├── train_pothole.py       # Скрипт обучения модели ям
├── download_model.py      # Загрузка Whisper large-v2
├── init.sql               # Схема БД
├── index.html             # Главная страница
├── login.html             # Страница входа
├── script.js              # Логика фронтенда
├── style.css              # Стили
├── .env                   # Переменные окружения (не в репо)
├── .env.example           # Пример .env
├── pothole_model.pt       # Дообученная модель ям (не в репо)
├── trash_model.pt         # Дообученная модель мусора (не в репо)
└── dataset/               # Датасет для обучения (не в репо)
```

---

## Архитектура системы

```
Пользователь
    │
    ▼
Frontend (HTML/JS)
    │
    ▼
Flask API (server.py)
    ├── Ollama (qwen3:4b)      — чат
    ├── Ollama (gemma3:4b)     — распознавание изображений  
    ├── faster-whisper (small) — транскрипция аудио
    ├── YOLOv8 (pothole)       — детекция ям
    └── YOLOv8 (trash)         — детекция мусора
    │
    ▼
MySQL (chatapp)
    ├── users
    ├── chats
    ├── messages
    ├── protocols
    └── refresh_tokens
```

---

## Управление VRAM (4GB GPU)

Все модели выгружаются из VRAM после использования:

- **Ollama** — выгружается через `keep_alive: 0` после каждого ответа
- **Whisper** — загружается только во время транскрипции, потом выгружается
- **YOLOv8** — постоянно в памяти (небольшой размер ~3-7MB)

Это позволяет работать на GPU с 4GB VRAM без конфликтов между моделями.

---

## Лицензии датасетов

- **Garbage Classification Dataset** — CC BY 4.0 — [Roboflow Universe](https://universe.roboflow.com/material-identification/garbage-classification-3/dataset/1)
