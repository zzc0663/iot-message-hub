const streamStatusEl = document.querySelector("#stream-status");
const lastUpdatedEl = document.querySelector("#last-updated");
const deviceTableBody = document.querySelector("#device-table-body");
const recentMessageListEl = document.querySelector("#recent-message-list");
const filterBarEl = document.querySelector("#alarm-filters");

const statEls = {
  totalDevices: document.querySelector("#stat-total-devices"),
  onlineDevices: document.querySelector("#stat-online-devices"),
  offlineDevices: document.querySelector("#stat-offline-devices"),
  alertDevices: document.querySelector("#stat-alert-devices"),
  totalMessages: document.querySelector("#stat-total-messages"),
};

const devices = new Map();
let recentMessages = [];
let currentFilter = "all";
let stats = {
  totalDevices: 0,
  onlineDevices: 0,
  offlineDevices: 0,
  alertDevices: 0,
  totalMessages: 0,
};

const isDemoMode = new URLSearchParams(window.location.search).get("demo") === "1";

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
    return value;
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

function rebuildStatsFromState() {
  const items = Array.from(devices.values());
  const onlineDevices = items.filter((device) => device.status === "online").length;
  const alertDevices = items.filter((device) => device.isAlert).length;

  stats = {
    totalDevices: items.length,
    onlineDevices,
    offlineDevices: items.length - onlineDevices,
    alertDevices,
    totalMessages: recentMessages.length,
  };
}

function renderStats() {
  statEls.totalDevices.textContent = String(stats.totalDevices || 0);
  statEls.onlineDevices.textContent = String(stats.onlineDevices || 0);
  statEls.offlineDevices.textContent = String(stats.offlineDevices || 0);
  statEls.alertDevices.textContent = String(stats.alertDevices || 0);
  statEls.totalMessages.textContent = String(stats.totalMessages || 0);
}

function matchesFilter(device) {
  switch (currentFilter) {
    case "alerts":
      return device.isAlert;
    case "offline":
      return device.status === "offline";
    case "normal":
      return device.alarmType === "normal";
    case "leak":
    case "overtemp":
    case "burst":
      return device.alarmType === currentFilter;
    default:
      return true;
  }
}

