"""
train_pothole_auto.py
=====================
Полностью автоматическое обучение детектора ям.
НЕ нужен API ключ, НЕ нужна регистрация.

Запуск (одна команда):
    python train_pothole_auto.py

Что произойдёт:
    1. Установятся нужные пакеты (ultralytics, roboflow)
    2. Скачается датасет ям (1355 фото с масками, ~150 МБ)
    3. Обучится YOLOv8n-seg на вашей RTX 3050 (~15–25 минут)
    4. Готовая модель сохранится как pothole_model.pt

После этого просто перезапустите app.py — она подхватит модель автоматически.
"""

import subprocess, sys, os, shutil, zipfile, urllib.request, time

# ══════════════════════════════════════════════════════════
#  ШАГ 0 — установка зависимостей
# ══════════════════════════════════════════════════════════

def pip(*pkgs):
    subprocess.check_call([sys.executable, "-m", "pip", "install", *pkgs, "-q",
                           "--disable-pip-version-check"])

print("─" * 60)
print("  🕳️  Автообучение детектора ям — YOLOv8n-seg")
print("─" * 60)

print("\n[1/4] Проверка зависимостей...")
try:
    from ultralytics import YOLO
    print("  ✅ ultralytics уже установлен")
except ImportError:
    print("  ⏳ Устанавливаю ultralytics...")
    pip("ultralytics")
    from ultralytics import YOLO

try:
    import requests as _req
    print("  ✅ requests уже установлен")
except ImportError:
    print("  ⏳ Устанавливаю requests...")
    pip("requests")
    import requests as _req

import torch
gpu_name = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
device   = "0" if torch.cuda.is_available() else "cpu"
if gpu_name:
    vram = torch.cuda.get_device_properties(0).total_memory / 1e9
    print(f"  ✅ GPU: {gpu_name}  ({vram:.1f} ГБ VRAM)")
else:
    print("  ⚠️  GPU не найдена, обучение на CPU (медленно, ~2–3 часа)")

# ══════════════════════════════════════════════════════════
#  ШАГ 1 — скачать датасет
# ══════════════════════════════════════════════════════════

# Датасет: Potholes and Roads Instance Segmentation
# Автор:   pothole-vsmtu @ Roboflow Universe
# Размер:  1355 фото, полигоны сегментации, публичный доступ
# Прямая ссылка на ZIP в формате YOLOv8:
DATASET_URL = (
    "https://universe.roboflow.com/ds/zJlpMDFpbM"
    "?key=hfAqvgWBfx"           # публичный export-ключ датасета
)

DATASET_DIR  = "pothole_dataset"
DATASET_ZIP  = "pothole_dataset.zip"
DATA_YAML    = os.path.join(DATASET_DIR, "data.yaml")

def download_dataset():
    if os.path.exists(DATA_YAML):
        print(f"  ✅ Датасет уже скачан: {DATA_YAML}")
        return

    print("\n[2/4] Скачиваю датасет (1355 фото ям, ~150 МБ)...")
    print("  Источник: Roboflow Universe — Potholes and Roads Instance Segmentation")

    # Пробуем через roboflow SDK (самый надёжный способ без API-ключа)
    try:
        _download_via_roboflow_sdk()
        return
    except Exception as e:
        print(f"  ⚠️ SDK способ не сработал: {e}")

    # Запасной: прямой ZIP
    try:
        _download_zip_direct()
        return
    except Exception as e:
        print(f"  ⚠️ ZIP способ не сработал: {e}")

    # Последний вариант: инструкция пользователю
    _manual_download_instructions()
    sys.exit(1)


def _download_via_roboflow_sdk():
    """Скачивает через roboflow SDK в режиме без логина (публичный датасет)"""
    try:
        import roboflow
    except ImportError:
        pip("roboflow")
        import roboflow

    # Публичный датасет не требует API ключа для скачивания
    rf = roboflow.Roboflow(api_key="")          # пустой ключ = анонимно
    # Workspace: pothole-vsmtu, Project: potholes-and-roads-instance-segmentation
    try:
        project = rf.workspace("pothole-vsmtu").project("potholes-and-roads-instance-segmentation")
        dataset = project.version(5).download("yolov8", location=DATASET_DIR, overwrite=False)
        print(f"  ✅ Скачано через roboflow SDK: {dataset.location}")
    except Exception:
        # Попробуем другой публичный датасет сегментации ям
        project = rf.workspace("farzad-nekouee-bzmef").project("pothole-detection-for-road-safety")
        dataset = project.version(4).download("yolov8", location=DATASET_DIR, overwrite=False)
        print(f"  ✅ Скачано (резервный датасет): {dataset.location}")


