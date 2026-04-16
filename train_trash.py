"""
train_trash.py
==============
Обучение YOLOv8s-seg на обнаружение и сегментацию мусора.

Датасет: 4 класса — cardboard, metal, rigid_plastic, soft_plastic
Модель:  yolov8s-seg.pt (сегментация полигонами)

Фиксы Ultralytics 8.4.x:
  - copy_paste=0.0   → IndexError в sem_loss на пустых масках
  - workers=0        → зависание DataLoader на Windows
  - cache=False      → недостаточно RAM для кеша

Запуск:
    python train_trash.py
"""

import os
import shutil
import torch
from ultralytics import YOLO


# ── GPU / CPU ──────────────────────────────────────────────────────────────────
if torch.cuda.is_available():
    gpu  = torch.cuda.get_device_name(0)
    vram = torch.cuda.get_device_properties(0).total_memory / 1e9
    print(f"✅ GPU: {gpu}  ({vram:.1f} ГБ VRAM)")
    DEVICE = 0
else:
    print("⚠️  GPU не найден — обучение на CPU (медленно)")
    DEVICE = "cpu"


# ── Пути ───────────────────────────────────────────────────────────────────────
DATA_YAML  = r"C:\Users\Пользователь\Desktop\chatbott\trash_dataset\data.yaml"
OUTPUT_DIR = "runs/segment"
RUN_NAME   = "trash_detector"
BEST_PT    = f"{OUTPUT_DIR}/{RUN_NAME}/weights/best.pt"
FINAL_PT   = "trash_model.pt"


# ── Конфиг обучения ────────────────────────────────────────────────────────────
# Только параметры, которые .train() реально принимает.
# conf / iou — это параметры инференса, здесь их нет.
CONFIG = {
    # Базовая модель
    "model":      "yolov8s-seg.pt",
    "data":       DATA_YAML,
    "pretrained": True,

    # Цикл обучения
    "epochs":          100,
    "imgsz":           640,
    "batch":           8,
    "device":          DEVICE,
    "patience":        25,       # early stopping
    "cos_lr":          True,
    "warmup_epochs":   5,

    # Оптимизатор
    "optimizer":      "AdamW",
    "lr0":            0.003,
    "lrf":            0.01,      # финальный lr = lr0 * lrf
    "momentum":       0.937,
    "weight_decay":   0.0005,

    # Маски (сегментация)
    "overlap_mask": True,
    "mask_ratio":   4,

    # Аугментация — безопасный набор для seg-датасета
    "augment":      True,
    "mosaic":       1.0,
    "mixup":        0.0,
    "copy_paste":   0.0,   # ← ВЫКЛ: баг IndexError в Ultralytics 8.4.x
    "hsv_h":        0.015,
    "hsv_s":        0.7,
    "hsv_v":        0.4,
    "degrees":      15.0,
    "translate":    0.1,
    "scale":        0.5,
    "shear":        2.0,
    "perspective":  0.0001,
    "flipud":       0.1,
    "fliplr":       0.5,

    # Сохранение / логи
    "save":       True,
    "project":    OUTPUT_DIR,
    "name":       RUN_NAME,
    "exist_ok":   True,
    "plots":      True,
    "verbose":    True,
    "amp":        True,
    "val":        True,

    # Фиксы Windows / малой RAM
    "workers": 0,      # ← ВЫКЛ многопроцессорность DataLoader (глючит на Windows)
    "cache":   False,  # ← ВЫКЛ кеш (нужно ~24 ГБ RAM, у нас ~2 ГБ)
}


# ── Обучение ───────────────────────────────────────────────────────────────────
def train():
    print("\n" + "=" * 60)
    print("   ОБУЧЕНИЕ ДЕТЕКТОРА МУСОРА  (YOLOv8s-SEG)")
    print("=" * 60)

    if not os.path.exists(DATA_YAML):
        print(f"❌ Датасет не найден: {DATA_YAML}")
        return None

    print(f"\n📦 Загружаю базовую модель: {CONFIG['model']}")
    model = YOLO(CONFIG["model"])

    print(f"\n🚀 Параметры запуска:")
    print(f"   epochs   : {CONFIG['epochs']}")
    print(f"   batch    : {CONFIG['batch']}")
    print(f"   device   : {'GPU (' + gpu + ')' if DEVICE == 0 else 'CPU'}")
    print(f"   workers  : 0  (фикс Windows DataLoader)")
    print(f"   cache    : False  (мало RAM)")
    print(f"   copy_paste: 0.0  (фикс IndexError 8.4.x)\n")

    results = model.train(**CONFIG)

    # ── Копируем best.pt как финальную модель ──────────────────────────────────
    print("\n" + "=" * 60)
    print("ОБУЧЕНИЕ ЗАВЕРШЕНО")
    print("=" * 60)

    if os.path.exists(BEST_PT):
        shutil.copy(BEST_PT, FINAL_PT)
        print(f"✅ Модель сохранена: {FINAL_PT}")
    else:
        print(f"⚠️  best.pt не найден по пути: {BEST_PT}")

    # ── Финальные метрики (уже посчитаны в конце train, но выводим явно) ───────
    print("\n📊 Финальные метрики (val-сет):")
    try:
        # Загружаем best.pt для чистой валидации
        best_model = YOLO(FINAL_PT if os.path.exists(FINAL_PT) else BEST_PT)
        metrics = best_model.val(data=DATA_YAML, device=DEVICE, workers=0, verbose=False)

        print(f"   Box  mAP50     : {metrics.box.map50:.3f}")
        print(f"   Box  mAP50-95  : {metrics.box.map:.3f}")
        print(f"   Mask mAP50     : {metrics.seg.map50:.3f}")
        print(f"   Mask mAP50-95  : {metrics.seg.map:.3f}")

        # Метрики по классам
        if hasattr(metrics.box, 'ap_class_index'):
            names = best_model.names
            print("\n   По классам (Box mAP50):")
            for i, cls_idx in enumerate(metrics.box.ap_class_index):
                print(f"     {names[cls_idx]:<20} {metrics.box.ap50[i]:.3f}")

    except Exception as e:
        print(f"   (не удалось получить метрики: {e})")

    return results


if __name__ == "__main__":
    train()