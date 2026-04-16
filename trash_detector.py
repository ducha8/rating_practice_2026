"""
trash_detector.py
=================
Модуль обнаружения мусора через YOLOv8 (detection или seg).

Поддерживает:
  - Фото (POST /api/detect-trash)
  - Видео SSE-стрим (POST /api/detect-trash-video)
  - Статус модели (GET /api/trash-model-status)
"""

import os
import base64
import json
import time
import tempfile
import numpy as np

_cv2   = None
_YOLO  = None
_torch = None


def _get_cv2():
    global _cv2
    if _cv2 is None:
        import cv2
        _cv2 = cv2
    return _cv2


def _get_YOLO():
    global _YOLO
    if _YOLO is None:
        from ultralytics import YOLO
        _YOLO = YOLO
    return _YOLO


def _get_torch():
    global _torch
    if _torch is None:
        import torch
        _torch = torch
    return _torch


def _fmt_ts(seconds: float) -> str:
    s  = int(seconds)
    ds = int((seconds - s) * 10)
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h:02d}:{m:02d}:{s:02d}.{ds}"
    return f"{m:02d}:{s:02d}.{ds}"


class TrashDetector:
    """Детектор мусора на базе YOLOv8 (detection или segmentation)."""

    MODEL_PATHS = [
        "trash_model.pt",
        "yolov8n-seg.pt",
    ]

    CLASS_COLORS = [
        (0,   200, 255),
        (0,   255, 100),
        (255, 100,   0),
        (200,   0, 255),
        (255, 255,   0),
        (0,   100, 255),
        (255,   0, 100),
        (100, 255,   0),
    ]

    POLLUTION_LEVELS = [
        (0,   0,   "Чисто"),
        (1,   2,   "Незначительное"),
        (3,   5,   "Умеренное"),
        (6,  10,   "Высокое"),
        (11, 999,  "Критическое"),
    ]

    def __init__(self):
        self.model       = None
        self.model_path  = None
        self.is_custom   = False
        self.device      = "cpu"
        self.class_names = {}
        self._load_model()

    # ── Загрузка модели ────────────────────────────────────────────────────────

    def _load_model(self):
        torch = _get_torch()
        YOLO  = _get_YOLO()

        if torch.cuda.is_available():
            self.device = 0          # int → Ultralytics использует cuda:0
            vram = torch.cuda.get_device_properties(0).total_memory / 1e9
            print(f"🖥️  TrashDetector: GPU ({vram:.1f} ГБ VRAM)")
        else:
            self.device = "cpu"
            print("🖥️  TrashDetector: CPU")

        for path in self.MODEL_PATHS:
            if os.path.exists(path):
                self.model_path = path
                self.is_custom  = (path == "trash_model.pt")
                break

        if self.model_path is None:
            self.model_path = "yolov8n-seg.pt"
            self.is_custom  = False
            print("⏳ TrashDetector: скачиваю yolov8n-seg.pt...")

        try:
            self.model       = YOLO(self.model_path)
            self.class_names = self.model.names if hasattr(self.model, "names") else {}
            status = "дообученная ✅" if self.is_custom else "базовая YOLOv8n-seg ⚠️"
            print(f"✅ TrashDetector: {self.model_path} ({status})")
            if self.class_names:
                print(f"   Классы: {list(self.class_names.values())[:10]}")
        except Exception as e:
            print(f"❌ Ошибка загрузки TrashDetector: {e}")
            self.model = None

    # ── Вспомогательные методы ─────────────────────────────────────────────────

    def _get_pollution_level(self, count: int) -> str:
        for lo, hi, label in self.POLLUTION_LEVELS:
            if lo <= count <= hi:
                return label
        return "Критическое"

    def _get_color(self, class_id: int) -> tuple:
        return self.CLASS_COLORS[class_id % len(self.CLASS_COLORS)]

    def _draw_results(self, image_rgb: np.ndarray, results) -> tuple[np.ndarray, list]:
        cv2 = _get_cv2()
        h, w = image_rgb.shape[:2]
        overlay   = image_rgb.copy()
        annotated = image_rgb.copy()
        detections: list[dict] = []

        if not results or results[0].boxes is None or len(results[0].boxes) == 0:
            return annotated, detections

        has_masks  = results[0].masks is not None
        boxes_iter = results[0].boxes
        masks_iter = results[0].masks.xy if has_masks else [None] * len(boxes_iter)

        for i, (mask_pts, box) in enumerate(zip(masks_iter, boxes_iter)):
            confidence = float(box.conf[0])
            class_id   = int(box.cls[0])
            class_name = self.class_names.get(class_id, f"trash_{class_id}")
            color      = self._get_color(class_id)

            x1, y1, x2, y2 = [int(v) for v in box.xyxy[0].tolist()]
            cx = (x1 + x2) // 2
            cy = (y1 + y2) // 2

            if has_masks and mask_pts is not None and len(mask_pts) >= 3:
                # Segmentation — рисуем полигон
                pts = mask_pts.astype(np.int32).reshape((-1, 1, 2))
                cv2.fillPoly(overlay, [pts], color)
                cv2.polylines(annotated, [pts], True, color, 2)
                M = cv2.moments(pts)
                if M["m00"] != 0:
                    cx = int(M["m10"] / M["m00"])
                    cy = int(M["m01"] / M["m00"])
                area     = cv2.contourArea(pts)
                area_pct = round(area / (h * w) * 100, 1)
                polygon  = mask_pts.tolist()
            else:
                # Detection — рисуем прямоугольник
                cv2.rectangle(overlay,   (x1, y1), (x2, y2), color, -1)
                cv2.rectangle(annotated, (x1, y1), (x2, y2), color,  2)
                area_pct = round((x2 - x1) * (y2 - y1) / (h * w) * 100, 1)
                polygon  = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]

            # Кружок с номером
            cv2.circle(annotated, (cx, cy), 10, color, -1)
            cv2.circle(annotated, (cx, cy), 10, (255, 255, 255), 1)
            num = str(i + 1)
            fs  = 0.45
            (tw, th), _ = cv2.getTextSize(num, cv2.FONT_HERSHEY_SIMPLEX, fs, 1)
            cv2.putText(annotated, num, (cx - tw // 2, cy + th // 2),
                        cv2.FONT_HERSHEY_SIMPLEX, fs, (255, 255, 255), 1)

            # Подпись с классом и уверенностью
            label = f"#{i + 1} {class_name} {confidence:.0%}"
            (lw, lh), bl = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
            lx = max(0, min(cx - lw // 2, w - lw - 4))
            ly = max(lh + bl + 2, cy - 15)
            cv2.rectangle(annotated, (lx - 2, ly - lh - bl - 2), (lx + lw + 2, ly + bl), (0, 0, 0), -1)
            cv2.putText(annotated, label, (lx, ly - bl),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)

            detections.append({
                "id":         i + 1,
                "class_id":   class_id,
                "class_name": class_name,
                "confidence": round(confidence, 3),
                "area_pct":   area_pct,
                "center":     {"x": cx, "y": cy},
                "polygon":    polygon,
            })

        # Смешиваем overlay с аннотацией
        cv2.addWeighted(overlay, 0.3, annotated, 0.7, 0, annotated)

        # Шапка с итогом
        if detections:
            pollution = self._get_pollution_level(len(detections))
            header_colors = {
                "Чисто":          (0, 150,   0),
                "Незначительное": (0, 200, 100),
                "Умеренное":      (0, 165, 255),
                "Высокое":        (0, 100, 255),
                "Критическое":    (0,   0, 220),
            }
            hcolor = header_colors.get(pollution, (0, 0, 200))
            cv2.rectangle(annotated, (0, 0), (w, 42), (0, 0, 0), -1)
            cv2.putText(
                annotated,
                f"Мусор: {len(detections)} объектов | Загрязнение: {pollution}",
                (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.75, hcolor, 2,
            )

        return annotated, detections

    # ── Публичные методы ───────────────────────────────────────────────────────

    def detect(self, image_bytes: bytes, conf_threshold: float = 0.25) -> dict:
        """Детекция на одном изображении. Возвращает JSON-совместимый dict."""
        if self.model is None:
            raise RuntimeError("Модель не загружена")

        cv2 = _get_cv2()
        t0  = time.time()

        nparr   = np.frombuffer(image_bytes, np.uint8)
        img_bgr = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img_bgr is None:
            raise ValueError("Не удалось декодировать изображение")

        img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)

        kw = dict(conf=conf_threshold, device=self.device, verbose=False, imgsz=640)
        if not self.is_custom:
            # Классы COCO, похожие на мусор: бутылка, чашка, вилка, нож, ложка,
            # ваза, книга, сумка, зонт, чемодан
            kw["classes"] = [25, 39, 40, 41, 67, 73, 74, 76, 77]

        results       = self.model(img_rgb, **kw)
        ann_rgb, dets = self._draw_results(img_rgb, results)
        ann_bgr       = cv2.cvtColor(ann_rgb, cv2.COLOR_RGB2BGR)

        _, buf = cv2.imencode(".jpg", ann_bgr, [cv2.IMWRITE_JPEG_QUALITY, 88])

        return {
            "annotated_image": base64.b64encode(buf).decode(),
            "detections":      dets,
            "count":           len(dets),
            "pollution_level": self._get_pollution_level(len(dets)),
            "model_type":      "custom" if self.is_custom else "base",
            "processing_ms":   int((time.time() - t0) * 1000),
        }

    def detect_video_stream(
        self,
        video_path: str,
        conf_threshold: float = 0.25,
        frame_step: int = 15,
        preview_quality: int = 72,
    ):
        """
        Генератор SSE-событий для покадрового анализа видео.

        Типы событий:
          start    → {"type":"start", "total_frames", "fps", "duration"}
          frame    → {"type":"frame", "frame_idx", "timestamp", "ts_label",
                       "count", "pollution_level", "detections", "image"}
          progress → {"type":"progress", "frame_idx", "total", "pct"}
          done     → {"type":"done", "summary":{...}}
          error    → {"type":"error", "message"}
        """
        if self.model is None:
            yield self._sse({"type": "error", "message": "Модель не загружена"})
            return

        cv2 = _get_cv2()
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            yield self._sse({"type": "error", "message": "Не удалось открыть видеофайл"})
            return

        fps          = cap.get(cv2.CAP_PROP_FPS) or 25.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        duration_s   = total_frames / fps

        yield self._sse({
            "type":         "start",
            "total_frames": total_frames,
            "fps":          round(fps, 2),
            "duration":     round(duration_s, 2),
        })

        kw = dict(conf=conf_threshold, device=self.device, verbose=False, imgsz=640)
        if not self.is_custom:
            kw["classes"] = [25, 39, 40, 41, 67, 73, 74, 76, 77]

        summary_events    = []
        total_detections  = 0
        frame_idx         = 0
        progress_interval = max(1, int(fps * 2 / frame_step))

        try:
            while True:
                ret, frame_bgr = cap.read()
                if not ret:
                    break

                if frame_idx % frame_step == 0:
                    timestamp = frame_idx / fps
                    ts_label  = _fmt_ts(timestamp)
                    img_rgb   = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
                    results   = self.model(img_rgb, **kw)
                    ann_rgb, dets = self._draw_results(img_rgb, results)

                    if dets:
                        total_detections += len(dets)
                        ann_bgr = cv2.cvtColor(ann_rgb, cv2.COLOR_RGB2BGR)
                        cv2.rectangle(ann_bgr, (0, 0), (215, 28), (0, 0, 0), -1)
                        cv2.putText(ann_bgr, ts_label, (6, 20),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 1)
                        _, buf = cv2.imencode(
                            ".jpg", ann_bgr, [cv2.IMWRITE_JPEG_QUALITY, preview_quality]
                        )
                        yield self._sse({
                            "type":            "frame",
                            "frame_idx":       frame_idx,
                            "timestamp":       round(timestamp, 2),
                            "ts_label":        ts_label,
                            "count":           len(dets),
                            "pollution_level": self._get_pollution_level(len(dets)),
                            "detections":      dets,
                            "image":           base64.b64encode(buf).decode(),
                        })
                        summary_events.append({
                            "timestamp":       round(timestamp, 2),
                            "ts_label":        ts_label,
                            "count":           len(dets),
                            "pollution_level": self._get_pollution_level(len(dets)),
                            "detections": [
                                {k: v for k, v in d.items() if k != "polygon"}
                                for d in dets
                            ],
                        })

                    analyzed = frame_idx // frame_step
                    if analyzed % progress_interval == 0:
                        pct = int(frame_idx / max(total_frames, 1) * 100)
                        yield self._sse({
                            "type":      "progress",
                            "frame_idx": frame_idx,
                            "total":     total_frames,
                            "pct":       pct,
                        })

                frame_idx += 1

        finally:
            cap.release()

        yield self._sse({
            "type": "done",
            "summary": {
                "total_frames_analyzed": frame_idx // max(frame_step, 1),
                "duration_s":            round(duration_s, 2),
                "total_detections":      total_detections,
                "events_count":          len(summary_events),
                "events":                summary_events,
                "model_type":            "custom" if self.is_custom else "base",
                "max_pollution":         max(
                    (e["pollution_level"] for e in summary_events),
                    default="Чисто",
                ),
            },
        })

    @staticmethod
    def _sse(data: dict) -> str:
        return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"

    @property
    def status(self) -> dict:
        return {
            "loaded":     self.model is not None,
            "model_path": self.model_path,
            "is_custom":  self.is_custom,
            "device":     str(self.device),
            "classes":    list(self.class_names.values()) if self.class_names else [],
            "message": (
                "Дообученная модель активна ✅"
                if self.is_custom else
                "Базовая YOLOv8n-seg (запустите train_trash.py) ⚠️"
                if self.model else
                "Модель не загружена ❌"
            ),
        }


# ══════════════════════════════════════════════════════════════════════════════
#  FLASK МАРШРУТЫ
# ══════════════════════════════════════════════════════════════════════════════

def register_trash_routes(app, detector: "TrashDetector"):
    from flask import request, jsonify, Response, stream_with_context

    ALLOWED_IMG   = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
    ALLOWED_VIDEO = {".mp4", ".avi", ".mov", ".mkv", ".webm", ".m4v"}
    MAX_IMG_BYTES = 30 * 1024 * 1024   # 30 МБ

    def _check_token() -> bool:
        return request.headers.get("Authorization", "").startswith("Bearer ")

    @app.route("/api/trash-model-status", methods=["GET"])
    def trash_model_status():
        return jsonify(detector.status)

    @app.route("/api/detect-trash", methods=["POST"])
    def detect_trash_route():
        if not _check_token():
            return jsonify({"error": "Нет токена авторизации"}), 401

        if "file" not in request.files:
            return jsonify({"error": "Файл не передан (поле 'file')"}), 400

        file = request.files["file"]
        if not file.filename:
            return jsonify({"error": "Пустое имя файла"}), 400

        ext = os.path.splitext(file.filename)[1].lower()
        if ext not in ALLOWED_IMG:
            return jsonify({"error": f"Допустимые форматы: {', '.join(ALLOWED_IMG)}"}), 400

        image_bytes = file.read()
        if len(image_bytes) > MAX_IMG_BYTES:
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

    @app.route("/api/detect-trash-video", methods=["POST"])
    def detect_trash_video_route():
        def err_stream(msg: str):
            body = json.dumps({"type": "error", "message": msg}, ensure_ascii=False)
            return Response(f"data: {body}\n\n", content_type="text/event-stream")

        if not _check_token():
            return err_stream("Нет токена авторизации")

        if "file" not in request.files:
            return err_stream("Файл не передан (поле 'file')")

        file = request.files["file"]
        ext  = os.path.splitext(file.filename or "")[1].lower()
        if ext not in ALLOWED_VIDEO:
            return err_stream(f"Допустимые форматы: {', '.join(ALLOWED_VIDEO)}")

        conf       = max(0.1, min(0.9, float(request.form.get("conf",       0.25))))
        frame_step = max(1,   min(60,  int(request.form.get("frame_step",   15))))

        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
        file.save(tmp.name)
        tmp_path = tmp.name
        tmp.close()

        def generate():
            try:
                yield from detector.detect_video_stream(
                    tmp_path,
                    conf_threshold=conf,
                    frame_step=frame_step,
                )
            finally:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

        return Response(
            stream_with_context(generate()),
            content_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    print("✅ Маршруты мусора зарегистрированы:")
    print("   POST /api/detect-trash")
    print("   POST /api/detect-trash-video")
    print("   GET  /api/trash-model-status")