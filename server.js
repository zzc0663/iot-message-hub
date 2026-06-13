const fs = require("node:fs");
const path = require("node:path");
const { createServer: createTcpServer } = require("node:net");
const { DatabaseSync } = require("node:sqlite");

const express = require("express");
const { Aedes } = require("aedes");

const ALARM_LABELS = {
  normal: "运行正常",
  leak: "泄露报警",
  overtemp: "超温报警",
  burst: "爆管报警",
};

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function loadConfig() {
  return {
    port: Number.parseInt(process.env.PORT || "3100", 10),
    mqttPort: Number.parseInt(process.env.MQTT_PORT || "1883", 10),
    mqttTopic: process.env.MQTT_TOPIC || "devices/telemetry",
    mqttUsername: process.env.MQTT_USERNAME || "",
    mqttPassword: process.env.MQTT_PASSWORD || "",
    dbPath: process.env.DB_PATH || "./data/monitor.db",
    mqttDisabled: process.env.MQTT_DISABLED === "true",
    onlineTimeoutSeconds: Number.parseInt(process.env.ONLINE_TIMEOUT_SECONDS || "90", 10),
    recentMessagesLimit: Number.parseInt(process.env.RECENT_MESSAGES_LIMIT || "12", 10),
    requiredProtocolVersion: process.env.REQUIRED_PROTOCOL_VERSION || "",
    serialNoMaxLength: Number.parseInt(process.env.SERIALNO_MAX_LENGTH || "64", 10),
    pressureMin: parseOptionalNumber(process.env.PRESSURE_MIN),
    pressureMax: parseOptionalNumber(process.env.PRESSURE_MAX),
    temperatureMin: parseOptionalNumber(process.env.TEMPERATURE_MIN),
    temperatureMax: parseOptionalNumber(process.env.TEMPERATURE_MAX),
    snapshotBroadcastIntervalSeconds: Number.parseInt(process.env.SNAPSHOT_BROADCAST_INTERVAL_SECONDS || "5", 10),
  };
}

function ensureDatabasePath(dbPath) {
  if (dbPath === ":memory:") {
    return;
  }

  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
}

function isAlertAlarm(alarmType) {
  return alarmType && alarmType !== "normal";
}

function toDeviceView(row, onlineTimeoutMs, nowMs = Date.now()) {
  const lastReceivedAt = row.lastReceivedAt || row.receivedAt || row.updatedAt;
  const lastReceivedMs = Date.parse(lastReceivedAt);
  const hasLastReceived = Number.isFinite(lastReceivedMs);
  const lastSeenSeconds = hasLastReceived
    ? Math.max(0, Math.floor((nowMs - lastReceivedMs) / 1000))
    : null;
  const isOnline = hasLastReceived ? lastSeenSeconds <= Math.floor(onlineTimeoutMs / 1000) : false;

  return {
    serialNo: row.serialNo,
    pressure: row.pressure,
    temperature: row.temperature,
    alarmType: row.alarmType,
    alarmLabel: ALARM_LABELS[row.alarmType] || row.alarmType,
    updatedAt: row.updatedAt,
    lastReceivedAt,
    status: isOnline ? "online" : "offline",
    statusLabel: isOnline ? "在线" : "离线",
    isAlert: isAlertAlarm(row.alarmType),
    lastSeenSeconds,
  };
}

function toMessageView(row) {
  return {
    id: row.id,
    topic: row.topic,
    serialNo: row.serialNo,
    pressure: row.pressure,
    temperature: row.temperature,
    alarmType: row.alarmType,
    alarmLabel: ALARM_LABELS[row.alarmType] || row.alarmType,
    updatedAt: row.updatedAt,
    receivedAt: row.receivedAt,
    parseStatus: row.parseStatus,
    errorMessage: row.errorMessage,
    isAlert: isAlertAlarm(row.alarmType),
  };
}

function buildStats(devices, messageSummary) {
  const onlineDevices = devices.filter((device) => device.status === "online").length;
  const alertDevices = devices.filter((device) => device.isAlert).length;

  return {
    totalDevices: devices.length,
    onlineDevices,
    offlineDevices: devices.length - onlineDevices,
    alertDevices,
    normalDevices: devices.length - alertDevices,
    totalMessages: messageSummary.totalMessages,
    validMessages: messageSummary.validMessages,
    invalidMessages: messageSummary.invalidMessages,
    updatedAt: new Date().toISOString(),
  };
}

