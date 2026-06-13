const test = require("node:test");
const assert = require("node:assert/strict");

const { ALARM_LABELS, createMonitorServer, normalizeMessage } = require("./server");

test("normalizeMessage parses a valid payload", () => {
  const result = normalizeMessage(
    JSON.stringify({
      serialNo: "DEV-001",
      pressure: 1.25,
      temperature: 36.8,
      alarmType: "normal",
      timestamp: "2026-06-13T21:30:00Z",
    }),
    "devices/telemetry",
    "2026-06-13T13:30:00.000Z"
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.device, {
    serialNo: "DEV-001",
    pressure: 1.25,
    temperature: 36.8,
    alarmType: "normal",
    alarmLabel: ALARM_LABELS.normal,
    updatedAt: "2026-06-13T21:30:00.000Z",
    topic: "devices/telemetry",
    receivedAt: "2026-06-13T13:30:00.000Z",
  });
});

test("normalizeMessage enforces configured protocol version and ranges", () => {
  const result = normalizeMessage(
    JSON.stringify({
      serialNo: "DEV-001",
      pressure: 12.5,
      temperature: 36.8,
      alarmType: "normal",
      protocolVersion: "1",
    }),
    "devices/telemetry",
    "2026-06-13T13:30:00.000Z",
    {
      ...require("./server").loadConfig(),
      requiredProtocolVersion: "2",
      pressureMax: 10,
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.logEntry.parseStatus, "invalid_fields");
  assert.match(result.logEntry.errorMessage, /protocolVersion must be 2/);
  assert.match(result.logEntry.errorMessage, /pressure must be <= 10/);
});

test("normalizeMessage rejects invalid json", () => {
  const result = normalizeMessage("{bad json", "devices/telemetry");

  assert.equal(result.ok, false);
  assert.equal(result.error, "Invalid JSON payload");
  assert.equal(result.logEntry.parseStatus, "invalid_json");
});

test("processIncomingPayload stores latest device state and updates on repeated messages", () => {
  const monitor = createMonitorServer({
    port: 0,
    mqttPort: 0,
    mqttTopic: "devices/telemetry",
    mqttUsername: "",
    mqttPassword: "",
    dbPath: ":memory:",
    mqttDisabled: true,
  });

  const first = monitor.processIncomingPayload(
    "devices/telemetry",
    JSON.stringify({
      serialNo: "DEV-777",
      pressure: 1.1,
      temperature: 22.5,
      alarmType: "normal",
      timestamp: "2026-06-13T10:00:00Z",
    })
  );

  const second = monitor.processIncomingPayload(
    "devices/telemetry",
    JSON.stringify({
      serialNo: "DEV-777",
      pressure: 1.8,
      temperature: 74.2,
      alarmType: "overtemp",
      timestamp: "2026-06-13T10:05:00Z",
    })
  );

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const devices = monitor.listDevices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].serialNo, "DEV-777");
  assert.equal(devices[0].pressure, 1.8);
  assert.equal(devices[0].temperature, 74.2);
  assert.equal(devices[0].alarmType, "overtemp");
  assert.equal(devices[0].updatedAt, "2026-06-13T10:05:00.000Z");
  assert.equal(devices[0].alarmLabel, ALARM_LABELS.overtemp);
  assert.equal(devices[0].isAlert, true);
  assert.equal(devices[0].status, "online");
  assert.equal(devices[0].statusLabel, "在线");
  assert.equal(typeof devices[0].lastReceivedAt, "string");

  monitor.stop();
});

test("processIncomingPayload ignores invalid fields without creating device rows", () => {
  const monitor = createMonitorServer({
    port: 0,
    mqttPort: 0,
    mqttTopic: "devices/telemetry",
    mqttUsername: "",
    mqttPassword: "",
    dbPath: ":memory:",
    mqttDisabled: true,
  });

  const result = monitor.processIncomingPayload(
    "devices/telemetry",
    JSON.stringify({
      serialNo: "DEV-404",
      pressure: "bad",
      temperature: 20,
      alarmType: "normal",
    })
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "Missing or invalid required fields");
  assert.deepEqual(monitor.listDevices(), []);

  monitor.stop();
});