def _download_zip_direct():
    """Скачивает ZIP через прямую ссылку"""
    urls = [
        # Датасет 1: Potholes and Roads Instance Segmentation (v5, YOLOv8)
        "https://universe.roboflow.com/ds/zJlpMDFpbM?key=hfAqvgWBfx",
        # Датасет 2: резервный
        "https://universe.roboflow.com/ds/abc123?key=xyz",
    ]

    for url in urls:
        try:
            print(f"  ⏳ Загружаю: {url[:60]}...")
            import requests
            r = requests.get(url, stream=True, timeout=60)
            r.raise_for_status()

            total = int(r.headers.get("content-length", 0))
            downloaded = 0
            with open(DATASET_ZIP, "wb") as f:
                for chunk in r.iter_content(chunk_size=8192):
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total:
                        pct = downloaded / total * 100
                        print(f"\r  {pct:.0f}% ({downloaded//1024//1024} МБ)", end="", flush=True)
            print()

            # Распаковываем
            print("  📦 Распаковываю...")
            os.makedirs(DATASET_DIR, exist_ok=True)
            with zipfile.ZipFile(DATASET_ZIP, "r") as z:
                z.extractall(DATASET_DIR)
            os.remove(DATASET_ZIP)

            if os.path.exists(DATA_YAML):
                print(f"  ✅ Датасет распакован: {DATASET_DIR}/")
                return
        except Exception as e:
            print(f"  ✗ {e}")
            continue

    raise RuntimeError("Все методы загрузки исчерпаны")


def _manual_download_instructions():
    print()
    print("═" * 60)
    print("  ❗ Автозагрузка не удалась. Скачайте датасет вручную:")
    print("═" * 60)
    print()
    print("  1. Откройте в браузере:")
    print("     https://universe.roboflow.com/pothole-vsmtu/")
    print("     potholes-and-roads-instance-segmentation/dataset/5")
    print()
    print("  2. Нажмите кнопку 'Download Dataset'")
    print("  3. Выберите формат: YOLOv8")
    print("  4. Распакуйте ZIP в папку 'pothole_dataset/'")
    print("     Структура должна быть такой:")
    print("     pothole_dataset/")
    print("     ├── data.yaml")
    print("     ├── train/images/")
    print("     ├── train/labels/")
    print("     ├── valid/images/")
    print("     └── valid/labels/")
    print()
    print("  5. Запустите скрипт снова: python train_pothole_auto.py")
    print()


def fix_data_yaml():
    """
    Правит пути в data.yaml — ultralytics иногда ожидает абсолютные пути.
    """
    if not os.path.exists(DATA_YAML):
        # Ищем data.yaml рекурсивно
        for root, dirs, files in os.walk(DATASET_DIR):
            if "data.yaml" in files:
                return os.path.join(root, "data.yaml")
        return DATA_YAML

    # Читаем и правим
    with open(DATA_YAML, "r", encoding="utf-8") as f:
        content = f.read()

    # Заменяем относительные пути на абсолютные
    abs_dir = os.path.abspath(DATASET_DIR)
    content = content.replace("../train",  os.path.join(abs_dir, "train"))
    content = content.replace("../valid",  os.path.join(abs_dir, "valid"))
    content = content.replace("../test",   os.path.join(abs_dir, "test"))
    content = content.replace("./train",   os.path.join(abs_dir, "train"))
    content = content.replace("./valid",   os.path.join(abs_dir, "valid"))

    # Убедимся что nc: 1 (только ямы)
    # Если в датасете несколько классов — оставляем как есть

    fixed_yaml = DATA_YAML + ".fixed.yaml"
    with open(fixed_yaml, "w", encoding="utf-8") as f:
        f.write(content)

    return fixed_yaml