function clampLimit(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function openDatabase(dbPath) {
  ensureDatabasePath(dbPath);

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      raw_payload TEXT NOT NULL,
      serial_no TEXT,
      pressure REAL,
      temperature REAL,
      alarm_type TEXT,
      device_timestamp TEXT,
      received_at TEXT NOT NULL,
      parse_status TEXT NOT NULL,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS device_latest (
      serial_no TEXT PRIMARY KEY,
      pressure REAL NOT NULL,
      temperature REAL NOT NULL,
      alarm_type TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_topic TEXT NOT NULL,
      last_received_at TEXT NOT NULL
    );
  `);

  return db;
}

function createStore(db, config) {
  const onlineTimeoutMs = Math.max(5, config.onlineTimeoutSeconds) * 1000;

  const insertMessageLog = db.prepare(`
    INSERT INTO message_logs (
      topic,
      raw_payload,
      serial_no,
      pressure,
      temperature,
      alarm_type,
      device_timestamp,
      received_at,
      parse_status,
      error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertLatest = db.prepare(`
    INSERT INTO device_latest (
      serial_no,
      pressure,
      temperature,
      alarm_type,
      updated_at,
      last_topic,
      last_received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(serial_no) DO UPDATE SET
      pressure = excluded.pressure,
      temperature = excluded.temperature,
      alarm_type = excluded.alarm_type,
      updated_at = excluded.updated_at,
      last_topic = excluded.last_topic,
      last_received_at = excluded.last_received_at
  `);

  const selectDevices = db.prepare(`
    SELECT
      serial_no AS serialNo,
      pressure,
      temperature,
      alarm_type AS alarmType,
      updated_at AS updatedAt,
      last_received_at AS lastReceivedAt
    FROM device_latest
    ORDER BY updated_at DESC, serial_no ASC
  `);

  const selectDeviceBySerial = db.prepare(`
    SELECT
      serial_no AS serialNo,
      pressure,
      temperature,
      alarm_type AS alarmType,
      updated_at AS updatedAt,
      last_received_at AS lastReceivedAt
    FROM device_latest
    WHERE serial_no = ?
  `);

  const selectRecentMessages = db.prepare(`
    SELECT
      id,
      topic,
      serial_no AS serialNo,
      pressure,
      temperature,
      alarm_type AS alarmType,
      device_timestamp AS updatedAt,
      received_at AS receivedAt,
      parse_status AS parseStatus,
      error_message AS errorMessage
    FROM message_logs
    WHERE parse_status = 'valid'
    ORDER BY id DESC
    LIMIT ?
  `);

  const selectMessageSummary = db.prepare(`
    SELECT
      COUNT(*) AS totalMessages,
      SUM(CASE WHEN parse_status = 'valid' THEN 1 ELSE 0 END) AS validMessages,
      SUM(CASE WHEN parse_status != 'valid' THEN 1 ELSE 0 END) AS invalidMessages
    FROM message_logs
  `);

  return {
    logMessage(entry) {
      insertMessageLog.run(
        entry.topic,
        entry.rawPayload,
        entry.serialNo,
        entry.pressure,
        entry.temperature,
        entry.alarmType,
        entry.deviceTimestamp,
        entry.receivedAt,
        entry.parseStatus,
        entry.errorMessage
      );
    },

    saveLatest(device) {
      upsertLatest.run(
        device.serialNo,
        device.pressure,
        device.temperature,
        device.alarmType,
        device.updatedAt,
        device.topic,
        device.receivedAt
      );
    },

    listDevices(nowMs = Date.now()) {
      return selectDevices.all().map((row) => toDeviceView(row, onlineTimeoutMs, nowMs));
    },

    getDevice(serialNo, nowMs = Date.now()) {
      const row = selectDeviceBySerial.get(serialNo);
      return row ? toDeviceView(row, onlineTimeoutMs, nowMs) : null;
    },

    listRecentMessages(limit = config.recentMessagesLimit) {
      return selectRecentMessages.all(limit).map((row) => toMessageView(row));
    },

    getMessageSummary() {
      const summary = selectMessageSummary.get();
      return {
        totalMessages: summary.totalMessages || 0,
        validMessages: summary.validMessages || 0,
        invalidMessages: summary.invalidMessages || 0,
      };
    },

    getDashboardSnapshot() {
      const nowMs = Date.now();
      const devices = this.listDevices(nowMs);
      const recentMessages = this.listRecentMessages(config.recentMessagesLimit);
      return {
        devices,
        recentMessages,
        stats: buildStats(devices, this.getMessageSummary()),
      };
    },
  };
}

function normalizeMessage(payloadBuffer, topic, receivedAt = new Date().toISOString(), config = loadConfig()) {
  const rawPayload = Buffer.isBuffer(payloadBuffer)
    ? payloadBuffer.toString("utf8")
    : String(payloadBuffer);

  let parsed;
  try {
    parsed = JSON.parse(rawPayload);
  } catch (error) {
    return {
      ok: false,
      error: "Invalid JSON payload",
      logEntry: {
        topic,
        rawPayload,
        serialNo: null,
        pressure: null,
        temperature: null,
        alarmType: null,
        deviceTimestamp: null,
        receivedAt,
        parseStatus: "invalid_json",
        errorMessage: error.message,
      },
    };
  }

  const serialNo = typeof parsed.serialNo === "string" ? parsed.serialNo.trim() : "";
  const pressure = Number(parsed.pressure);
  const temperature = Number(parsed.temperature);
  const alarmType = typeof parsed.alarmType === "string" ? parsed.alarmType.trim() : "";
  const protocolVersion =
    typeof parsed.protocolVersion === "string" || typeof parsed.protocolVersion === "number"
      ? String(parsed.protocolVersion)
      : "";

  const validationErrors = [];

  if (!serialNo) {
    validationErrors.push("serialNo is required");
  } else {
    if (serialNo.length > config.serialNoMaxLength) {
      validationErrors.push(`serialNo exceeds ${config.serialNoMaxLength} characters`);
    }
    if (!/^[A-Za-z0-9._:-]+$/.test(serialNo)) {
      validationErrors.push("serialNo contains unsupported characters");
    }
  }

  if (!Number.isFinite(pressure)) {
    validationErrors.push("pressure must be a finite number");
  } else {
    if (config.pressureMin !== null && pressure < config.pressureMin) {
      validationErrors.push(`pressure must be >= ${config.pressureMin}`);
    }
    if (config.pressureMax !== null && pressure > config.pressureMax) {
      validationErrors.push(`pressure must be <= ${config.pressureMax}`);
    }
  }

  if (!Number.isFinite(temperature)) {
    validationErrors.push("temperature must be a finite number");
  } else {
    if (config.temperatureMin !== null && temperature < config.temperatureMin) {
      validationErrors.push(`temperature must be >= ${config.temperatureMin}`);
    }
    if (config.temperatureMax !== null && temperature > config.temperatureMax) {
      validationErrors.push(`temperature must be <= ${config.temperatureMax}`);
    }
  }

  if (!ALARM_LABELS[alarmType]) {
    validationErrors.push("alarmType is unsupported");
  }

  if (config.requiredProtocolVersion && protocolVersion !== config.requiredProtocolVersion) {
    validationErrors.push(`protocolVersion must be ${config.requiredProtocolVersion}`);
  }

  if (validationErrors.length > 0) {
    return {
      ok: false,
      error: "Missing or invalid required fields",
      logEntry: {
        topic,
        rawPayload,
        serialNo: serialNo || null,
        pressure: Number.isFinite(pressure) ? pressure : null,
        temperature: Number.isFinite(temperature) ? temperature : null,
        alarmType: alarmType || null,
        deviceTimestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : null,
        receivedAt,
        parseStatus: "invalid_fields",
        errorMessage: validationErrors.join("; "),
      },
    };
  }

  const parsedTimestamp = typeof parsed.timestamp === "string" ? new Date(parsed.timestamp) : null;
  const updatedAt =
    parsedTimestamp && !Number.isNaN(parsedTimestamp.getTime())
      ? parsedTimestamp.toISOString()
      : receivedAt;

  return {
    ok: true,
    device: {
      serialNo,
      pressure,
      temperature,
      alarmType,
      alarmLabel: ALARM_LABELS[alarmType],
      updatedAt,
      topic,
      receivedAt,
    },
    logEntry: {
      topic,
      rawPayload,
      serialNo,
      pressure,
      temperature,
      alarmType,
      deviceTimestamp: updatedAt,
      receivedAt,
      parseStatus: "valid",
      errorMessage: null,
    },
  };
}

function createBroadcaster() {
  const clients = new Set();

  function send(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  return {
    addClient(res) {
      clients.add(res);
      send(res, { type: "connected", connectedAt: new Date().toISOString() });
    },

    removeClient(res) {
      clients.delete(res);
    },

    broadcast(payload) {
      for (const client of clients) {
        send(client, payload);
      }
    },

    broadcastHeartbeat() {
      for (const client of clients) {
        client.write(`: heartbeat ${Date.now()}\n\n`);
      }
    },

    count() {
      return clients.size;
    },

    closeAll() {
      for (const client of clients) {
        client.end();
      }
      clients.clear();
    },
  };
}

function createMonitorServer(config = {}) {
  const resolvedConfig = {
    ...loadConfig(),
    ...config,
  };

  const db = openDatabase(resolvedConfig.dbPath);
  const store = createStore(db, resolvedConfig);
  const broadcaster = createBroadcaster();
  const app = express();

  let broker = null;
  let mqttServer = null;
  let httpServer = null;
  let heartbeatTimer = null;
  let snapshotTimer = null;
  let mqttBrokerRunning = false;
  const startedAt = new Date().toISOString();

  function processIncomingPayload(topic, payloadBuffer, receivedAt = new Date().toISOString()) {
    const result = normalizeMessage(payloadBuffer, topic, receivedAt, resolvedConfig);
    store.logMessage(result.logEntry);

    if (!result.ok) {
      console.error(`[mqtt] Dropped message from topic "${topic}": ${result.error}`);
      return { ok: false, error: result.error };
    }

    store.saveLatest(result.device);

    const device = store.getDevice(result.device.serialNo);
    const message = store.listRecentMessages(1)[0] || null;
    const stats = buildStats(store.listDevices(), store.getMessageSummary());

    broadcaster.broadcast({
      type: "device_update",
      device,
      message,
      stats,
    });

    return { ok: true, device, message, stats };
  }

  function getDashboardSnapshot() {
    return store.getDashboardSnapshot();
  }

  function broadcastSnapshot() {
    const snapshot = getDashboardSnapshot();
    broadcaster.broadcast({
      type: "snapshot",
      ...snapshot,
    });
  }

  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/dashboard", (req, res) => {
    res.json(getDashboardSnapshot());
  });

  app.get("/api/devices", (req, res) => {
    const filter = String(req.query.filter || "all");
    let items = store.listDevices();

    if (filter === "alerts") {
      items = items.filter((item) => item.isAlert);
    } else if (filter === "offline") {
      items = items.filter((item) => item.status === "offline");
    } else if (filter !== "all") {
      items = items.filter((item) => item.alarmType === filter);
    }

    res.json({
      items,
      total: items.length,
      stats: buildStats(store.listDevices(), store.getMessageSummary()),
    });
  });

  app.get("/api/messages", (req, res) => {
    const limit = clampLimit(req.query.limit || resolvedConfig.recentMessagesLimit, 1, 100, resolvedConfig.recentMessagesLimit);
    const serialNo = String(req.query.serialNo || "").trim();
    const alarmType = String(req.query.alarmType || "").trim();

    let items = store.listRecentMessages(limit * 5);

    if (serialNo) {
      items = items.filter((item) => item.serialNo === serialNo);
    }

    if (alarmType) {
      items = items.filter((item) => item.alarmType === alarmType);
    }

    res.json({
      items: items.slice(0, limit),
      total: store.getMessageSummary().validMessages,
    });
  });

  app.get("/api/stats", (req, res) => {
    const devices = store.listDevices();
    res.json(buildStats(devices, store.getMessageSummary()));
  });

  app.get("/api/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    broadcaster.addClient(res);

    req.on("close", () => {
      broadcaster.removeClient(res);
    });
  });

  app.get("/health", (req, res) => {
    const devices = store.listDevices();
    res.json({
      ok: true,
      mqttBrokerRunning,
      mqttPort: resolvedConfig.mqttPort,
      mqttTopic: resolvedConfig.mqttTopic,
      mqttConnectedClients: broker ? broker.connectedClients : 0,
      sseClients: broadcaster.count(),
      onlineTimeoutSeconds: resolvedConfig.onlineTimeoutSeconds,
      requiredProtocolVersion: resolvedConfig.requiredProtocolVersion || null,
      validation: {
        serialNoMaxLength: resolvedConfig.serialNoMaxLength,
        pressureMin: resolvedConfig.pressureMin,
        pressureMax: resolvedConfig.pressureMax,
        temperatureMin: resolvedConfig.temperatureMin,
        temperatureMax: resolvedConfig.temperatureMax,
      },
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000)),
      stats: buildStats(devices, store.getMessageSummary()),
      timestamp: new Date().toISOString(),
    });
  });

  function configureBrokerAuth(instance) {
    if (!resolvedConfig.mqttUsername && !resolvedConfig.mqttPassword) {
      return;
    }

    instance.authenticate = function authenticate(client, username, password, callback) {
      const user = username ? username.toString() : "";
      const pass = password ? password.toString() : "";
      const allowed = user === resolvedConfig.mqttUsername && pass === resolvedConfig.mqttPassword;
      callback(null, allowed);
    };
  }

  function configureBrokerPublish(instance) {
    instance.authorizePublish = function authorizePublish(client, packet, callback) {
      if (packet.topic.startsWith("$SYS/")) {
        callback(new Error("$SYS topics are reserved"));
        return;
      }

      callback(null);
    };

    instance.on("publish", (packet, client) => {
      if (!client) {
        return;
      }

      if (packet.topic !== resolvedConfig.mqttTopic) {
        return;
      }

      processIncomingPayload(packet.topic, packet.payload);
    });

    instance.on("clientReady", (client) => {
      console.log(`[mqtt] Client connected: ${client.id}`);
    });

    instance.on("clientDisconnect", (client) => {
      console.log(`[mqtt] Client disconnected: ${client.id}`);
    });

    instance.on("clientError", (client, error) => {
      console.error(`[mqtt] Client error (${client?.id || "unknown"}): ${error.message}`);
    });

    instance.on("connectionError", (client, error) => {
      console.error(`[mqtt] Connection error (${client?.id || "unknown"}): ${error.message}`);
    });
  }

  async function startBroker() {
    if (resolvedConfig.mqttDisabled) {
      console.warn("[mqtt] Embedded MQTT broker disabled by configuration");
      return;
    }

    broker = await Aedes.createBroker();
    configureBrokerAuth(broker);
    configureBrokerPublish(broker);

    mqttServer = createTcpServer(broker.handle);

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        mqttServer.off("listening", onListening);
        reject(error);
      };

      const onListening = () => {
        mqttServer.off("error", onError);
        resolve();
      };

      mqttServer.once("error", onError);
      mqttServer.once("listening", onListening);
      mqttServer.listen(resolvedConfig.mqttPort);
    });

    mqttBrokerRunning = true;
    console.log(`MQTT broker listening on mqtt://0.0.0.0:${resolvedConfig.mqttPort}`);
    console.log(`MQTT ingest topic: ${resolvedConfig.mqttTopic}`);
  }

  async function startHttpServer() {
    await new Promise((resolve, reject) => {
      const server = app.listen(resolvedConfig.port, () => {
        httpServer = server;
        resolve();
      });

      server.once("error", reject);
    });

    console.log(`Web monitor running at http://localhost:${resolvedConfig.port}`);
  }

  async function start() {
    heartbeatTimer = setInterval(() => {
      broadcaster.broadcastHeartbeat();
    }, 25000);

    snapshotTimer = setInterval(() => {
      broadcastSnapshot();
    }, Math.max(2, resolvedConfig.snapshotBroadcastIntervalSeconds) * 1000);

    await startBroker();
    await startHttpServer();
    return httpServer;
  }

  async function stop() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    if (snapshotTimer) {
      clearInterval(snapshotTimer);
      snapshotTimer = null;
    }

    broadcaster.closeAll();

    if (broker && broker.clients) {
      const clientIds = Object.keys(broker.clients);
      await Promise.all(
        clientIds.map(
          (clientId) =>
            new Promise((resolve) => {
              const client = broker.clients[clientId];
              if (!client || client.closed) {
                resolve();
                return;
              }

              client.close(() => resolve());
            })
        )
      );
    }

    if (httpServer) {
      await new Promise((resolve) => httpServer.close(resolve));
      httpServer = null;
    }

    if (mqttServer) {
      await new Promise((resolve) => mqttServer.close(resolve));
      mqttServer = null;
    }

    if (broker) {
      await new Promise((resolve) => broker.close(resolve));
      broker = null;
    }

    mqttBrokerRunning = false;
    db.close();
  }

  return {
    app,
    start,
    stop,
    processIncomingPayload,
    listDevices: () => store.listDevices(),
    getDashboardSnapshot,
  };
}

if (require.main === module) {
  (async () => {
    const monitorServer = createMonitorServer();
    await monitorServer.start();

    let shuttingDown = false;

    const shutdown = async () => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      await monitorServer.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  ALARM_LABELS,
  createMonitorServer,
  loadConfig,
  normalizeMessage,
};