test("dashboard snapshot includes stats and recent messages", () => {
  const monitor = createMonitorServer({
    port: 0,
    mqttPort: 0,
    mqttTopic: "devices/telemetry",
    mqttUsername: "",
    mqttPassword: "",
    dbPath: ":memory:",
    mqttDisabled: true,
  });

  monitor.processIncomingPayload(
    "devices/telemetry",
    JSON.stringify({
      serialNo: "DEV-100",
      pressure: 2.2,
      temperature: 43.5,
      alarmType: "leak",
      timestamp: "2026-06-13T11:00:00Z",
    })
  );

  monitor.processIncomingPayload(
    "devices/telemetry",
    JSON.stringify({
      serialNo: "DEV-200",
      pressure: 1.3,
      temperature: 30.1,
      alarmType: "normal",
      timestamp: "2026-06-13T11:01:00Z",
    })
  );

  const snapshot = monitor.getDashboardSnapshot();

  assert.equal(snapshot.devices.length, 2);
  assert.equal(snapshot.recentMessages.length, 2);
  assert.equal(snapshot.stats.totalDevices, 2);
  assert.equal(snapshot.stats.alertDevices, 1);
  assert.equal(snapshot.stats.validMessages, 2);
  assert.equal(snapshot.recentMessages[0].serialNo, "DEV-200");
  assert.equal(snapshot.recentMessages[1].serialNo, "DEV-100");

  monitor.stop();
});

test("device history returns valid messages for selected device in reverse chronological order", () => {
  const monitor = createMonitorServer({
    port: 0,
    mqttPort: 0,
    mqttTopic: "devices/telemetry",
    mqttUsername: "",
    mqttPassword: "",
    dbPath: ":memory:",
    mqttDisabled: true,
  });

  monitor.processIncomingPayload(
    "devices/telemetry",
    JSON.stringify({
      serialNo: "DEV-HISTORY",
      pressure: 1.1,
      temperature: 35.4,
      alarmType: "normal",
      timestamp: "2026-06-13T10:00:00Z",
    })
  );

  monitor.processIncomingPayload(
    "devices/telemetry",
    JSON.stringify({
      serialNo: "DEV-OTHER",
      pressure: 2.2,
      temperature: 45.8,
      alarmType: "leak",
      timestamp: "2026-06-13T10:01:00Z",
    })
  );

  monitor.processIncomingPayload(
    "devices/telemetry",
    JSON.stringify({
      serialNo: "DEV-HISTORY",
      pressure: 1.6,
      temperature: 39.2,
      alarmType: "overtemp",
      timestamp: "2026-06-13T10:02:00Z",
    })
  );

  const history = monitor.getDeviceHistory("DEV-HISTORY", { limit: 50, page: 1 });

  assert.ok(history);
  assert.equal(history.device.serialNo, "DEV-HISTORY");
  assert.equal(history.total, 2);
  assert.equal(history.items.length, 2);
  assert.equal(history.items[0].alarmType, "overtemp");
  assert.equal(history.items[1].alarmType, "normal");

  monitor.stop();
});

test("device history returns null for unknown device", () => {
  const monitor = createMonitorServer({
    port: 0,
    mqttPort: 0,
    mqttTopic: "devices/telemetry",
    mqttUsername: "",
    mqttPassword: "",
    dbPath: ":memory:",
    mqttDisabled: true,
  });

  const history = monitor.getDeviceHistory("NOT-FOUND", { limit: 50, page: 1 });
  assert.equal(history, null);

  monitor.stop();
});

