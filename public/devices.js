const {
  buildDemoDevices,
  escapeHtml,
  fetchJson,
  formatMetric,
  formatRelativeTime,
  formatTimestamp,
  isDemoMode,
} = window.IotMonitorShared;

const managementTableBody = document.querySelector("#management-table-body");
const statTotalDevicesEl = document.querySelector("#stat-total-devices");
const statOnlineDevicesEl = document.querySelector("#stat-online-devices");
const statAlertDevicesEl = document.querySelector("#stat-alert-devices");
const lastUpdatedEl = document.querySelector("#last-updated");
const deviceSearchInputEl = document.querySelector("#device-search-input");

const devices = new Map();
let searchKeyword = "";

function renderStats() {
  const items = Array.from(devices.values());
  statTotalDevicesEl.textContent = String(items.length);
  statOnlineDevicesEl.textContent = String(items.filter((item) => item.status === "online").length);
  statAlertDevicesEl.textContent = String(items.filter((item) => item.isAlert).length);
}

function renderTable() {
  const items = Array.from(devices.values())
    .filter((device) => !searchKeyword || device.serialNo.toLowerCase().includes(searchKeyword.toLowerCase()))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  if (!items.length) {
    managementTableBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="7">当前没有可管理设备</td>
      </tr>
    `;
    return;
  }

  managementTableBody.innerHTML = items
    .map((item) => {
      const alarmClass = item.isAlert ? "alert" : "normal";
      const detailUrl = `./device.html?serialNo=${encodeURIComponent(item.serialNo)}${isDemoMode() ? "&demo=1" : ""}`;
      return `
        <tr class="${item.isAlert ? "row-alert" : ""}">
          <td class="device-id"><a class="device-link-anchor" href="${detailUrl}">${escapeHtml(item.serialNo)}</a></td>
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
          <td>
            <button class="action-button danger" type="button" data-delete-serial="${escapeHtml(item.serialNo)}">删除设备</button>
          </td>
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

async function loadDevices() {
  if (isDemoMode()) {
    applyDevices(buildDemoDevices());
    return;
  }

  const payload = await fetchJson("/api/devices");
  applyDevices(payload.items || []);
}

deviceSearchInputEl.addEventListener("input", (event) => {
  searchKeyword = String(event.target.value || "").trim();
  renderTable();
});

managementTableBody.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-serial]");
  if (!button) {
    return;
  }

  const serialNo = button.dataset.deleteSerial || "";
  if (!serialNo) {
    return;
  }

  if (!window.confirm(`确认删除设备 ${serialNo} 吗？删除后它会从监控主页和管理页移除。`)) {
    return;
  }

  if (isDemoMode()) {
    devices.delete(serialNo);
    renderStats();
    renderTable();
    lastUpdatedEl.textContent = `最近更新：${formatTimestamp(new Date().toISOString())}`;
    return;
  }

  button.disabled = true;

  try {
    await fetchJson(`/api/devices/${encodeURIComponent(serialNo)}`, {
      method: "DELETE",
    });
    devices.delete(serialNo);
    renderStats();
    renderTable();
    lastUpdatedEl.textContent = `最近更新：${formatTimestamp(new Date().toISOString())}`;
  } catch (error) {
    console.error(error);
    window.alert(`删除设备 ${serialNo} 失败，请稍后重试。`);
    button.disabled = false;
  }
});

loadDevices().catch((error) => {
  console.error(error);
  lastUpdatedEl.textContent = "设备列表加载失败";
});
