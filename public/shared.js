(function sharedBootstrap(global) {
  const ALARM_LABELS = {
    normal: "运行正常",
    leak: "泄露报警",
    overtemp: "超温报警",
    burst: "爆管报警",
  };

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatMetric(value, suffix) {
    return `${Number(value).toFixed(2)} ${suffix}`;
  }

  function formatTimestamp(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value || "-";
    }

    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);
  }

  function formatDateTimeInputValue(value) {
    if (!value) {
      return "";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "";
    }

    const pad = (part) => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function formatRelativeTime(seconds) {
    if (!Number.isFinite(seconds)) {
      return "时间未知";
    }

    if (seconds < 10) {
      return "刚刚上报";
    }

    if (seconds < 60) {
      return `${seconds} 秒前上报`;
    }

    if (seconds < 3600) {
      return `${Math.floor(seconds / 60)} 分钟前上报`;
    }

    return `${Math.floor(seconds / 3600)} 小时前上报`;
  }

  function isDemoMode() {
    return new URLSearchParams(window.location.search).get("demo") === "1";
  }

  function getSerialNoFromUrl() {
    return new URLSearchParams(window.location.search).get("serialNo") || "";
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }

    return response.json();
  }

  function buildDemoDevices() {
    const now = new Date().toISOString();
    return [
      { serialNo: "DEV-001", pressure: 1.25, temperature: 36.8, alarmType: "normal", updatedAt: now, lastReceivedAt: now, status: "online", statusLabel: "在线", alarmLabel: ALARM_LABELS.normal, isAlert: false, lastSeenSeconds: 0 },
      { serialNo: "DEV-002", pressure: 1.92, temperature: 48.1, alarmType: "leak", updatedAt: now, lastReceivedAt: now, status: "online", statusLabel: "在线", alarmLabel: ALARM_LABELS.leak, isAlert: true, lastSeenSeconds: 0 },
      { serialNo: "DEV-003", pressure: 2.31, temperature: 76.4, alarmType: "overtemp", updatedAt: now, lastReceivedAt: now, status: "online", statusLabel: "在线", alarmLabel: ALARM_LABELS.overtemp, isAlert: true, lastSeenSeconds: 0 },
      { serialNo: "DEV-004", pressure: 2.88, temperature: 62.5, alarmType: "burst", updatedAt: now, lastReceivedAt: now, status: "online", statusLabel: "在线", alarmLabel: ALARM_LABELS.burst, isAlert: true, lastSeenSeconds: 0 },
    ];
  }

  function buildDemoMessages(serialNo) {
    const baseTime = Date.now();
    const types = ["normal", "leak", "overtemp", "burst"];
    return Array.from({ length: 12 }, (_, index) => {
      const alarmType = types[(index + serialNo.length) % types.length];
      const updatedAt = new Date(baseTime - index * 1000 * 60 * 4).toISOString();
      return {
        id: `${serialNo}-${index + 1}`,
        serialNo,
        topic: "devices/telemetry",
        pressure: Number((1.1 + index * 0.08).toFixed(2)),
        temperature: Number((32 + index * 2.4).toFixed(1)),
        alarmType,
        alarmLabel: ALARM_LABELS[alarmType],
        updatedAt,
        receivedAt: updatedAt,
        isAlert: alarmType !== "normal",
      };
    });
  }

  global.IotMonitorShared = {
    ALARM_LABELS,
    buildDemoDevices,
    buildDemoMessages,
    escapeHtml,
    fetchJson,
    formatDateTimeInputValue,
    formatMetric,
    formatRelativeTime,
    formatTimestamp,
    getSerialNoFromUrl,
    isDemoMode,
  };
})(window);