test("device history supports pagination and alarm filtering", () => {
  const monitor = createMonitorServer({
    port: 0,
    mqttPort: 0,
    mqttTopic: "devices/telemetry",
    mqttUsername: "",
    mqttPassword: "",
    dbPath: ":memory:",
    mqttDisabled: true,
  });

  monitor.processIncomingPayload(
    "devices/telemetry",
    JSON.stringify({
      serialNo: "DEV-PAGE",
      pressure: 1.1,
      temperature: 31.1,
      alarmType: "normal",
      timestamp: "2026-06-13T10:00:00Z",
    })
  );

  monitor.processIncomingPayload(
    "devices/telemetry",
    JSON.stringify({
      serialNo: "DEV-PAGE",
      pressure: 1.2,
      temperature: 32.2,
      alarmType: "leak",
      timestamp: "2026-06-13T10:01:00Z",
    })
  );

  monitor.processIncomingPayload(
    "devices/telemetry",
    JSON.stringify({
      serialNo: "DEV-PAGE",
      pressure: 1.3,
      temperature: 33.3,
      alarmType: "overtemp",
      timestamp: "2026-06-13T10:02:00Z",
    })
  );

  const firstPage = monitor.getDeviceHistory("DEV-PAGE", {
    limit: 2,
    page: 1,
  });
  const secondPage = monitor.getDeviceHistory("DEV-PAGE", {
    limit: 2,
    page: 2,
  });
  const leakOnly = monitor.getDeviceHistory("DEV-PAGE", {
    limit: 10,
    page: 1,
    alarmType: "leak",
  });

  assert.equal(firstPage.total, 3);
  assert.equal(firstPage.totalPages, 2);
  assert.equal(firstPage.items.length, 2);
  assert.equal(firstPage.items[0].alarmType, "overtemp");
  assert.equal(firstPage.items[1].alarmType, "leak");

  assert.equal(secondPage.page, 2);
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.items[0].alarmType, "normal");

  assert.equal(leakOnly.total, 1);
  assert.equal(leakOnly.totalPages, 1);
  assert.equal(leakOnly.items.length, 1);
  assert.equal(leakOnly.items[0].alarmType, "leak");

  monitor.stop();
});

test("deleteDevice removes latest device entry from dashboards", () => {
  const monitor = createMonitorServer({
    port: 0,
    mqttPort: 0,
    mqttTopic: "devices/telemetry",
    mqttUsername: "",
    mqttPassword: "",
    dbPath: ":memory:",
    mqttDisabled: true,
  });

  monitor.processIncomingPayload(
    "devices/telemetry",
    JSON.stringify({
      serialNo: "DEV-DEL",
      pressure: 1.8,
      temperature: 43.2,
      alarmType: "burst",
      timestamp: "2026-06-13T10:10:00Z",
    })
  );

  assert.equal(monitor.listDevices().length, 1);

  const deleted = monitor.deleteDevice("DEV-DEL");
  assert.ok(deleted);
  assert.equal(deleted.serialNo, "DEV-DEL");
  assert.equal(deleted.deleted, true);
  assert.deepEqual(monitor.listDevices(), []);
  assert.equal(monitor.getDeviceHistory("DEV-DEL", { limit: 10, page: 1 }), null);

  monitor.stop();
});

test("deleteDevice returns null for unknown device", () => {
  const monitor = createMonitorServer({
    port: 0,
    mqttPort: 0,
    mqttTopic: "devices/telemetry",
    mqttUsername: "",
    mqttPassword: "",
    dbPath: ":memory:",
    mqttDisabled: true,
  });

  assert.equal(monitor.deleteDevice("DEV-NOPE"), null);

  monitor.stop();
});

test("messages api style filters can be derived from dashboard snapshot", () => {
  const monitor = createMonitorServer({
    port: 0,
    mqttPort: 0,
    mqttTopic: "devices/telemetry",
    mqttUsername: "",
    mqttPassword: "",
    dbPath: ":memory:",
    mqttDisabled: true,
  });

  monitor.processIncomingPayload(
    "devices/telemetry",
    JSON.stringify({
      serialNo: "DEV-AAA",
      pressure: 1.5,
      temperature: 55,
      alarmType: "leak",
    })
  );

  monitor.processIncomingPayload(
    "devices/telemetry",
    JSON.stringify({
      serialNo: "DEV-BBB",
      pressure: 1.1,
      temperature: 33,
      alarmType: "normal",
    })
  );

  const snapshot = monitor.getDashboardSnapshot();
  const alertDevices = snapshot.devices.filter((item) => item.isAlert);
  const leakMessages = snapshot.recentMessages.filter((item) => item.alarmType === "leak");

  assert.equal(alertDevices.length, 1);
  assert.equal(alertDevices[0].serialNo, "DEV-AAA");
  assert.equal(leakMessages.length, 1);
  assert.equal(leakMessages[0].serialNo, "DEV-AAA");

  monitor.stop();
});
