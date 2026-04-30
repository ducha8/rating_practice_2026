"""
train_cracks.py
===============
Дообучение YOLOv8 SEGMENT-модели на обнаружение трещин.

Датасет: crack-bphdr v2 (Roboflow Universe, Public Domain)
  workspace : university-bswxt
  project   : crack-bphdr
  version   : 2
  url       : https://universe.roboflow.com/university-bswxt/crack-bphdr/dataset/2

Классы:
  0 — crack (трещина)

Запуск:
    python train_cracks.py

Модель сохранится как crack_model.pt
"""

import os
import shutil
import torch
from ultralytics import YOLO

# ── Проверка GPU ───────────────────────────────────────
if torch.cuda.is_available():
    gpu  = torch.cuda.get_device_name(0)
    vram = torch.cuda.get_device_properties(0).total_memory / 1e9
    print(f"✅ GPU: {gpu} ({vram:.1f} ГБ VRAM)")
    DEVICE = 0
else:
    print("⚠️  GPU не найден, обучение на CPU")
    DEVICE = "cpu"

# ── Путь к датасету ────────────────────────────────────
DATASET_DIR = r"C:\Users\Пользователь\Desktop\chatbott\crack_dataset"
DATA_YAML   = os.path.join(DATASET_DIR, "data.yaml")

# ── Параметры обучения ─────────────────────────────────
CONFIG = {
    "data": DATA_YAML,

    # ОБУЧЕНИЕ
    "epochs": 100,
    "imgsz": 768,
    "batch": 4,
    "patience": 30,
    "device": DEVICE,

    # СОХРАНЕНИЕ
    "project": "runs/segment",
    "name": "crack_segmentor",
    "exist_ok": True,
    "save": True,

    # ОПТИМИЗАТОР
    "optimizer": "AdamW",
    "lr0": 0.0003,
    "lrf": 0.01,
    "momentum": 0.937,
    "weight_decay": 0.0005,
    "warmup_epochs": 3,
    "cos_lr": True,

    # АУГМЕНТАЦИИ (ВАЖНО)
    "augment": True,
    "mosaic": 0.3,
    "mixup": 0.0,
    "copy_paste": 0.0,   # КРИТИЧНО для трещин
    "erasing": 0.0,

    "hsv_h": 0.015,
    "hsv_s": 0.4,
    "hsv_v": 0.4,

    "degrees": 10,
    "translate": 0.15,
    "scale": 0.5,

    "flipud": 0.1,
    "fliplr": 0.5,

    # ПРОЧЕЕ
    "iou": 0.5,
    "workers": 0,
    "amp": True,
    "val": True,
    "plots": True,
    "verbose": True,
    "cache": False,
}


# ══════════════════════════════════════════════════════
#  Фикс data.yaml — меняем относительные пути на абсолютные
# ══════════════════════════════════════════════════════

def fix_data_yaml():
    """
    Roboflow-датасет поставляется с относительными путями (../train/images).
    Ultralytics на Windows иногда их не находит.
    Перезаписываем data.yaml с абсолютным path: и короткими rel-путями.
    """
    content = (
        f"path: {DATASET_DIR}\n"
        f"\n"
        f"train: train/images\n"
        f"val:   valid/images\n"
        f"test:  test/images\n"
        f"\n"
        f"nc: 1\n"
        f"names: ['crack']\n"
    )
    with open(DATA_YAML, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"✅ data.yaml обновлён: {DATA_YAML}")


# ══════════════════════════════════════════════════════
#  Выбор базовой модели
# ══════════════════════════════════════════════════════

def pick_base_model() -> tuple:
    """
    Возвращает (имя, модель) с task=segment.
    Если crack_model.pt уже есть и это segment — дообучаем его.
    Иначе стартуем от yolov8n-seg.pt.
    """
    candidates = ["crack_model.pt", "yolov8n-seg.pt"]

    for candidate in candidates:
        if candidate == "crack_model.pt" and not os.path.exists(candidate):
            continue
        try:
            probe = YOLO(candidate)
            task  = getattr(probe, "task", None)
            if task == "segment":
                print(f"✅ Базовая модель: {candidate} (task=segment)")
                return candidate, probe
            else:
                print(f"⚠️  {candidate} имеет task={task}, пропускаю.")
        except Exception as e:
            print(f"⚠️  Не удалось загрузить {candidate}: {e}")

    print("   Загружаю yolov8n-seg.pt как запасной вариант.")
    return "yolov8n-seg.pt", YOLO("yolov8n-seg.pt")


# ══════════════════════════════════════════════════════
#  Обучение
# ══════════════════════════════════════════════════════

def train():
    print("\n" + "=" * 60)
    print("   ОБУЧЕНИЕ СЕГМЕНТАТОРА ТРЕЩИН (YOLOv8 SEGMENT)")
    print("=" * 60)

    if not os.path.exists(DATA_YAML):
        print(f"❌ Датасет не найден: {DATA_YAML}")
        print("   Распакуй crack-bphdr v2 с Roboflow в папку crack_dataset/")
        return

    fix_data_yaml()

    base_name, model = pick_base_model()
    mode = "дообучение" if base_name == "crack_model.pt" else "обучение с нуля"
    print(f"\n⏳ Модель: {base_name} ({mode})")
    print(f"   Классы:     crack")
    print(f"   Эпох:       {CONFIG['epochs']}")
    print(f"   Батч:       {CONFIG['batch']}")
    print(f"   Устройство: {'GPU' if DEVICE == 0 else 'CPU'}\n")

    results = model.train(**CONFIG)

    print("\n" + "=" * 60)
    print("✅ ОБУЧЕНИЕ ЗАВЕРШЕНО!")
    print("=" * 60)

    best_path = os.path.join(CONFIG["project"], CONFIG["name"], "weights", "best.pt")
    if os.path.exists(best_path):
        shutil.copy(best_path, "crack_model.pt")
        print("✅ Модель сохранена как crack_model.pt")
    else:
        print(f"❌ best.pt не найден: {best_path}")

    print("\n📈 Валидационные метрики:")
    try:
        metrics = model.val()
        print(f"   mAP50   (box):  {metrics.box.map50:.3f}")
        print(f"   mAP50   (seg):  {metrics.seg.map50:.3f}")
        print(f"   mAP50-95(seg):  {metrics.seg.map:.3f}")
    except Exception as e:
        print(f"   (метрики недоступны: {e})")

    return results


if __name__ == "__main__":
    train()