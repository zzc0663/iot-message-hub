const {
  ALARM_LABELS,
  buildDemoDevices,
  buildDemoMessages,
  escapeHtml,
  fetchJson,
  formatDateTimeInputValue,
  formatMetric,
  formatTimestamp,
  getSerialNoFromUrl,
  isDemoMode,
} = window.IotMonitorShared;

const streamStatusEl = document.querySelector("#stream-status");
const lastUpdatedEl = document.querySelector("#last-updated");
const devicePageSubtitleEl = document.querySelector("#device-page-subtitle");
const deviceSummaryEl = document.querySelector("#device-summary");
const historyListEl = document.querySelector("#history-list");
const historyPagerTextEl = document.querySelector("#history-pager-text");
const prevHistoryPageEl = document.querySelector("#prev-history-page");
const nextHistoryPageEl = document.querySelector("#next-history-page");
const historyAlarmFilterEl = document.querySelector("#history-alarm-filter");
const historyStartAtEl = document.querySelector("#history-start-at");
const historyEndAtEl = document.querySelector("#history-end-at");
const applyHistoryFiltersEl = document.querySelector("#apply-history-filters");
const resetHistoryFiltersEl = document.querySelector("#reset-history-filters");

const serialNo = getSerialNoFromUrl();
let currentDevice = null;
let historyPage = 1;
let historyTotalPages = 1;

function renderDeviceSummary(device) {
  if (!device) {
    deviceSummaryEl.innerHTML = `<div class="message-empty">没有找到对应设备</div>`;
    return;
  }

  const alarmClass = device.isAlert ? "alert" : "normal";
  deviceSummaryEl.innerHTML = `
    <section class="detail-card">
      <div class="detail-topline">
        <div>
          <p class="detail-label">设备序列号</p>
          <h3>${escapeHtml(device.serialNo)}</h3>
        </div>
        <span class="alarm-chip ${alarmClass}">${escapeHtml(device.alarmLabel)}</span>
      </div>
      <div class="detail-meta two-column">
        <span><strong>当前状态：</strong>${escapeHtml(device.statusLabel)}</span>
        <span><strong>压力：</strong>${escapeHtml(formatMetric(device.pressure, "bar"))}</span>
        <span><strong>温度：</strong>${escapeHtml(formatMetric(device.temperature, "°C"))}</span>
        <span><strong>更新时间：</strong>${escapeHtml(formatTimestamp(device.updatedAt))}</span>
      </div>
    </section>
  `;
}

function renderHistory(items) {
  if (!items.length) {
    historyListEl.innerHTML = `<div class="message-empty">当前筛选条件下没有历史消息</div>`;
    return;
  }

  historyListEl.innerHTML = items
    .map((message) => {
      const alarmClass = message.isAlert ? "alert" : "normal";
      return `
        <article class="message-card ${message.isAlert ? "alert" : ""}">
          <div class="message-topline">
            <span class="message-time">${escapeHtml(formatTimestamp(message.updatedAt || message.receivedAt))}</span>
            <span class="alarm-chip ${alarmClass}">${escapeHtml(message.alarmLabel)}</span>
          </div>
          <div class="message-metrics">
            <span>压力 ${escapeHtml(formatMetric(message.pressure, "bar"))}</span>
            <span>温度 ${escapeHtml(formatMetric(message.temperature, "°C"))}</span>
          </div>
          <div class="message-metrics">
            <span>接收时间 ${escapeHtml(formatTimestamp(message.receivedAt))}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function getHistoryQuery() {
  const params = new URLSearchParams();
  params.set("page", String(historyPage));
  params.set("limit", "8");
  if (historyAlarmFilterEl.value) {
    params.set("alarmType", historyAlarmFilterEl.value);
  }
  if (historyStartAtEl.value) {
    params.set("startAt", historyStartAtEl.value);
  }
  if (historyEndAtEl.value) {
    params.set("endAt", historyEndAtEl.value);
  }
  return params.toString();
}

async function loadDeviceDetail() {
  if (!serialNo) {
    devicePageSubtitleEl.textContent = "URL 缺少设备序列号";
    deviceSummaryEl.innerHTML = `<div class="message-empty">请从主页或设备管理页点击设备进入详情页</div>`;
    return;
  }

  if (isDemoMode()) {
    streamStatusEl.textContent = "演示模式";
    const device = buildDemoDevices().find((item) => item.serialNo === serialNo) || null;
    currentDevice = device;
    devicePageSubtitleEl.textContent = device ? `当前查看 ${device.serialNo} 的历史消息` : "没有找到设备";
    renderDeviceSummary(device);
    const allMessages = buildDemoMessages(serialNo);
    const alarmFilter = historyAlarmFilterEl.value;
    const filteredMessages = allMessages.filter((message) => !alarmFilter || message.alarmType === alarmFilter);
    historyTotalPages = Math.max(1, Math.ceil(filteredMessages.length / 8));
    historyPage = Math.min(historyPage, historyTotalPages);
    const pageItems = filteredMessages.slice((historyPage - 1) * 8, historyPage * 8);
    renderHistory(pageItems);
    historyPagerTextEl.textContent = `当前第 ${historyPage} 页，共 ${historyTotalPages} 页`;
    prevHistoryPageEl.disabled = historyPage <= 1;
    nextHistoryPageEl.disabled = historyPage >= historyTotalPages;
    lastUpdatedEl.textContent = `最近更新：${formatTimestamp(device?.updatedAt || new Date().toISOString())}`;
    return;
  }

  streamStatusEl.textContent = "加载中";
  const payload = await fetchJson(`/api/devices/${encodeURIComponent(serialNo)}/history?${getHistoryQuery()}`);
  currentDevice = payload.device || null;
  renderDeviceSummary(currentDevice);
  renderHistory(payload.items || []);
  devicePageSubtitleEl.textContent = currentDevice ? `当前查看 ${currentDevice.serialNo} 的历史消息` : "没有找到设备";
  historyTotalPages = payload.totalPages || 1;
  historyPage = payload.page || 1;
  historyPagerTextEl.textContent = `当前第 ${historyPage} 页，共 ${historyTotalPages} 页`;
  prevHistoryPageEl.disabled = historyPage <= 1;
  nextHistoryPageEl.disabled = historyPage >= historyTotalPages;
  lastUpdatedEl.textContent = `最近更新：${formatTimestamp(currentDevice?.updatedAt || new Date().toISOString())}`;
  streamStatusEl.textContent = "已连接";
}

applyHistoryFiltersEl.addEventListener("click", async () => {
  historyPage = 1;
  await loadDeviceDetail().catch((error) => {
    console.error(error);
  });
});

resetHistoryFiltersEl.addEventListener("click", async () => {
  historyAlarmFilterEl.value = "";
  historyStartAtEl.value = "";
  historyEndAtEl.value = "";
  historyPage = 1;
  await loadDeviceDetail().catch((error) => {
    console.error(error);
  });
});

prevHistoryPageEl.addEventListener("click", async () => {
  historyPage = Math.max(1, historyPage - 1);
  await loadDeviceDetail().catch((error) => {
    console.error(error);
  });
});

nextHistoryPageEl.addEventListener("click", async () => {
  historyPage = Math.min(historyTotalPages, historyPage + 1);
  await loadDeviceDetail().catch((error) => {
    console.error(error);
  });
});

loadDeviceDetail().catch((error) => {
  console.error(error);
  streamStatusEl.textContent = "加载失败";
  deviceSummaryEl.innerHTML = `<div class="message-empty">设备详情加载失败</div>`;
  historyListEl.innerHTML = `<div class="message-empty">历史消息加载失败</div>`;
});
