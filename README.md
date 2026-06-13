# MQTT 设备监控演示系统

一个最小可演示的 Web 监控系统：

- 后端内置 MQTT 服务端
- 解析设备 JSON 消息
- 将消息写入 SQLite
- 维护每台设备的最新状态
- 通过 SSE 实时推送到浏览器看板
- 支持在线/离线状态、报警筛选和最近消息列表

## 技术栈

- Node.js 26+
- Aedes
- Express
- Node 内置 `node:sqlite`
- 原生 HTML / CSS / JavaScript

## 快速启动

1. 安装依赖

```bash
npm install
```

2. 配置环境变量

可以参考 [`.env.example`](/Users/zzc/userfile/iot-message-hub/.env.example)：

```bash
export PORT=3100
export MQTT_PORT=1883
export MQTT_TOPIC=devices/telemetry
export MQTT_USERNAME=
export MQTT_PASSWORD=
export DB_PATH=./data/monitor.db
export ONLINE_TIMEOUT_SECONDS=90
export RECENT_MESSAGES_LIMIT=12
```

3. 启动服务

```bash
npm start
```

4. 打开页面

浏览器访问 [http://localhost:3100](http://localhost:3100)

## 页面能力

- 顶部统计卡片
  - 设备总数
  - 在线设备
  - 离线设备
  - 报警设备
  - 累计消息
- 设备总览表
  - 每台设备最新状态
  - 在线/离线状态
  - 最近上报时间
  - 报警类型
- 报警筛选
  - 全部
  - 仅报警
  - 离线
  - 正常
  - 泄露
  - 超温
  - 爆管
- 最近消息列表
  - 展示最新接收的有效消息

## 服务端角色

这个程序本身就是 MQTT 服务端。

- 嵌入式设备连接到这台机器的 MQTT 端口
- 设备向 `MQTT_TOPIC` 发布 JSON 消息
- 程序接收消息后落库并推送到 Web 监控页

如果设备和服务不在同一台机器，设备端应连接：

```text
mqtt://<这台服务器的IP>:1883
```

## MQTT 消息格式

设备上报消息必须是 JSON，固定字段如下：

```json
{
  "serialNo": "DEV-001",
  "pressure": 1.25,
  "temperature": 36.8,
  "alarmType": "normal",
  "timestamp": "2026-06-13T21:30:00Z"
}
```

支持的 `alarmType`：

- `normal`
- `leak`
- `overtemp`
- `burst`

如果 `timestamp` 缺失或非法，服务端会自动补当前时间。

## HTTP 接口

- `GET /api/dashboard`
  - 返回设备列表、统计数据、最近消息，供首页一次性加载
- `GET /api/devices`
  - 返回所有设备的最新状态和统计数据
- `GET /api/messages`
  - 返回最近消息列表，支持 `limit` 参数
- `GET /api/stats`
  - 返回设备统计和消息统计
- `GET /api/stream`
  - SSE 实时推送设备更新
- `GET /health`
  - 服务健康状态

## 数据库说明

SQLite 默认存放在 `./data/monitor.db`。

- `message_logs`
  - 保存每条接收到的消息，包括解析失败记录
- `device_latest`
  - 保存每台设备的最新状态

## 在线状态规则

- 服务端根据 `last_received_at` 判断设备是否在线
- 默认超过 `90` 秒未收到新消息，就标记为离线
- 可通过 `ONLINE_TIMEOUT_SECONDS` 调整

## 设备接入示例

设备应向 `MQTT_TOPIC` 发布 JSON 消息。

如果你用别的工具临时测试，也可以手工连本机 Broker：

```text
Broker: mqtt://127.0.0.1:1883
Topic: devices/telemetry
```

## 演示建议

- 如果暂时不想启动内置 MQTT 服务端，可以临时设置：

```bash
export MQTT_DISABLED=true
```

这样页面和 Web 服务仍然可以启动，但不会监听 MQTT 端口。
