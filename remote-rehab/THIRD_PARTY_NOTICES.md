# 第三方运行库与模型说明

本页面在用户点击“启动 YOLO”后才动态加载下列固定版本组件。页面源码不上传视频帧；首次启动会从这些 CDN 下载运行库，模型文件由本网页同源目录提供。

| 组件 | 用途 | 版本/来源 | 许可证 |
|---|---|---|---|
| ONNX Runtime Web | 在浏览器运行 YOLOX-Nano ONNX | 1.27.0，jsDelivr | MIT，见 [Microsoft ONNX Runtime LICENSE](https://github.com/microsoft/onnxruntime/blob/main/LICENSE) |
| MediaPipe Tasks Vision | 姿态与人脸框检测 | 0.10.32，jsDelivr | Apache-2.0，见 [MediaPipe LICENSE](https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE) |
| YOLOX-Nano ONNX | 通用人员目标检测 | Megvii 官方 0.1.1rc0 发布文件 | Apache-2.0，见 [YOLOX LICENSE](https://github.com/Megvii-BaseDetection/YOLOX/blob/main/LICENSE) |
| Pose Landmarker Lite | 姿态关键点 | MediaPipe 官方模型存储 | Apache-2.0，见 MediaPipe LICENSE |
| BlazeFace Short Range | 人脸框检测，不识别身份 | MediaPipe 官方模型存储 | Apache-2.0，见 MediaPipe LICENSE |

本项目未修改这些第三方模型。使用前应确认部署组织的许可证审核和 CDN 网络策略；如果现场不能访问公共 CDN，应将对应运行库作为经过许可证审查的静态资源随站点托管，并保持版本固定。