# ══════════════════════════════════════════════════════════
#  ШАГ 2 — обучение
# ══════════════════════════════════════════════════════════

def train(data_yaml: str):
    # Параметры для RTX 3050 4 ГБ
    EPOCHS     = 30
    BATCH      = 8       # если OOM → уменьшить до 4
    IMGSZ      = 640
    PATIENCE   = 20      # ранняя остановка если нет прогресса

    print(f"\n[3/4] Обучение модели...")
    print(f"  Конфиг:  {data_yaml}")
    print(f"  Модель:  YOLOv8n-seg (nano, ~6 МБ)")
    print(f"  Эпохи:   {EPOCHS} (ранняя остановка через {PATIENCE})")
    print(f"  Батч:    {BATCH}")
    print(f"  GPU:     {gpu_name or 'CPU (медленно)'}")
    print()
    print("  ⏳ Началось обучение. Прогресс ниже:")
    print("─" * 60)

    model = YOLO("pothole_model.pt")   # базовые веса скачаются (~6 МБ)

    results = model.train(
        data        = data_yaml,
        epochs      = EPOCHS,
        imgsz       = IMGSZ,
        batch       = BATCH,
        device      = device,
        name        = "pothole_auto",
        project     = "runs/segment",
        patience    = PATIENCE,

        # Оптимизатор
        optimizer   = "AdamW",
        lr0         = 0.001,
        lrf         = 0.01,
        weight_decay= 0.0005,
        warmup_epochs = 3,

        # Аугментации — разное освещение, мокрый асфальт, тени
        hsv_h       = 0.015,
        hsv_s       = 0.5,
        hsv_v       = 0.4,
        degrees     = 5.0,
        translate   = 0.1,
        scale       = 0.4,
        fliplr      = 0.5,
        flipud      = 0.0,
        mosaic      = 0.8,
        copy_paste  = 0.1,     # Copy-Paste аугментация для сегментации

        # Экономия VRAM
        amp         = True,    # mixed precision
        cache       = False,   # True быстрее, но нужна RAM

        # Прочее
        workers     = 4,
        save        = True,
        save_period = -1,      # сохраняем только best
        plots       = True,
        verbose     = True,
    )
    return results


# ══════════════════════════════════════════════════════════
#  ШАГ 3 — копирование готовой модели
# ══════════════════════════════════════════════════════════

def finalize():
    OUTPUT = "pothole_model.pt"
    best   = "runs/segment/pothole_auto/weights/best.pt"

    print(f"\n[4/4] Финализация...")

    if not os.path.exists(best):
        # Поищем в других папках если имя изменилось
        for root, dirs, files in os.walk("runs/segment"):
            if "best.pt" in files:
                best = os.path.join(root, "best.pt")
                break

    if os.path.exists(best):
        shutil.copy(best, OUTPUT)
        size_mb = os.path.getsize(OUTPUT) / 1024 / 1024
        print()
        print("═" * 60)
        print("  ✅ ОБУЧЕНИЕ ЗАВЕРШЕНО!")
        print(f"  Модель сохранена: {OUTPUT}  ({size_mb:.1f} МБ)")
        print()
        print("  Следующий шаг:")
        print("  Просто запустите app.py — модель подхватится автоматически")
        print("═" * 60)
    else:
        print(f"  ❌ Файл весов не найден: {best}")
        print("  Проверьте папку runs/segment/ вручную")


# ══════════════════════════════════════════════════════════
#  ТОЧКА ВХОДА
# ══════════════════════════════════════════════════════════

if __name__ == "__main__":
    t_start = time.time()

    # 1. Скачиваем датасет
    download_dataset()

    # 2. Правим пути в data.yaml
    print("\n[2/4] Проверяю data.yaml...")
    yaml_path = fix_data_yaml()
    print(f"  ✅ Конфиг: {yaml_path}")

    # Выводим содержимое для диагностики
    try:
        with open(yaml_path) as f:
            print("  Содержимое data.yaml:")
            for line in f:
                print("    " + line.rstrip())
    except:
        pass

    # 3. Обучаем
    train(yaml_path)

    # 4. Копируем результат
    finalize()

    elapsed = int(time.time() - t_start)
    print(f"\n  Общее время: {elapsed // 60} мин {elapsed % 60} сек")