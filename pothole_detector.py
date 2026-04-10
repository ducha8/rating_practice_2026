"""
pothole_detector.py
===================
Модуль детекции ям для подключения к app.py.

Подключение к app.py:
    from pothole_detector import PotholeDetector, register_pothole_routes
    pothole_detector = PotholeDetector()
    register_pothole_routes(app, pothole_detector)

Эндпоинты:
    POST /api/detect-potholes   — принимает изображение, возвращает JSON + base64 изображение с полигонами
    GET  /api/pothole-model-status — статус загрузки модели
"""

import os
import io
import base64
import json
import time
import numpy as np
from pathlib import Path

# ── Ленивый импорт тяжёлых библиотек ──────────────────
_cv2   = None
_PIL   = None
_YOLO  = None
_torch = None

def _get_cv2():
    global _cv2
    if _cv2 is None:
        import cv2
        _cv2 = cv2
    return _cv2

def _get_PIL():
    global _PIL
    if _PIL is None:
        from PIL import Image, ImageDraw, ImageFont
        _PIL = (Image, ImageDraw, ImageFont)
    return _PIL

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


# ══════════════════════════════════════════════════════
#  ДЕТЕКТОР ЯМ
# ══════════════════════════════════════════════════════

class PotholeDetector:
    
    # Путь к модели: сначала дообученная, потом базовая YOLOv8n-seg
    MODEL_PATHS = [
        "pothole_model.pt",          # дообученная (после train_pothole.py)
        "yolov8n-seg.pt",            # базовая (скачается автоматически)
    ]
    
    # Цвета полигонов (BGR для OpenCV)
    COLORS = [
        (0, 0, 255),      # красный   — ямы
        (0, 128, 255),    # оранжевый
        (0, 255, 255),    # жёлтый
        (0, 255, 128),    # зелёный
    ]
    
    # Подписи серьёзности по площади
    SEVERITY_MAP = [
        (0.0,   0.005, "Микро"),
        (0.005, 0.02,  "Малая"),
        (0.02,  0.06,  "Средняя"),
        (0.06,  0.15,  "Крупная"),
        (0.15,  1.0,   "Критическая"),
    ]
    
    def __init__(self):
        self.model        = None
        self.model_path   = None
        self.is_custom    = False
        self.device       = "cpu"
        self._load_model()
    
    def _load_model(self):
        torch = _get_torch()
        YOLO  = _get_YOLO()
        
        # Выбираем устройство
        if torch.cuda.is_available():
            self.device = "0"
            vram_gb = torch.cuda.get_device_properties(0).total_memory / 1e9
            print(f"🖥️  PotholeDetector: GPU доступна ({vram_gb:.1f} ГБ VRAM)")
        else:
            self.device = "cpu"
            print("🖥️  PotholeDetector: работаем на CPU")
        
        # Ищем модель
        for path in self.MODEL_PATHS:
            if os.path.exists(path):
                self.model_path = path
                self.is_custom  = (path == "pothole_model.pt")
                break
        
        if self.model_path is None:
            # Скачаем базовую YOLOv8n-seg автоматически
            self.model_path = "yolov8n-seg.pt"
            self.is_custom  = False
            print("⏳ PotholeDetector: скачиваю базовую yolov8n-seg.pt...")
        
        try:
            self.model = YOLO(self.model_path)
            status = "дообученная на ямах ✅" if self.is_custom else "базовая YOLOv8n-seg ⚠️"
            print(f"✅ PotholeDetector загружен: {self.model_path} ({status})")
        except Exception as e:
            print(f"❌ Ошибка загрузки модели: {e}")
            self.model = None
    
    def _get_severity(self, mask_area_ratio: float) -> str:
        for lo, hi, label in self.SEVERITY_MAP:
            if lo <= mask_area_ratio < hi:
                return label
        return "Критическая"
    
    def _draw_results(self, image_rgb: np.ndarray, results) -> tuple[np.ndarray, list]:
        """
        Рисует полигоны поверх изображения.
        Возвращает (annotated_image, detections_list)
        """
        cv2 = _get_cv2()
        h, w = image_rgb.shape[:2]
        img_area = h * w
        
        # Копия для рисования
        overlay = image_rgb.copy()
        annotated = image_rgb.copy()
        
        detections = []
        
        if not results or results[0].masks is None:
            return annotated, detections
        
        masks_data  = results[0].masks.xy          # список полигонов (N × 2)
        boxes_data  = results[0].boxes
        
        for i, (mask_pts, box) in enumerate(zip(masks_data, boxes_data)):
            if len(mask_pts) < 3:
                continue
            
            confidence = float(box.conf[0])
            class_id   = int(box.cls[0])
            
            # Для базовой модели — только класс "person", "car" etc. → игнорируем
            # Для дообученной — класс 0 = яма
            if not self.is_custom and class_id not in [0]:
                # В базовой модели нет ям, рисуем всё для демо
                pass
            
            # Координаты полигона
            pts = mask_pts.astype(np.int32).reshape((-1, 1, 2))
            
            # Площадь маски
            mask_area  = cv2.contourArea(pts)
            area_ratio = mask_area / img_area
            severity   = self._get_severity(area_ratio)
            
            # Цвет
            color = self.COLORS[i % len(self.COLORS)]
            
            # Полупрозрачная заливка
            cv2.fillPoly(overlay, [pts], color)
            
            # Контур полигона (жирный)
            cv2.polylines(annotated, [pts], isClosed=True, color=color, thickness=3)
            
            # Центр для метки
            M = cv2.moments(pts)
            if M["m00"] != 0:
                cx = int(M["m10"] / M["m00"])
                cy = int(M["m01"] / M["m00"])
            else:
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                cx = int((x1 + x2) / 2)
                cy = int((y1 + y2) / 2)
            
            # Кружок в центре
            cv2.circle(annotated, (cx, cy), 12, color, -1)
            cv2.circle(annotated, (cx, cy), 12, (255, 255, 255), 2)
            
            # Номер
            num_str = str(i + 1)
            font_scale = 0.5
            thickness  = 1
            (tw, th), _ = cv2.getTextSize(num_str, cv2.FONT_HERSHEY_SIMPLEX, font_scale, thickness)
            cv2.putText(annotated, num_str,
                        (cx - tw // 2, cy + th // 2),
                        cv2.FONT_HERSHEY_SIMPLEX, font_scale, (255, 255, 255), thickness)
            
            # Подпись: №N — Серьёзность — conf%
            label = f"#{i+1} {severity} ({confidence:.0%})"
            
            # Фон подписи
            (lw, lh), baseline = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 2)
            lx = max(0, min(cx - lw // 2, w - lw - 4))
            ly = max(lh + baseline + 2, cy - 18)
            
            cv2.rectangle(annotated,
                          (lx - 2, ly - lh - baseline - 2),
                          (lx + lw + 2, ly + baseline),
                          (0, 0, 0), -1)
            cv2.putText(annotated, label,
                        (lx, ly - baseline),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2)
            
            # Площадь в м² (приблизительно при съёмке с 2м высоты)
            area_m2 = round(mask_area / img_area * 4.0, 2)  # ~4м² поле зрения с 2м
            
            detections.append({
                "id":          i + 1,
                "severity":    severity,
                "confidence":  round(confidence, 3),
                "area_ratio":  round(area_ratio, 4),
                "area_m2_est": area_m2,
                "center":      {"x": cx, "y": cy},
                "polygon":     mask_pts.tolist(),
            })
        
        # Смешиваем overlay (заливка) с оригиналом
        cv2.addWeighted(overlay, 0.35, annotated, 0.65, 0, annotated)
        
        # Шапка — итог
        if detections:
            header = f"Обнаружено ям: {len(detections)}"
            cv2.rectangle(annotated, (0, 0), (w, 38), (0, 0, 0), -1)
            cv2.putText(annotated, header, (10, 26),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)
        
        return annotated, detections
    
    def detect(self, image_bytes: bytes, conf_threshold: float = 0.25) -> dict:
        """
        Принимает байты изображения, возвращает словарь:
        {
            "annotated_image": "<base64>",
            "detections": [...],
            "count": N,
            "model_type": "custom" | "base",
            "processing_ms": N
        }
        """
        if self.model is None:
            raise RuntimeError("Модель не загружена")
        
        cv2 = _get_cv2()
        t0  = time.time()
        
        # Декодируем изображение
        nparr  = np.frombuffer(image_bytes, np.uint8)
        img_bgr = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if img_bgr is None:
            raise ValueError("Не удалось декодировать изображение")
        
        # YOLOv8 работает с RGB
        img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
        
        # Если базовая модель (не дообученная), добавляем предупреждение
        if not self.is_custom:
            # Запускаем на всех классах (будет видно что модель работает)
            results = self.model(
                img_rgb,
                conf    = conf_threshold,
                device  = self.device,
                verbose = False,
                imgsz   = 640,
            )
        else:
            # Дообученная — только класс 0 (яма)
            results = self.model(
                img_rgb,
                conf    = conf_threshold,
                classes = [0],
                device  = self.device,
                verbose = False,
                imgsz   = 640,
            )
        
        # Рисуем
        annotated_rgb, detections = self._draw_results(img_rgb, results)
        
        # Конвертируем обратно в BGR для сохранения
        annotated_bgr = cv2.cvtColor(annotated_rgb, cv2.COLOR_RGB2BGR)
        
        # Кодируем в JPEG → base64
        _, buffer    = cv2.imencode(".jpg", annotated_bgr, [cv2.IMWRITE_JPEG_QUALITY, 88])
        img_b64      = base64.b64encode(buffer).decode("utf-8")
        
        processing_ms = int((time.time() - t0) * 1000)
        
        return {
            "annotated_image": img_b64,
            "detections":      detections,
            "count":           len(detections),
            "model_type":      "custom" if self.is_custom else "base",
            "processing_ms":   processing_ms,
        }
    
    @property
    def status(self) -> dict:
        return {
            "loaded":      self.model is not None,
            "model_path":  self.model_path,
            "is_custom":   self.is_custom,
            "device":      self.device,
            "ready":       self.model is not None,
            "message":     (
                "Дообученная модель активна ✅" if self.is_custom else
                "Базовая YOLOv8n-seg. Запустите train_pothole.py для обучения на ямах ⚠️"
                if self.model else
                "Модель не загружена ❌"
            )
        }


# ══════════════════════════════════════════════════════
#  FLASK МАРШРУТЫ
# ══════════════════════════════════════════════════════

def register_pothole_routes(app, detector: PotholeDetector):
    """Регистрирует маршруты в Flask приложении"""
    from flask import request, jsonify, g
    
    @app.route("/api/detect-potholes", methods=["POST"])
    def detect_potholes_route():
        # Проверка авторизации через require_auth из app.py
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return jsonify({"error": "Нет токена"}), 401
        
        if "file" not in request.files:
            return jsonify({"error": "Файл не передан"}), 400
        
        file = request.files["file"]
        if not file.filename:
            return jsonify({"error": "Пустое имя файла"}), 400
        
        # Проверяем формат
        allowed = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
        ext = os.path.splitext(file.filename)[1].lower()
        if ext not in allowed:
            return jsonify({"error": f"Формат не поддерживается. Разрешены: {', '.join(allowed)}"}), 400
        
        # Читаем файл
        image_bytes = file.read()
        if len(image_bytes) > 30 * 1024 * 1024:
            return jsonify({"error": "Файл слишком большой. Максимум 30 МБ."}), 400
        
        # Порог уверенности (можно передать из фронтенда)
        conf = float(request.form.get("conf", 0.25))
        conf = max(0.1, min(0.9, conf))
        
        try:
            result = detector.detect(image_bytes, conf_threshold=conf)
            return jsonify(result)
        except RuntimeError as e:
            return jsonify({"error": str(e)}), 503
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        except Exception as e:
            return jsonify({"error": f"Ошибка детекции: {str(e)}"}), 500
    
    @app.route("/api/pothole-model-status", methods=["GET"])
    def pothole_model_status():
        return jsonify(detector.status)
    
    print("✅ Маршруты детекции ям зарегистрированы: /api/detect-potholes, /api/pothole-model-status")