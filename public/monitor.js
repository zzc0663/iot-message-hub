const {
  escapeHtml,
  fetchJson,
  formatMetric,
  formatRelativeTime,
  formatTimestamp,
  isDemoMode,
  buildDemoDevices,
} = window.IotMonitorShared;

const streamStatusEl = document.querySelector("#stream-status");
const lastUpdatedEl = document.querySelector("#last-updated");
const deviceTableBody = document.querySelector("#device-table-body");
const filterBarEl = document.querySelector("#alarm-filters");
const deviceSearchInputEl = document.querySelector("#device-search-input");
const statTotalDevicesEl = document.querySelector("#stat-total-devices");
const statAlertDevicesEl = document.querySelector("#stat-alert-devices");

const devices = new Map();
let currentFilter = "all";
let searchKeyword = "";

function matchesFilter(device) {
  if (currentFilter === "all") {
    return true;
  }
  if (currentFilter === "alerts") {
    return device.isAlert;
  }
  if (currentFilter === "offline") {
    return device.status === "offline";
  }
  return device.alarmType === currentFilter;
}

function matchesSearch(device) {
  if (!searchKeyword) {
    return true;
  }
  return device.serialNo.toLowerCase().includes(searchKeyword.toLowerCase());
}

function renderStats() {
  const items = Array.from(devices.values());
  statTotalDevicesEl.textContent = String(items.length);
  statAlertDevicesEl.textContent = String(items.filter((item) => item.isAlert).length);
}

function renderTable() {
  const items = Array.from(devices.values())
    .filter((device) => matchesFilter(device) && matchesSearch(device))
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
      const rowClasses = [item.isAlert ? "row-alert" : "", item.status === "offline" ? "row-offline" : ""]
        .filter(Boolean)
        .join(" ");
      const alarmClass = item.isAlert ? "alert" : "normal";
      const detailUrl = `./device.html?serialNo=${encodeURIComponent(item.serialNo)}${isDemoMode() ? "&demo=1" : ""}`;
      return `
        <tr class="${rowClasses}">
          <td class="device-id">
            <a class="device-link-anchor" href="${detailUrl}">${escapeHtml(item.serialNo)}</a>
          </td>
          <td>
            <div class="status-stack">
              <span class="status-chip ${escapeHtml(item.status)}">${escapeHtml(item.statusLabel)}</span>
              <span class="status-subtext">${escapeHtml(formatRelativeTime(item.lastSeenSeconds))}</span>
            </div>
          </td>
          <td class="metric">${escapeHtml(formatMetric(item.pressure, "bar"))}</td>
          <td class="metric">${escapeHtml(formatMetric(item.temperature, "°C"))}</td>
          <td><span class="alarm-chip ${alarmClass}">${escapeHtml(item.alarmLabel)}</span></td>
          <td>${escapeHtml(formatTimestamp(item.updatedAt))}</td>
        </tr>
      `;
    })
    .join("");
}

function applyDevices(items) {
  devices.clear();
  items.forEach((device) => {
    devices.set(device.serialNo, device);
  });
  renderStats();
  renderTable();
  lastUpdatedEl.textContent = `最近更新：${formatTimestamp(new Date().toISOString())}`;
}

async function loadMonitor() {
  if (isDemoMode()) {
    streamStatusEl.textContent = "演示模式";
    applyDevices(buildDemoDevices());
    return;
  }

  const payload = await fetchJson("/api/devices");
  applyDevices(payload.items || []);

  const source = new EventSource("/api/stream");
  source.onopen = () => {
    streamStatusEl.textContent = "已连接";
  };
  source.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "device_update" && payload.device) {
      devices.set(payload.device.serialNo, payload.device);
      renderStats();
      renderTable();
      lastUpdatedEl.textContent = `最近更新：${formatTimestamp(payload.device.updatedAt)}`;
    }
    if (payload.type === "device_deleted" && payload.serialNo) {
      devices.delete(payload.serialNo);
      renderStats();
      renderTable();
      lastUpdatedEl.textContent = `最近更新：${formatTimestamp(new Date().toISOString())}`;
    }
    if (payload.type === "snapshot" && Array.isArray(payload.devices)) {
      applyDevices(payload.devices);
    }
  };
  source.onerror = () => {
    streamStatusEl.textContent = "重连中";
  };
}

filterBarEl.addEventListener("click", (event) => {
  const button = event.target.closest(".filter-chip");
  if (!button) {
    return;
  }
  currentFilter = button.dataset.filter || "all";
  filterBarEl.querySelectorAll(".filter-chip").forEach((item) => {
    item.classList.toggle("active", item === button);
  });
  renderTable();
});

deviceSearchInputEl.addEventListener("input", (event) => {
  searchKeyword = String(event.target.value || "").trim();
  renderTable();
});

loadMonitor().catch((error) => {
  console.error(error);
  streamStatusEl.textContent = "加载失败";
  lastUpdatedEl.textContent = "设备数据加载失败";
});
