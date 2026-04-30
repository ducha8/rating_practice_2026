"""
crack_detector.py
=================
Модуль обнаружения трещин через YOLOv8 SEGMENT (полигональные маски).

Датасет: crack-bphdr (Roboflow) — 1 класс: 'crack'

Поддерживает:
  - Фото (POST /api/detect-cracks)
  - Статус модели (GET /api/crack-model-status)
"""

import os
import base64
import numpy as np

_cv2   = None
_YOLO  = None
_torch = None

def _get_cv2():
    global _cv2
    if _cv2 is None:
        import cv2; _cv2 = cv2
    return _cv2

def _get_YOLO():
    global _YOLO
    if _YOLO is None:
        from ultralytics import YOLO; _YOLO = YOLO
    return _YOLO

def _get_torch():
    global _torch
    if _torch is None:
        import torch; _torch = torch
    return _torch


# Единственный класс
CRACK_COLOR = (0, 200, 255)   # жёлто-голубой

DAMAGE_LEVELS = [
    (0,    0,    "Нет повреждений"),
    (1,    2,    "Незначительные"),
    (3,    5,    "Умеренные"),
    (6,   10,    "Серьёзные"),
    (11, 999,    "Критические"),
]


class CrackDetector:
    MODEL_PATHS = [
        "crack_model.pt",   # дообученная сегм. модель
        "yolov8n-seg.pt",   # fallback — базовая seg
    ]

    def __init__(self):
        self.model       = None
        self.model_path  = None
        self.is_custom   = False
        self.device      = "cpu"
        self.class_names = {}
        self._load_model()

    # ── загрузка ──────────────────────────────────────────
    def _load_model(self):
        torch = _get_torch()
        YOLO  = _get_YOLO()

        self.device = "0" if torch.cuda.is_available() else "cpu"
        if torch.cuda.is_available():
            vram = torch.cuda.get_device_properties(0).total_memory / 1e9
            print(f"🖥️  CrackDetector: GPU ({vram:.1f} ГБ VRAM)")
        else:
            print("🖥️  CrackDetector: CPU")

        for path in self.MODEL_PATHS:
            if os.path.exists(path):
                self.model_path = path
                self.is_custom  = (path == "crack_model.pt")
                break

        if self.model_path is None:
            self.model_path = "yolov8n-seg.pt"
            self.is_custom  = False

        try:
            self.model = YOLO(self.model_path)
            self.class_names = self.model.names if hasattr(self.model, "names") else {}
            task   = getattr(self.model, "task", "segment")
            status = "дообученная ✅" if self.is_custom else f"базовая ({task}) ⚠️"
            print(f"✅ CrackDetector: {self.model_path} ({status}), task={task}")
            if self.class_names:
                print(f"   Классы: {list(self.class_names.values())}")
        except Exception as e:
            print(f"❌ Ошибка загрузки CrackDetector: {e}")
            self.model = None

    # ── вспомогательные ──────────────────────────────────
    def _get_damage_level(self, count: int) -> str:
        for lo, hi, label in DAMAGE_LEVELS:
            if lo <= count <= hi:
                return label
        return "Критические"

    # ── отрисовка масок ───────────────────────────────────
    def _draw_results(self, image_rgb: np.ndarray, results) -> tuple:
        cv2 = _get_cv2()
        h, w = image_rgb.shape[:2]
        annotated  = image_rgb.copy()
        detections = []

        if not results or results[0].masks is None:
            return annotated, detections

        masks  = results[0].masks
        boxes  = results[0].boxes

        overlay = annotated.copy()

        for i in range(len(masks)):
            confidence = float(boxes.conf[i])
            class_id   = int(boxes.cls[i])
            class_name = self.class_names.get(class_id, "crack")

            # ---------- маска ----------
            # masks.xy[i] — полигон в пикселях
            polygon = masks.xy[i].astype(np.int32)
            if len(polygon) < 3:
                continue

            # Заливка маски на overlay
            cv2.fillPoly(overlay, [polygon], CRACK_COLOR)

            # Контур на annotated
            cv2.polylines(annotated, [polygon], isClosed=True, color=CRACK_COLOR, thickness=2)

            # Площадь через маску
            mask_bin = np.zeros((h, w), dtype=np.uint8)
            cv2.fillPoly(mask_bin, [polygon], 1)
            area_pct = round(float(mask_bin.sum()) / (h * w) * 100, 3)

            # ---------- bbox ----------
            x1, y1, x2, y2 = [int(v) for v in boxes.xyxy[i].tolist()]
            cx = (x1 + x2) // 2
            cy = (y1 + y2) // 2

            # Номер в кружке
            cv2.circle(annotated, (cx, cy), 10, CRACK_COLOR, -1)
            cv2.circle(annotated, (cx, cy), 10, (255, 255, 255), 1)
            num = str(i + 1)
            fs  = 0.45
            (tw, th), _ = cv2.getTextSize(num, cv2.FONT_HERSHEY_SIMPLEX, fs, 1)
            cv2.putText(annotated, num, (cx - tw // 2, cy + th // 2),
                        cv2.FONT_HERSHEY_SIMPLEX, fs, (255, 255, 255), 1)

            # Подпись
            lbl = f"#{i+1} {class_name} {confidence:.0%}"
            (lw, lh), bl = cv2.getTextSize(lbl, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
            lx = max(0, min(x1, w - lw - 4))
            ly = max(lh + bl + 2, y1 - 4)
            cv2.rectangle(annotated, (lx - 2, ly - lh - bl - 2), (lx + lw + 2, ly + bl), (0, 0, 0), -1)
            cv2.putText(annotated, lbl, (lx, ly - bl),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, CRACK_COLOR, 1)

            detections.append({
                "id":         i + 1,
                "class_id":   class_id,
                "class_name": class_name,
                "confidence": round(confidence, 3),
                "severity":   "Средняя",
                "area_pct":   area_pct,
                "center":     {"x": cx, "y": cy},
                "bbox":       [x1, y1, x2, y2],
            })

        # Смешиваем заливки масок
        cv2.addWeighted(overlay, 0.30, annotated, 0.70, 0, annotated)

        # Шапка
        if detections:
            damage = self._get_damage_level(len(detections))
            header_colors = {
                "Нет повреждений": (0, 150,   0),
                "Незначительные":  (0, 200, 100),
                "Умеренные":       (0, 165, 255),
                "Серьёзные":       (0, 100, 255),
                "Критические":     (0,   0, 220),
            }
            hc = header_colors.get(damage, (100, 100, 100))
            header = f"Трещин: {len(detections)}  |  {damage}"
            (hw, hh), hbl = cv2.getTextSize(header, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 1)
            cv2.rectangle(annotated, (0, 0), (hw + 20, hh + hbl + 14), (0, 0, 0), -1)
            cv2.putText(annotated, header, (10, hh + 7),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, hc, 1)

        return annotated, detections

    # ── публичный метод ───────────────────────────────────
    def detect(self, image_bytes: bytes, conf_threshold: float = 0.25) -> dict:
        if self.model is None:
            raise RuntimeError("Модель не загружена")

        cv2 = _get_cv2()
        np_arr  = np.frombuffer(image_bytes, np.uint8)
        img_bgr = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        if img_bgr is None:
            raise ValueError("Не удалось декодировать изображение")

        img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
        h, w    = img_rgb.shape[:2]

        results = self.model(
            img_rgb,
            conf=conf_threshold,
            device=self.device,
            verbose=False,
            imgsz=640,
            task="segment",
        )

        ann_rgb, detections = self._draw_results(img_rgb, results)
        ann_bgr = cv2.cvtColor(ann_rgb, cv2.COLOR_RGB2BGR)

        _, orig_buf = cv2.imencode(".jpg", img_bgr, [cv2.IMWRITE_JPEG_QUALITY, 85])
        _, ann_buf  = cv2.imencode(".jpg", ann_bgr, [cv2.IMWRITE_JPEG_QUALITY, 85])

        damage_level = self._get_damage_level(len(detections))
        total_area   = round(sum(d["area_pct"] for d in detections), 3)

        return {
            "count":          len(detections),
            "damage_level":   damage_level,
            "total_area_pct": total_area,
            "detections":     detections,
            "original":       base64.b64encode(orig_buf).decode(),
            "annotated":      base64.b64encode(ann_buf).decode(),
            "image_size":     {"width": w, "height": h},
            "model_type":     "custom" if self.is_custom else "base",
        }

    @property
    def status(self) -> dict:
        task = getattr(self.model, "task", "unknown") if self.model else "unknown"
        return {
            "loaded":     self.model is not None,
            "model_path": self.model_path,
            "is_custom":  self.is_custom,
            "device":     self.device,
            "task":       task,
            "classes":    list(self.class_names.values()) if self.class_names else [],
            "message": (
                "Дообученная модель активна ✅" if self.is_custom else
                "Базовая модель (запустите train_cracks.py) ⚠️"
                if self.model else "Модель не загружена ❌"
            ),
        }


# ══════════════════════════════════════════════════════
#  FLASK МАРШРУТЫ
# ══════════════════════════════════════════════════════

def register_crack_routes(app, detector: "CrackDetector"):
    from flask import request, jsonify

    @app.route("/api/crack-model-status", methods=["GET"])
    def crack_model_status():
        return jsonify(detector.status)

    @app.route("/api/detect-cracks", methods=["POST"])
    def detect_cracks_route():
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return jsonify({"error": "Нет токена"}), 401

        if "file" not in request.files:
            return jsonify({"error": "Файл не передан"}), 400
        file = request.files["file"]
        if not file.filename:
            return jsonify({"error": "Пустое имя файла"}), 400

        allowed = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
        ext = os.path.splitext(file.filename)[1].lower()
        if ext not in allowed:
            return jsonify({"error": f"Разрешены: {', '.join(allowed)}"}), 400

        image_bytes = file.read()
        if len(image_bytes) > 30 * 1024 * 1024:
            return jsonify({"error": "Файл слишком большой. Макс. 30 МБ."}), 400

        conf = max(0.1, min(0.9, float(request.form.get("conf", 0.25))))

        try:
            return jsonify(detector.detect(image_bytes, conf))
        except RuntimeError as e:
            return jsonify({"error": str(e)}), 503
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        except Exception as e:
            return jsonify({"error": f"Ошибка детекции: {e}"}), 500

    print("✅ Маршруты трещин: /api/detect-cracks  /api/crack-model-status")