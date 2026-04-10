"""
train_pothole.py
================
Скачивает датасет ям с Roboflow и дообучает YOLOv8n-seg.

Запуск:
    pip install ultralytics roboflow
    python train_pothole.py

После обучения веса лежат в:
    runs/segment/pothole/weights/best.pt

Копируем их в папку приложения:
    copy runs\segment\pothole\weights\best.pt pothole_model.pt
"""

# ── 1. Установка зависимостей ──────────────────────────
import subprocess, sys

def pip_install(pkg):
    subprocess.check_call([sys.executable, "-m", "pip", "install", pkg, "-q"])

try:
    from ultralytics import YOLO
except ImportError:
    print("⏳ Устанавливаю ultralytics...")
    pip_install("ultralytics")
    from ultralytics import YOLO

try:
    from roboflow import Roboflow
except ImportError:
    print("⏳ Устанавливаю roboflow...")
    pip_install("roboflow")
    from roboflow import Roboflow

import os, shutil

# ══════════════════════════════════════════════════════
#  КОНФИГУРАЦИЯ
# ══════════════════════════════════════════════════════

ROBOFLOW_API_KEY = "EuUmzf8vF6axu0OYg3iE"          # ← API ключ с roboflow.com (бесплатно)
EPOCHS           = 50          # 50 хватит для старта, 100+ для лучшей точности
IMG_SIZE         = 640
BATCH_SIZE       = 8           # для RTX 3050 4GB; уменьшите до 4 если OOM
DEVICE           = "0"         # GPU; используйте "cpu" если нет GPU

# Финальный путь к модели (используется в app.py)
OUTPUT_MODEL_PATH = "pothole_model.pt"

# ══════════════════════════════════════════════════════
#  СКАЧИВАНИЕ ДАТАСЕТА
# ══════════════════════════════════════════════════════

def download_dataset():
    """
    Скачивает датасет ям для сегментации.
    
    Используем: "Pothole Detection for Road Safety" на Roboflow Universe
    - 780 изображений с масками полигонов
    - Специально собран для YOLOv8-seg
    
    Если нет API ключа — используем локальный заглушечный dataset.yaml
    """
    if not ROBOFLOW_API_KEY:
        print("⚠️  API ключ Roboflow не задан.")
        print("   Зарегистрируйтесь на https://roboflow.com (бесплатно)")
        print("   Вставьте ключ в ROBOFLOW_API_KEY в этом файле")
        print()
        print("   Альтернатива: скачайте датасет вручную:")
        print("   https://universe.roboflow.com/farzad-nekouee-bzmef/pothole-detection-for-road-safety")
        print("   Выберите формат: YOLOv8 → Download ZIP")
        print("   Распакуйте в папку 'pothole_dataset/'")
        print()
        
        # Проверяем есть ли датасет вручную
        if os.path.exists("pothole_dataset/data.yaml"):
            print("✅ Найден локальный датасет: pothole_dataset/data.yaml")
            return "pothole_dataset/data.yaml"
        else:
            print("❌ Датасет не найден. Укажите API ключ или скачайте вручную.")
            sys.exit(1)
    
    print("⏳ Скачиваю датасет с Roboflow...")
    rf = Roboflow(api_key=ROBOFLOW_API_KEY)
    
    # Датасет для сегментации ям (780 изображений, маски полигонов)
    project = rf.workspace("farzad-nekouee-bzmef").project("pothole-detection-for-road-safety")
    dataset = project.version(4).download("yolov8")
    
    print(f"✅ Датасет скачан: {dataset.location}")
    return os.path.join(dataset.location, "data.yaml")


# ══════════════════════════════════════════════════════
#  ОБУЧЕНИЕ
# ══════════════════════════════════════════════════════

def train(data_yaml):
    print(f"\n{'='*55}")
    print(f"  ОБУЧЕНИЕ YOLOv8n-seg — Обнаружение ям")
    print(f"{'='*55}")
    print(f"  Датасет:  {data_yaml}")
    print(f"  Эпохи:    {EPOCHS}")
    print(f"  Размер:   {IMG_SIZE}px")
    print(f"  Батч:     {BATCH_SIZE}")
    print(f"  Устройство: {'GPU' if DEVICE != 'cpu' else 'CPU'}")
    print(f"{'='*55}\n")
    
    # Загружаем базовую модель (YOLOv8 nano seg — самая лёгкая)
    # Скачивается автоматически (~6 МБ)
    model = YOLO("yolov8n-seg.pt")
    
    results = model.train(
        data        = data_yaml,
        epochs      = EPOCHS,
        imgsz       = IMG_SIZE,
        batch       = BATCH_SIZE,
        device      = DEVICE,
        name        = "pothole",          # папка: runs/segment/pothole/
        patience    = 20,                 # ранняя остановка
        optimizer   = "AdamW",
        lr0         = 0.001,
        weight_decay= 0.0005,
        
        # Аугментации — важно для ям (разное освещение, углы)
        hsv_h       = 0.015,
        hsv_s       = 0.7,
        hsv_v       = 0.4,
        degrees     = 10.0,
        translate   = 0.1,
        scale       = 0.5,
        flipud      = 0.0,
        fliplr      = 0.5,
        mosaic      = 1.0,
        
        # Сохранение
        save        = True,
        save_period = 10,
        plots       = True,
        
        # Производительность
        workers     = 4,
        cache       = False,              # True = быстрее, но нужна RAM
        amp         = True,               # mixed precision для экономии VRAM
        
        # Логирование
        verbose     = True,
    )
    
    return results


# ══════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════

if __name__ == "__main__":
    # 1. Скачать датасет
    data_yaml = download_dataset()
    
    # 2. Обучить
    results = train(data_yaml)
    
    # 3. Скопировать лучшие веса
    best_weights = "runs/segment/pothole/weights/best.pt"
    
    if os.path.exists(best_weights):
        shutil.copy(best_weights, OUTPUT_MODEL_PATH)
        print(f"\n{'='*55}")
        print(f"  ✅ ГОТОВО!")
        print(f"  Модель сохранена: {OUTPUT_MODEL_PATH}")
        print(f"  Теперь запустите app.py — она подхватит модель автоматически")
        print(f"{'='*55}\n")
    else:
        print(f"\n❌ Файл весов не найден: {best_weights}")
        print("   Проверьте логи обучения.")