function renderTable() {
  const items = Array.from(devices.values())
    .filter(matchesFilter)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  if (!items.length) {
    deviceTableBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="6">当前筛选条件下没有设备数据</td>
      </tr>
    `;
    return;
  }

  deviceTableBody.innerHTML = items
    .map((item) => {
      const alarmClass = item.alarmType === "normal" ? "normal" : "alert";
      const rowClasses = [
        item.isAlert ? "row-alert" : "",
        item.status === "offline" ? "row-offline" : "",
      ]
        .filter(Boolean)
        .join(" ");

      return `
        <tr class="${rowClasses}">
          <td class="device-id">${escapeHtml(item.serialNo)}</td>
          <td>
            <div class="status-stack">
              <span class="status-chip ${escapeHtml(item.status)}">${escapeHtml(item.statusLabel)}</span>
              <span class="status-subtext">${escapeHtml(formatRelativeTime(item.lastSeenSeconds))}</span>
            </div>
          </td>
          <td class="metric">${escapeHtml(formatMetric(item.pressure, "bar"))}</td>
          <td class="metric">${escapeHtml(formatMetric(item.temperature, "°C"))}</td>
          <td><span class="alarm-chip ${alarmClass}">${escapeHtml(item.alarmLabel)}</span></td>
          <td>
            <div class="status-stack">
              <span>${escapeHtml(formatTimestamp(item.updatedAt))}</span>
              <span class="time-subtext">${escapeHtml(formatTimestamp(item.lastReceivedAt))}</span>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderRecentMessages() {
  if (!recentMessages.length) {
    recentMessageListEl.innerHTML = `<div class="message-empty">当前还没有消息记录</div>`;
    return;
  }

  recentMessageListEl.innerHTML = recentMessages
    .map((message) => {
      const alarmClass = message.isAlert ? "alert" : "normal";
      return `
        <article class="message-card ${message.isAlert ? "alert" : ""}">
          <div class="message-topline">
            <span class="message-serial">${escapeHtml(message.serialNo)}</span>
            <span class="message-time">${escapeHtml(formatTimestamp(message.updatedAt || message.receivedAt))}</span>
          </div>
          <span class="alarm-chip ${alarmClass}">${escapeHtml(message.alarmLabel)}</span>
          <div class="message-metrics">
            <span>压力 ${escapeHtml(formatMetric(message.pressure, "bar"))}</span>
            <span>温度 ${escapeHtml(formatMetric(message.temperature, "°C"))}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function setFilter(nextFilter) {
  currentFilter = nextFilter;
  filterBarEl.querySelectorAll(".filter-chip").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === nextFilter);
  });
  renderTable();
}

function upsertRecentMessage(message) {
  if (!message) {
    return;
  }

  recentMessages = [message, ...recentMessages.filter((item) => item.id !== message.id)].slice(0, 12);
}

function applyDashboard(payload) {
  devices.clear();
  payload.devices.forEach((device) => {
    devices.set(device.serialNo, device);
  });

  recentMessages = payload.recentMessages || [];
  stats = payload.stats || stats;

  renderStats();
  renderTable();
  renderRecentMessages();

  if (payload.stats?.updatedAt) {
    lastUpdatedEl.textContent = `最近更新：${formatTimestamp(payload.stats.updatedAt)}`;
  } else if (payload.devices[0]) {
    lastUpdatedEl.textContent = `最近更新：${formatTimestamp(payload.devices[0].updatedAt)}`;
  }
}

function upsertDevice(device, incomingMessage, incomingStats) {
  devices.set(device.serialNo, device);

  if (incomingStats) {
    stats = incomingStats;
  } else {
    rebuildStatsFromState();
  }

  upsertRecentMessage(incomingMessage);
  renderStats();
  renderTable();
  renderRecentMessages();
  lastUpdatedEl.textContent = `最近更新：${formatTimestamp(device.updatedAt)}`;
}

function buildDemoDevice(serialNo, pressure, temperature, alarmType) {
  const updatedAt = new Date().toISOString();
  const alarmLabels = {
    normal: "运行正常",
    leak: "泄露报警",
    overtemp: "超温报警",
    burst: "爆管报警",
  };

  return {
    serialNo,
    pressure,
    temperature,
    alarmType,
    alarmLabel: alarmLabels[alarmType],
    updatedAt,
    lastReceivedAt: updatedAt,
    status: "online",
    statusLabel: "在线",
    isAlert: alarmType !== "normal",
    lastSeenSeconds: 0,
  };
}

function buildDemoMessage(device) {
  return {
    id: `demo-${device.serialNo}-${device.updatedAt}`,
    serialNo: device.serialNo,
    pressure: device.pressure,
    temperature: device.temperature,
    alarmType: device.alarmType,
    alarmLabel: device.alarmLabel,
    updatedAt: device.updatedAt,
    receivedAt: device.lastReceivedAt,
    isAlert: device.isAlert,
  };
}

function startDemoMode() {
  streamStatusEl.textContent = "演示模式";

  [
    buildDemoDevice("DEV-001", 1.25, 36.8, "normal"),
    buildDemoDevice("DEV-002", 1.92, 48.1, "leak"),
    buildDemoDevice("DEV-003", 2.31, 76.4, "overtemp"),
    buildDemoDevice("DEV-004", 2.88, 62.5, "burst"),
  ].forEach((device) => {
    devices.set(device.serialNo, device);
    upsertRecentMessage(buildDemoMessage(device));
  });

  rebuildStatsFromState();
  renderStats();
  renderTable();
  renderRecentMessages();
  lastUpdatedEl.textContent = `最近更新：${formatTimestamp(new Date().toISOString())}`;

  const serialNumbers = ["DEV-001", "DEV-002", "DEV-003", "DEV-004"];
  const alarmTypes = ["normal", "leak", "overtemp", "burst"];

  setInterval(() => {
    const serialNo = serialNumbers[Math.floor(Math.random() * serialNumbers.length)];
    const alarmType = alarmTypes[Math.floor(Math.random() * alarmTypes.length)];
    const pressure = Number((1 + Math.random() * 2.2).toFixed(2));
    const temperature = Number((28 + Math.random() * 60).toFixed(1));
    const device = buildDemoDevice(serialNo, pressure, temperature, alarmType);

    devices.set(device.serialNo, device);
    upsertRecentMessage(buildDemoMessage(device));
    rebuildStatsFromState();
    renderStats();
    renderTable();
    renderRecentMessages();
    lastUpdatedEl.textContent = `最近更新：${formatTimestamp(device.updatedAt)}`;
  }, 2200);
}

async function loadDashboard() {
  const response = await fetch("/api/dashboard");
  if (!response.ok) {
    throw new Error(`Failed to load dashboard: ${response.status}`);
  }

  const payload = await response.json();
  applyDashboard(payload);
}

function connectStream() {
  const source = new EventSource("/api/stream");

  source.onopen = () => {
    streamStatusEl.textContent = "已连接";
  };

  source.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "device_update" && payload.device) {
      upsertDevice(payload.device, payload.message, payload.stats);
    } else if (payload.type === "snapshot") {
      applyDashboard(payload);
    }
  };

  source.onerror = () => {
    streamStatusEl.textContent = "重连中";
  };
}

function bindFilters() {
  filterBarEl.addEventListener("click", (event) => {
    const button = event.target.closest(".filter-chip");
    if (!button) {
      return;
    }

    setFilter(button.dataset.filter);
  });
}

async function bootstrap() {
  bindFilters();

  if (isDemoMode) {
    startDemoMode();
    return;
  }

  try {
    await loadDashboard();
    connectStream();
  } catch (error) {
    console.error(error);
    streamStatusEl.textContent = "加载失败";
    lastUpdatedEl.textContent = "初始数据加载失败，请检查服务状态";
  }
}

bootstrap();
