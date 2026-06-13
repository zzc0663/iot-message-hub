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
