"""
pothole_detector.py
===================
Модуль детекции ям.

Эндпоинты:
    POST /api/detect-potholes          — изображение → JSON + base64 с полигонами
    POST /api/detect-potholes-video    — видео → SSE-стрим кадров с детекцией
    GET  /api/pothole-model-status     — статус модели
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
    """Форматирует секунды в MM:SS.t или HH:MM:SS.t"""
    s  = int(seconds)
    ms = int((seconds - s) * 10)
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h:02d}:{m:02d}:{s:02d}.{ms}"
    return f"{m:02d}:{s:02d}.{ms}"


class PotholeDetector:

    MODEL_PATHS = [
        "pothole_model.pt",
        "yolov8n-seg.pt",
    ]

    COLORS = [
        (0,   0,   255),
        (0,   128, 255),
        (0,   255, 255),
        (0,   255, 128),
    ]

    SEVERITY_MAP = [
        (0.0,   0.005, "Микро"),
        (0.005, 0.02,  "Малая"),
        (0.02,  0.06,  "Средняя"),
        (0.06,  0.15,  "Крупная"),
        (0.15,  1.0,   "Критическая"),
    ]

    def __init__(self):
        self.model      = None
        self.model_path = None
        self.is_custom  = False
        self.device     = "cpu"
        self._load_model()

    def _load_model(self):
        torch = _get_torch()
        YOLO  = _get_YOLO()
        if torch.cuda.is_available():
            self.device = "0"
            vram_gb = torch.cuda.get_device_properties(0).total_memory / 1e9
            print(f"🖥️  PotholeDetector: GPU ({vram_gb:.1f} ГБ VRAM)")
        else:
            self.device = "cpu"
            print("🖥️  PotholeDetector: CPU")
        for path in self.MODEL_PATHS:
            if os.path.exists(path):
                self.model_path = path
                self.is_custom  = (path == "pothole_model.pt")
                break
        if self.model_path is None:
            self.model_path = "yolov8n-seg.pt"
            self.is_custom  = False
            print("⏳ PotholeDetector: скачиваю базовую yolov8n-seg.pt...")
        try:
            self.model = YOLO(self.model_path)
            status = "дообученная ✅" if self.is_custom else "базовая YOLOv8n-seg ⚠️"
            print(f"✅ PotholeDetector: {self.model_path} ({status})")
        except Exception as e:
            print(f"❌ Ошибка загрузки модели: {e}")
            self.model = None

    def _get_severity(self, ratio: float) -> str:
        for lo, hi, label in self.SEVERITY_MAP:
            if lo <= ratio < hi:
                return label
        return "Критическая"

    def _draw_results(self, image_rgb: np.ndarray, results) -> tuple:
        cv2 = _get_cv2()
        h, w = image_rgb.shape[:2]
        img_area  = h * w
        overlay   = image_rgb.copy()
        annotated = image_rgb.copy()
        detections = []

        if not results or results[0].masks is None:
            return annotated, detections

        for i, (mask_pts, box) in enumerate(zip(results[0].masks.xy, results[0].boxes)):
            if len(mask_pts) < 3:
                continue
            confidence = float(box.conf[0])
            pts        = mask_pts.astype(np.int32).reshape((-1, 1, 2))
            mask_area  = cv2.contourArea(pts)
            area_ratio = mask_area / img_area
            severity   = self._get_severity(area_ratio)
            color      = self.COLORS[i % len(self.COLORS)]

            cv2.fillPoly(overlay, [pts], color)
            cv2.polylines(annotated, [pts], True, color, 3)

            M = cv2.moments(pts)
            if M["m00"] != 0:
                cx = int(M["m10"] / M["m00"])
                cy = int(M["m01"] / M["m00"])
            else:
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                cx, cy = int((x1+x2)/2), int((y1+y2)/2)

            cv2.circle(annotated, (cx, cy), 12, color, -1)
            cv2.circle(annotated, (cx, cy), 12, (255,255,255), 2)
            num = str(i+1)
            fs  = 0.5
            (tw, th), _ = cv2.getTextSize(num, cv2.FONT_HERSHEY_SIMPLEX, fs, 1)
            cv2.putText(annotated, num, (cx-tw//2, cy+th//2),
                        cv2.FONT_HERSHEY_SIMPLEX, fs, (255,255,255), 1)

            label = f"#{i+1} {severity} ({confidence:.0%})"
            (lw, lh), bl = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 2)
            lx = max(0, min(cx-lw//2, w-lw-4))
            ly = max(lh+bl+2, cy-18)
            cv2.rectangle(annotated, (lx-2, ly-lh-bl-2), (lx+lw+2, ly+bl), (0,0,0), -1)
            cv2.putText(annotated, label, (lx, ly-bl),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2)

            detections.append({
                "id":          i+1,
                "severity":    severity,
                "confidence":  round(confidence, 3),
                "area_ratio":  round(area_ratio, 4),
                "area_m2_est": round(mask_area/img_area*4.0, 2),
                "center":      {"x": cx, "y": cy},
                "polygon":     mask_pts.tolist(),
            })

        cv2.addWeighted(overlay, 0.35, annotated, 0.65, 0, annotated)
        if detections:
            cv2.rectangle(annotated, (0,0), (w, 38), (0,0,0), -1)
            cv2.putText(annotated, f"Обнаружено ям: {len(detections)}", (10,26),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0,0,255), 2)
        return annotated, detections

    # ─────────────────────────────────────────────────────
    #  Детекция изображения
    # ─────────────────────────────────────────────────────

    def detect(self, image_bytes: bytes, conf_threshold: float = 0.25) -> dict:
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
        if self.is_custom:
            kw["classes"] = [0]
        results       = self.model(img_rgb, **kw)
        ann_rgb, dets = self._draw_results(img_rgb, results)
        ann_bgr       = cv2.cvtColor(ann_rgb, cv2.COLOR_RGB2BGR)
        _, buf = cv2.imencode(".jpg", ann_bgr, [cv2.IMWRITE_JPEG_QUALITY, 88])
        return {
            "annotated_image": base64.b64encode(buf).decode(),
            "detections":      dets,
            "count":           len(dets),
            "model_type":      "custom" if self.is_custom else "base",
            "processing_ms":   int((time.time()-t0)*1000),
        }

    # ─────────────────────────────────────────────────────
    #  Детекция видео — генератор SSE
    # ─────────────────────────────────────────────────────

    def detect_video_stream(self, video_path: str,
                             conf_threshold: float = 0.25,
                             frame_step: int = 15,
                             preview_quality: int = 72):
        """
        Генератор SSE-событий для покадрового анализа видео.

        События:
          {"type":"start",    "total_frames":N, "fps":F, "duration":S}
          {"type":"frame",    "frame_idx":N, "timestamp":S, "ts_label":"MM:SS.t",
           "count":N, "detections":[...], "image":"<base64 JPEG>"}   — только если count > 0
          {"type":"progress", "frame_idx":N, "total":N, "pct":N}
          {"type":"done",     "summary":{...}}
        """
        if self.model is None:
            yield self._sse({"type":"error","message":"Модель не загружена"})
            return

        cv2 = _get_cv2()
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            yield self._sse({"type":"error","message":"Не удалось открыть видеофайл"})
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

        summary_events   = []
        total_detections = 0
        frame_idx        = 0
        kw = dict(conf=conf_threshold, device=self.device, verbose=False, imgsz=640)
        if self.is_custom:
            kw["classes"] = [0]

        # Прогресс-апдейт раз в ~2 секунды видео
        progress_interval = max(1, int(fps * 2 / frame_step))

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
                    # Временна́я метка поверх кадра
                    cv2.rectangle(ann_bgr, (0,0), (215,28), (0,0,0), -1)
                    cv2.putText(ann_bgr, ts_label, (6,20),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255,255,255), 1)
                    _, buf = cv2.imencode(".jpg", ann_bgr,
                                         [cv2.IMWRITE_JPEG_QUALITY, preview_quality])
                    yield self._sse({
                        "type":       "frame",
                        "frame_idx":  frame_idx,
                        "timestamp":  round(timestamp, 2),
                        "ts_label":   ts_label,
                        "count":      len(dets),
                        "detections": dets,
                        "image":      base64.b64encode(buf).decode(),
                    })
                    summary_events.append({
                        "timestamp":  round(timestamp, 2),
                        "ts_label":   ts_label,
                        "count":      len(dets),
                        "detections": [
                            {k: v for k, v in d.items() if k != "polygon"}
                            for d in dets
                        ],
                    })

                analyzed_count = frame_idx // frame_step
                if analyzed_count % progress_interval == 0:
                    pct = int(frame_idx / max(total_frames, 1) * 100)
                    yield self._sse({
                        "type":      "progress",
                        "frame_idx": frame_idx,
                        "total":     total_frames,
                        "pct":       pct,
                    })

            frame_idx += 1

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
            "device":     self.device,
            "ready":      self.model is not None,
            "message": (
                "Дообученная модель активна ✅" if self.is_custom else
                "Базовая YOLOv8n-seg. Запустите train_pothole.py ⚠️"
                if self.model else "Модель не загружена ❌"
            ),
        }


# ══════════════════════════════════════════════════════
#  FLASK МАРШРУТЫ
# ══════════════════════════════════════════════════════

def register_pothole_routes(app, detector: PotholeDetector):
    from flask import request, jsonify, Response, stream_with_context

    @app.route("/api/pothole-model-status", methods=["GET"])
    def pothole_model_status():
        return jsonify(detector.status)

    # ── Изображение ───────────────────────────────────
    @app.route("/api/detect-potholes", methods=["POST"])
    def detect_potholes_route():
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return jsonify({"error": "Нет токена"}), 401
        if "file" not in request.files:
            return jsonify({"error": "Файл не передан"}), 400
        file = request.files["file"]
        if not file.filename:
            return jsonify({"error": "Пустое имя файла"}), 400
        allowed = {".jpg",".jpeg",".png",".webp",".bmp"}
        ext = os.path.splitext(file.filename)[1].lower()
        if ext not in allowed:
            return jsonify({"error": f"Разрешены: {', '.join(allowed)}"}), 400
        image_bytes = file.read()
        if len(image_bytes) > 30*1024*1024:
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

    # ── Видео (SSE) ───────────────────────────────────
    @app.route("/api/detect-potholes-video", methods=["POST"])
    def detect_potholes_video_route():
        def err_stream(msg):
            e = json.dumps({"type":"error","message":msg}, ensure_ascii=False)
            return Response(f"data: {e}\n\n", content_type="text/event-stream")

        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return err_stream("Нет токена")
        if "file" not in request.files:
            return err_stream("Файл не передан")

        file = request.files["file"]
        allowed_video = {".mp4",".avi",".mov",".mkv",".webm",".m4v"}
        ext = os.path.splitext(file.filename or "")[1].lower()
        if ext not in allowed_video:
            return err_stream("Поддерживаются: mp4, avi, mov, mkv, webm, m4v")

        conf       = max(0.1, min(0.9, float(request.form.get("conf", 0.25))))
        frame_step = max(1, min(60,    int(request.form.get("frame_step", 15))))

        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
        file.save(tmp.name)
        tmp_path = tmp.name
        tmp.close()

        def generate():
            try:
                for chunk in detector.detect_video_stream(
                    tmp_path, conf_threshold=conf, frame_step=frame_step
                ):
                    yield chunk
            finally:
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass

        return Response(
            stream_with_context(generate()),
            content_type="text/event-stream",
            headers={"Cache-Control":"no-cache","X-Accel-Buffering":"no"},
        )

    print("✅ Маршруты ям: /api/detect-potholes  /api/detect-potholes-video  /api/pothole-model-status")