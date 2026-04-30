"""
train_pothole2.py
=================
Дообучение детектора ям на датасете с полигонами.

Датасет: Potholes and Roads Instance Segmentation
  pothole-vsmtu @ Roboflow Universe (CC BY 4.0)
  1355 фото, полигоны сегментации, съёмка сверху

Классы:
  0 — pothole (яма)
  1 — road    (дорога)

Запуск:
    python train_pothole2.py

Модель сохранится как pothole_model.pt (перезапишет старую)
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
# Распакуй датасет в папку pothole_dataset2/
DATA_YAML = r"C:\Users\Пользователь\Desktop\chatbott\pothole_dataset2\data.yaml"

# ── Параметры ──────────────────────────────────────────
CONFIG = {
    # Дообучаем от текущей модели — она уже видела ямы,
    # теперь научим точнее рисовать полигоны
    "model":   "pothole_model.pt" if os.path.exists("pothole_model.pt") else "yolov8n-seg.pt",
    "data":    DATA_YAML,
    "epochs":  80,
    "imgsz":   640,
    "batch":   8,       # для 4GB VRAM
    "device":  DEVICE,
    "patience": 20,

    # Сохранение
    "save":     True,
    "project":  "runs/segment",
    "name":     "pothole_v2",
    "exist_ok": True,

    # Оптимизатор — маленький lr для дообучения
    "pretrained":    True,
    "optimizer":     "AdamW",
    "lr0":           0.0005,
    "lrf":           0.01,
    "momentum":      0.937,
    "weight_decay":  0.0005,
    "warmup_epochs": 3,
    "cos_lr":        True,

    # Аугментации
    # ⚠️ ФИКС БАГА Ultralytics 8.4.x — IndexError в sem_loss:
    "copy_paste":   0.0,   # ВЫКЛ — виновник краша
    "erasing":      0.0,   # ВЫКЛ — тоже вызывает краш
    "mosaic":       0.5,   # уменьшен для сегментации
    "mixup":        0.0,
    "augment":      True,
    "hsv_h":        0.015,
    "hsv_s":        0.7,
    "hsv_v":        0.4,
    "degrees":      10.0,
    "translate":    0.1,
    "scale":        0.5,
    "flipud":       0.1,
    "fliplr":       0.5,

    # Маски — ФИКС бага с пустыми масками
    "overlap_mask": False,
    "mask_ratio":   4,

    # Прочее
    "workers": 0,      # ФИКС DataLoader на Windows
    "amp":     True,
    "val":     True,
    "plots":   True,
    "verbose": True,
    "cache":   False,
}


def train():
    print("\n" + "=" * 60)
    print("   ДООБУЧЕНИЕ ДЕТЕКТОРА ЯМ (YOLOv8-seg)")
    print("=" * 60)

    if not os.path.exists(DATA_YAML):
        print(f"❌ Датасет не найден: {DATA_YAML}")
        print("   Распакуй датасет в папку pothole_dataset2/")
        return

    base = CONFIG["model"]
    mode = "дообучение от pothole_model.pt" if base == "pothole_model.pt" else "с нуля"
    print(f"\n⏳ Загружаю модель: {base} ({mode})")
    model = YOLO(base)

    print(f"\n🚀 Начинаю обучение...")
    print(f"   Датасет:    pothole_dataset2/ (1355 фото, полигоны)")
    print(f"   Классы:     pothole, road")
    print(f"   Эпох:       {CONFIG['epochs']}")
    print(f"   Батч:       {CONFIG['batch']}")
    print(f"   copy_paste: ВЫКЛ (фикс бага ultralytics 8.4.x)")
    print(f"   workers:    0    (фикс DataLoader Windows)")
    print(f"   Устройство: {'GPU' if DEVICE == 0 else 'CPU'}\n")

    results = model.train(**CONFIG)

    print("\n" + "=" * 60)
    print("✅ ОБУЧЕНИЕ ЗАВЕРШЕНО!")
    print("=" * 60)

    best_path = "runs/segment/pothole_v2/weights/best.pt"
    if os.path.exists(best_path):
        # Сохраняем старую модель как бекап
        if os.path.exists("pothole_model.pt"):
            shutil.copy("pothole_model.pt", "pothole_model_backup.pt")
            print("💾 Старая модель сохранена как pothole_model_backup.pt")
        shutil.copy(best_path, "pothole_model.pt")
        print("✅ Новая модель сохранена как pothole_model.pt")
    else:
        print(f"❌ best.pt не найден: {best_path}")

    print(f"\n📈 Метрики:")
    try:
        metrics = model.val()
        print(f"   mAP50 (box): {metrics.box.map50:.3f}")
        print(f"   mAP50 (seg): {metrics.seg.map50:.3f}")
    except Exception as e:
        print(f"   (метрики: {e})")

    return results


if __name__ == "__main__":
    train()