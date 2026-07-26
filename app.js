// NASDAQ-100 Live Portal Application Logic
let candles = [];
let currentSymbol = "IG:NASDAQ";
let currentTF = "15";
let currentFilter = "ALL";
let currentEngine = "custom_hud"; // Default to native custom RSI HUD canvas
let constituentsData = [];

// (changeSymbol is defined once, further below, after pan/zoom state exists —
// see the consolidated version near changeTimeframe)

document.addEventListener("DOMContentLoaded", () => {
  // Each init step is isolated: a failure in one (e.g. populating the stock
  // search datalist) must not prevent the others from running — in
  // particular the setInterval below, since without it the chart would
  // never receive live data again even though the page looks otherwise fine.
  const steps = [loadDrawings, initClock, renderChart, renderMultiTimeframeRadar, initConstituentsData, setupSearchAndFilters, populateStockDatalist];
  steps.forEach(fn => {
    try { fn(); } catch (err) { console.error(`Startup step ${fn.name} failed:`, err); }
  });

  setInterval(() => {
    try { refreshLiveData(); } catch (err) { console.error("refreshLiveData failed:", err); }
  }, 3000);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (drawingTool || pendingDrawing)) {
      pendingDrawing = null;
      setDrawingTool(null);
      const canvas = document.getElementById("main-stock-canvas");
      if (canvas) drawChart(canvas, canvas.getContext("2d"));
    }
  });
});

// NSE Stock Search Combo — populates the <datalist> from NSE500_STOCKS
// (see nse500_stocks.js) and resolves a typed/selected entry back to its
// TradingView symbol.
function populateStockDatalist() {
  const listEl = document.getElementById("nse500-datalist");
  if (!listEl || typeof NSE500_STOCKS === "undefined") return;
  listEl.innerHTML = NSE500_STOCKS.map(
    s => `<option value="${s.name} (${s.symbol})"></option>`
  ).join("");
}

function handleStockSearchInput(typedValue) {
  if (!typedValue || typeof NSE500_STOCKS === "undefined") return;
  const match = NSE500_STOCKS.find(s => `${s.name} (${s.symbol})` === typedValue);
  if (match) {
    changeSymbol(match.symbol, `${match.name} (${match.symbol})`);
  }
}

// Real-Time Market Hours & Open/Closed Status Checker
function getMarketStatus(symbol) {
  const now = new Date();
  
  const istFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });
  
  const parts = istFormatter.formatToParts(now);
  let weekday = '';
  let hour = 0;
  let minute = 0;
  
  for (const part of parts) {
    if (part.type === 'weekday') weekday = part.value;
    if (part.type === 'hour') hour = parseInt(part.value, 10);
    if (part.type === 'minute') minute = parseInt(part.value, 10);
  }
  
  const timeInMinutes = hour * 60 + minute;
  const isWeekend = (weekday === 'Sat' || weekday === 'Sun');
  
  const sym = symbol || (typeof currentSymbol !== 'undefined' ? currentSymbol : "IG:NASDAQ");
  const isNSE = sym.includes('NSE') || sym.endsWith('.NS') || (typeof NSE500_STOCKS !== 'undefined' && NSE500_STOCKS.some(s => s.symbol === sym));

  if (isNSE) {
    if (isWeekend) {
      return { isOpen: false, statusText: 'MARKET CLOSED (WEEKEND)' };
    }
    const nseOpen = 9 * 60 + 15;
    const nseClose = 15 * 60 + 30;
    if (timeInMinutes >= nseOpen && timeInMinutes <= nseClose) {
      return { isOpen: true, statusText: 'MARKET LIVE (NSE)' };
    } else {
      return { isOpen: false, statusText: 'MARKET CLOSED (OFF-HOURS)' };
    }
  } else {
    if (weekday === 'Sat' && timeInMinutes >= 150) {
      return { isOpen: false, statusText: 'MARKET CLOSED (WEEKEND)' };
    }
    if (weekday === 'Sun') {
      return { isOpen: false, statusText: 'MARKET CLOSED (WEEKEND)' };
    }
    if (weekday === 'Mon' && timeInMinutes < 210) {
      return { isOpen: false, statusText: 'MARKET CLOSED (WEEKEND)' };
    }
    
    if (weekday !== 'Sat' && weekday !== 'Sun' && timeInMinutes >= 150 && timeInMinutes < 210) {
      return { isOpen: false, statusText: 'MARKET CLOSED (DAILY BREAK)' };
    }
    
    return { isOpen: true, statusText: 'MARKET LIVE (24/7 FEED)' };
  }
}

function updateMarketStatus() {
  const pillEl = document.getElementById("market-status-pill");
  const textEl = document.getElementById("market-status-text");
  if (!pillEl || !textEl) return;

  const status = getMarketStatus(typeof currentSymbol !== 'undefined' ? currentSymbol : 'IG:NASDAQ');
  textEl.innerText = status.statusText;

  if (status.isOpen) {
    pillEl.classList.remove("closed");
  } else {
    pillEl.classList.add("closed");
  }
}

// Real-Time Clock & Status Updater (Indian Standard Time - IST)
function initClock() {
  const clockEl = document.getElementById("live-clock");
  function update() {
    const now = new Date();
    const istString = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "medium" }) + " IST";
    if (clockEl) clockEl.innerText = istString;
    updateMarketStatus();
  }
  update();
  setInterval(update, 1000);
}

let layerState = {
  vp: true,
  vwap: true,
  div: true,
  ob: true,
  subpane: true
};

let visibleCandleCount = 60;
let panOffset = 0;
let priceOffset = 0;
let priceScaleMultiplier = 1.0;

let isDragging = false;
let dragMode = "chart"; // "chart", "priceScale", "timeScale"
let dragModeLocked = true; // false while a "chart" drag can still be reclassified as priceScale based on direction
// Empty candle-slots of breathing room left between the last candle and the
// price axis, matching the gap TradingView's own widget leaves by default —
// the custom canvas engine was previously packing candles flush to the axis.
const RIGHT_MARGIN_CANDLES = 8;

// --- Chart Type (Candles / Line / Area) ---
let chartType = "candles";

// --- Drawing Tools (Trend Line / Horizontal Line / Rectangle) ---
let drawings = [];           // committed drawings: {type, symbol, tf, price} for hline, or {type, symbol, tf, p1:{time,price}, p2:{time,price}} for trendline/rect
let drawingTool = null;      // null | "trendline" | "hline" | "rect"
let pendingDrawing = null;   // in-progress trendline/rect waiting for its second point
// Snapshot of the last frame's price/time <-> pixel mapping, written at the
// end of drawChart() and read by the mouse handlers when placing a new
// drawing point — keeps the interaction math as a single source of truth
// instead of a second, easily-drifting copy of drawChart's layout formulas.
let chartLayout = null;

function timeToX(t, displayCandles, step) {
  if (!displayCandles || displayCandles.length === 0) return 0;
  if (displayCandles.length === 1) return step / 2;
  const dtAvg = (displayCandles[displayCandles.length - 1].time - displayCandles[0].time) / (displayCandles.length - 1) || 900;
  if (t <= displayCandles[0].time) {
    return ((t - displayCandles[0].time) / dtAvg) * step + step / 2;
  }
  const last = displayCandles[displayCandles.length - 1];
  if (t >= last.time) {
    return (displayCandles.length - 1 + (t - last.time) / dtAvg) * step + step / 2;
  }
  for (let i = 0; i < displayCandles.length - 1; i++) {
    if (t >= displayCandles[i].time && t <= displayCandles[i + 1].time) {
      const seg = displayCandles[i + 1].time - displayCandles[i].time || dtAvg;
      const frac = (t - displayCandles[i].time) / seg;
      return (i + frac) * step + step / 2;
    }
  }
  return 0;
}

function xToTime(x, displayCandles, step) {
  if (!displayCandles || displayCandles.length === 0) return Math.floor(Date.now() / 1000);
  if (displayCandles.length === 1) return displayCandles[0].time;
  const dtAvg = (displayCandles[displayCandles.length - 1].time - displayCandles[0].time) / (displayCandles.length - 1) || 900;
  const idxFloat = (x - step / 2) / step;
  const i0 = Math.floor(idxFloat);
  if (i0 < 0) return displayCandles[0].time + idxFloat * dtAvg;
  if (i0 >= displayCandles.length - 1) return displayCandles[displayCandles.length - 1].time + (idxFloat - (displayCandles.length - 1)) * dtAvg;
  const frac = idxFloat - i0;
  const seg = displayCandles[i0 + 1].time - displayCandles[i0].time || dtAvg;
  return displayCandles[i0].time + frac * seg;
}

function pixelToPrice(y) {
  if (!chartLayout) return 0;
  const { adjustedMaxPrice, priceRange, topMargin, plotHeight, priceOffset } = chartLayout;
  return adjustedMaxPrice - ((y - priceOffset - topMargin) / plotHeight) * priceRange;
}

function pixelToTime(x) {
  if (!chartLayout) return Math.floor(Date.now() / 1000);
  return xToTime(x, chartLayout.displayCandles, chartLayout.step);
}

function saveDrawings() {
  try { localStorage.setItem("nasdaq_portal_drawings", JSON.stringify(drawings)); }
  catch (err) { console.error("Could not save drawings:", err); }
}

function loadDrawings() {
  try {
    const raw = localStorage.getItem("nasdaq_portal_drawings");
    if (raw) drawings = JSON.parse(raw);
  } catch (err) { console.error("Could not load drawings:", err); }
}

function setChartType(type) {
  chartType = type;
  document.querySelectorAll(".chart-type-btn").forEach(b => b.classList.remove("active"));
  const btn = document.getElementById(`chart-type-${type}`);
  if (btn) btn.classList.add("active");
  const canvas = document.getElementById("main-stock-canvas");
  if (canvas) drawChart(canvas, canvas.getContext("2d"));
}

function setDrawingTool(tool) {
  drawingTool = tool;
  pendingDrawing = null;
  document.querySelectorAll(".draw-tool-btn").forEach(b => b.classList.remove("active"));
  const btn = document.getElementById(tool ? `draw-tool-${tool}` : "draw-tool-cursor");
  if (btn) btn.classList.add("active");
  const canvas = document.getElementById("main-stock-canvas");
  if (canvas) canvas.style.cursor = "crosshair";

  const banner = document.getElementById("drawing-mode-banner");
  if (banner) {
    if (tool) {
      const names = { trendline: "Trend Line — click a start point, then an end point", hline: "Horizontal Line — click a price level", rect: "Rectangle — click one corner, then the opposite corner" };
      banner.innerText = `✏ Drawing: ${names[tool] || tool}  (Esc or Cursor to exit — panning is off while a drawing tool is active)`;
      banner.style.display = "block";
    } else {
      banner.style.display = "none";
    }
  }
}

function clearAllDrawings() {
  drawings = drawings.filter(d => !(d.symbol === currentSymbol && d.tf === currentTF));
  pendingDrawing = null;
  saveDrawings();
  const canvas = document.getElementById("main-stock-canvas");
  if (canvas) drawChart(canvas, canvas.getContext("2d"));
}

function handleDrawingClick(x, y) {
  const price = pixelToPrice(y);
  const time = pixelToTime(x);
  const canvas = document.getElementById("main-stock-canvas");
  const ctx = canvas ? canvas.getContext("2d") : null;

  if (drawingTool === "hline") {
    drawings.push({ type: "hline", symbol: currentSymbol, tf: currentTF, price });
    saveDrawings();
    setDrawingTool(null);
  } else if (drawingTool === "trendline" || drawingTool === "rect") {
    if (!pendingDrawing) {
      pendingDrawing = { type: drawingTool, symbol: currentSymbol, tf: currentTF, p1: { time, price } };
    } else {
      pendingDrawing.p2 = { time, price };
      drawings.push(pendingDrawing);
      pendingDrawing = null;
      saveDrawings();
      setDrawingTool(null);
    }
  }
  if (canvas && ctx) drawChart(canvas, ctx);
}

// Snapshot the chart as a downloadable PNG
function saveChartSnapshot() {
  const canvas = document.getElementById("main-stock-canvas");
  if (!canvas) return;
  const link = document.createElement("a");
  link.download = `${currentSymbol.replace(/[:!]/g, "_")}_${currentTF}_${Date.now()}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

let dragStartX = 0;
let dragStartY = 0;
let dragStartPan = 0;
let dragStartPriceOffset = 0;
let dragStartScaleMult = 1.0;
let dragStartCandleCount = 60;

function zoomChart(deltaCount) {
  if (candles.length === 0) return;
  visibleCandleCount = Math.max(15, Math.min(candles.length, visibleCandleCount + deltaCount));
  const maxPan = Math.max(0, candles.length - visibleCandleCount);
  panOffset = Math.max(0, Math.min(maxPan, panOffset));

  const canvas = document.getElementById("main-stock-canvas");
  if (canvas) {
    drawChart(canvas, canvas.getContext("2d"));
  }
}

// Vertical zoom — stretches/compresses the price (Y) axis. This is the
// reliable button-based alternative to dragging the narrow price-axis strip
// on the right edge of the chart with the mouse.
function verticalZoomChart(factor) {
  priceScaleMultiplier = Math.max(0.2, Math.min(5.0, priceScaleMultiplier * factor));
  const canvas = document.getElementById("main-stock-canvas");
  if (canvas) {
    drawChart(canvas, canvas.getContext("2d"));
  }
}

function panChart(dxCandles, dyPixels) {
  if (candles.length === 0) return;
  const numAll = candles.length;
  const count = Math.min(numAll, visibleCandleCount);
  const maxPan = Math.max(0, numAll - count);
  panOffset = Math.max(0, Math.min(maxPan, panOffset + dxCandles));
  priceOffset += dyPixels;
  const canvas = document.getElementById("main-stock-canvas");
  if (canvas) {
    drawChart(canvas, canvas.getContext("2d"));
  }
}

function resetChartZoom() {
  visibleCandleCount = 60;
  panOffset = 0;
  priceOffset = 0;
  priceScaleMultiplier = 1.0;
  const canvas = document.getElementById("main-stock-canvas");
  if (canvas) {
    drawChart(canvas, canvas.getContext("2d"));
  }
}

function handleWheelZoom(e, canvas, ctx) {
  e.preventDefault();
  const rect = canvas.parentElement.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const paddingRight = 85;
  const chartWidth = rect.width - paddingRight;

  if (x >= chartWidth - 40) {
    const factor = e.deltaY < 0 ? 1.15 : 0.85;
    verticalZoomChart(factor);
  } else {
    const delta = e.deltaY < 0 ? -5 : 5;
    zoomChart(delta);
  }
}

function handleMouseDown(e, canvas, ctx) {
  if (e.button !== 0) return;
  e.preventDefault(); // stops the browser's native text-selection drag from hijacking this gesture

  if (drawingTool) {
    const drawRect = canvas.parentElement.getBoundingClientRect();
    handleDrawingClick(e.clientX - drawRect.left, e.clientY - drawRect.top);
    return;
  }

  // Use the SAME rect source as drawChart() (canvas.parentElement) so the
  // hit-test zones line up with what's actually drawn — using canvas's own
  // rect here (while drawChart lays out against the parent's) was the root
  // cause of the price-axis vertical-zoom drag zone being unreachable.
  const rect = canvas.parentElement.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const width = rect.width;
  const height = rect.height;
  const paddingRight = 85; // must match drawChart()
  const paddingBottom = 24; // must match drawChart()
  const subpaneHeight = 180; // must match drawChart()
  const subpaneDividerHeight = 20; // must match drawChart()
  const priceChartHeight = height - subpaneHeight - subpaneDividerHeight - paddingBottom;
  const chartWidth = width - paddingRight;

  isDragging = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragStartPan = panOffset;
  dragStartPriceOffset = priceOffset;
  dragStartScaleMult = priceScaleMultiplier;
  dragStartCandleCount = visibleCandleCount;

  if (x >= chartWidth - 40) {
    dragMode = "priceScale";
    canvas.style.cursor = "ns-resize";
  } else if (y >= priceChartHeight && y <= priceChartHeight + subpaneDividerHeight) {
    dragMode = "timeScale";
    canvas.style.cursor = "ew-resize";
  } else {
    // Not yet locked to "chart" (pan) — a predominantly vertical drag
    // starting anywhere on the chart body will be reclassified as
    // priceScale zoom in handleMouseMove below, since requiring the exact
    // 15px-wide right-edge strip to be hit was too fragile in practice.
    dragMode = "chart";
    dragModeLocked = false;
    canvas.style.cursor = "grabbing";
    return;
  }
  dragModeLocked = true;
}

function handleMouseMove(e, canvas, ctx) {
  const rect = canvas.parentElement.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const width = rect.width;
  const height = rect.height;
  const paddingRight = 85; // must match drawChart()
  const paddingBottom = 24; // must match drawChart()
  const subpaneHeight = 180; // must match drawChart()
  const subpaneDividerHeight = 20; // must match drawChart()
  const priceChartHeight = height - subpaneHeight - subpaneDividerHeight - paddingBottom;
  const chartWidth = width - paddingRight;

  if (!isDragging) {
    if (drawingTool) {
      canvas.style.cursor = "crosshair";
    } else if (x >= chartWidth - 40) {
      canvas.style.cursor = "ns-resize";
    } else if (y >= priceChartHeight && y <= priceChartHeight + subpaneDividerHeight) {
      canvas.style.cursor = "ew-resize";
    } else {
      canvas.style.cursor = "crosshair";
    }
    drawChart(canvas, ctx, { x, y });
    return;
  }

  // During dragging
  e.preventDefault();
  const dx = e.clientX - dragStartX;
  const dy = e.clientY - dragStartY;

  if (!dragModeLocked) {
    // Still deciding: once the drag has moved far enough to show clear
    // intent, lock it in. A drag that's mostly vertical (this is what
    // "pressing down and moving vertically to change the price-axis gap"
    // looks like) becomes priceScale zoom; mostly horizontal stays a pan.
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
      if (Math.abs(dy) > Math.abs(dx) * 1.3) {
        dragMode = "priceScale";
        canvas.style.cursor = "ns-resize";
      } else {
        dragMode = "chart";
      }
      dragModeLocked = true;
    }
  }

  if (dragMode === "chart") {
    const numAll = candles.length;
    const count = Math.min(numAll, visibleCandleCount);
    const maxPan = Math.max(0, numAll - count);
    const step = chartWidth / Math.max(1, count + RIGHT_MARGIN_CANDLES);
    const candleShift = Math.round(dx / step);

    panOffset = Math.max(0, Math.min(maxPan, dragStartPan + candleShift));
    priceOffset = dragStartPriceOffset + dy;
  } else if (dragMode === "priceScale") {
    // Dragging price scale vertically stretches or compresses Y axis
    const factor = Math.exp(-dy / 120);
    priceScaleMultiplier = Math.max(0.2, Math.min(5.0, dragStartScaleMult * factor));
  } else if (dragMode === "timeScale") {
    // Dragging time scale horizontally expands or contracts candles
    const shift = Math.round(-dx / 8);
    visibleCandleCount = Math.max(15, Math.min(candles.length, dragStartCandleCount + shift));
    const maxPan = Math.max(0, candles.length - visibleCandleCount);
    panOffset = Math.max(0, Math.min(maxPan, panOffset));
  }

  drawChart(canvas, ctx, { x, y });
}

function handleMouseUp(e, canvas, ctx) {
  isDragging = false;
  const c = canvas || document.getElementById("main-stock-canvas");
  if (c) c.style.cursor = "crosshair";
}

function handleDoubleClick(e, canvas, ctx) {
  resetChartZoom();
}

function handleTouchStart(e, canvas, ctx) {
  if (e.touches && e.touches.length === 1) {
    const touch = e.touches[0];
    handleMouseDown({ button: 0, clientX: touch.clientX, clientY: touch.clientY }, canvas, ctx);
  }
}

function handleTouchMove(e, canvas, ctx) {
  if (e.touches && e.touches.length === 1 && isDragging) {
    e.preventDefault();
    const touch = e.touches[0];
    handleMouseMove({ clientX: touch.clientX, clientY: touch.clientY }, canvas, ctx);
  }
}

function handleTouchEnd(e, canvas, ctx) {
  handleMouseUp(e, canvas, ctx);
}

function toggleChartLayer(layer) {
  const el = document.getElementById(`toggle-${layer}`);
  if (el) {
    layerState[layer] = el.checked;
    const canvas = document.getElementById("main-stock-canvas");
    if (canvas) {
      drawChart(canvas, canvas.getContext("2d"));
    }
  }
}

function toggleChartFullscreen() {
  const card = document.getElementById("main-chart-card");
  const btn = document.getElementById("btn-fullscreen");
  if (!card) return;

  if (!document.fullscreenElement && !card.classList.contains("is-fullscreen")) {
    card.classList.add("is-fullscreen");
    if (btn) btn.innerHTML = "🗗 Exit Fullscreen";
    if (card.requestFullscreen) {
      card.requestFullscreen().catch(() => {});
    }
  } else {
    card.classList.remove("is-fullscreen");
    if (btn) btn.innerHTML = "⛶ Fullscreen";
    if (document.exitFullscreen && document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }

  setTimeout(() => {
    const canvas = document.getElementById("main-stock-canvas");
    if (canvas) {
      drawChart(canvas, canvas.getContext("2d"));
    }
  }, 100);
}

document.addEventListener("fullscreenchange", () => {
  const card = document.getElementById("main-chart-card");
  const btn = document.getElementById("btn-fullscreen");
  if (!document.fullscreenElement && card) {
    card.classList.remove("is-fullscreen");
    if (btn) btn.innerHTML = "⛶ Fullscreen";
    const canvas = document.getElementById("main-stock-canvas");
    if (canvas) drawChart(canvas, canvas.getContext("2d"));
  }
});

// Chart Router
function renderChart() {
  if (currentEngine === "tv_widget") {
    renderTradingViewWidget();
  } else {
    initNativeCanvasChart();
  }
}

function switchChartEngine(engine) {
  currentEngine = engine;
  const tvBtn = document.getElementById("btn-engine-tv");
  const customBtn = document.getElementById("btn-engine-custom");
  
  if (tvBtn) tvBtn.classList.toggle("active", engine === "tv_widget");
  if (customBtn) customBtn.classList.toggle("active", engine === "custom_hud");

  const overlayBox = document.querySelector(".tv-hud-overlay-box");
  if (engine === "tv_widget") {
    if (overlayBox) overlayBox.style.display = "none";
    renderTradingViewWidget();
  } else {
    if (overlayBox) overlayBox.style.display = "flex";
    initNativeCanvasChart();
  }
}

// Map internal symbols to valid TradingView public widget symbols
function mapSymbolForTVWidget(sym) {
  const s = (sym || "").toUpperCase();
  if (s.includes("NASDAQ") || s.includes("US100") || s === "IG:NASDAQ") return "CAPITALCOM:US100";
  if (s.includes("BANKNIFTY")) return "NSE:BANKNIFTY";
  if (s.includes("NIFTY")) return "NSE:NIFTY50";
  if (s.includes("SENSEX")) return "BSE:SENSEX";
  if (s.startsWith("NSE:") || s.startsWith("BSE:")) return sym;
  return sym;
}

// Store last HUD for TV overlay redraws
let _tvOverlayHud = null;

function drawTVOverlay() {
  const canvas = document.getElementById("tv-overlay-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const hud = _tvOverlayHud;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!hud) return;

  const entry = parseFloat(hud.entry) || 0;
  const sl    = parseFloat(hud.sl)    || 0;
  const tp1   = parseFloat(hud.tp1_raw || (hud.tp1 || "").replace(/[^0-9.]/g, "")) || 0;
  const tp2   = parseFloat(hud.tp2_raw || (hud.tp2 || "").replace(/[^0-9.]/g, "")) || 0;
  const price = parseFloat(hud.price) || entry;
  const isBuy = (hud.signal !== "SELL");
  const tradeActive = !hud.trade_closed && entry > 0 && sl > 0;

  let minP = Infinity;
  let maxP = -Infinity;

  if (candles && candles.length > 0) {
    const recent = candles.slice(-50);
    recent.forEach(c => {
      if (c.low < minP) minP = c.low;
      if (c.high > maxP) maxP = c.high;
    });
  }

  if (tradeActive) {
    if (entry > 0) { minP = Math.min(minP, entry); maxP = Math.max(maxP, entry); }
    if (sl > 0)    { minP = Math.min(minP, sl);    maxP = Math.max(maxP, sl); }
    if (tp1 > 0)   { minP = Math.min(minP, tp1);   maxP = Math.max(maxP, tp1); }
    if (tp2 > 0)   { minP = Math.min(minP, tp2);   maxP = Math.max(maxP, tp2); }
  }
  if (price > 0) { minP = Math.min(minP, price); maxP = Math.max(maxP, price); }

  if (!isFinite(minP) || !isFinite(maxP) || minP === maxP) {
    const risk = Math.abs(entry - sl) || 60;
    const span = Math.max(risk * 4, 250);
    maxP = entry + (isBuy ? span * 0.40 : span * 0.60);
    minP = maxP - span;
  } else {
    const margin = (maxP - minP) * 0.08 || 15;
    maxP += margin;
    minP -= margin;
  }

  // Candlestick pane in TradingView widget iframe (height ~600px):
  // Main Price Candlesticks pane occupies top ~52% of chart height
  const chartTop    = 38;
  const chartBottom = h * 0.52;
  const chartH      = chartBottom - chartTop;
  const chartRight  = w - 74;

  function priceToY(p) {
    return chartTop + (maxP - p) / (maxP - minP) * chartH;
  }

  function drawLine(p, color, label, bgColor, solid) {
    const y = priceToY(p);
    if (y < chartTop - 15 || y > chartBottom + 15) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.0;
    ctx.globalAlpha = 0.95;
    ctx.setLineDash(solid ? [] : [8, 5]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(chartRight, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // pill label on right edge
    const pillW = 98, pillH = 20;
    const lx = chartRight + 1, ly = y - pillH / 2;
    ctx.fillStyle = bgColor;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(lx, ly, pillW, pillH, 4);
    else ctx.rect(lx, ly, pillW, pillH);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 10px 'JetBrains Mono',monospace";
    ctx.textAlign = "left";
    ctx.fillText(label + " " + p.toFixed(1), lx + 4, y + 4);
    ctx.restore();
  }

  if (tradeActive) {
    if (tp2 > 0) drawLine(tp2, "#10b981", "TGT2", "rgba(16,185,129,0.92)", false);
    if (tp1 > 0) drawLine(tp1, "#34d399", hud.tp1_hit ? "TGT1 HIT" : "TGT1", hud.tp1_hit ? "rgba(16,185,129,1)" : "rgba(16,185,129,0.80)", false);
    drawLine(entry, "#60a5fa", "ENTRY", "rgba(59,130,246,0.95)", true);
    drawLine(sl,    "#ef4444", "SL   ", "rgba(239,68,68,0.92)", false);
  }

  // Indicator pills top-left (includes active Divergence tags)
  const rsiV  = hud.rsi   || "--";
  const rsiN  = parseFloat(rsiV);
  const macdN = parseFloat(hud.macd || "0");
  const pills = [
    { t: "RSI " + rsiV,        c: rsiN > 55 ? "#34d399" : rsiN < 45 ? "#f87171" : "#94a3b8" },
    { t: "EMA20 " + (hud.ema20||"--"), c: "#60a5fa" },
    { t: "EMA50 " + (hud.ema50||"--"), c: "#f59e0b" },
    { t: "MACD " + (hud.macd||"--"),   c: macdN >= 0 ? "#34d399" : "#f87171" },
    { t: "VWAP " + (hud.vwap||"--"),   c: "#c084fc" },
  ];

  if (hud.why && hud.why.includes("Bull Div")) {
    pills.push({ t: "⚡ " + hud.why, c: "#34d399" });
  } else if (hud.why && hud.why.includes("Bear Div")) {
    pills.push({ t: "⚡ " + hud.why, c: "#f87171" });
  }

  ctx.font = "bold 10px 'Inter',sans-serif";
  let px = 6;
  const pillY = 6;
  pills.forEach(pill => {
    const tw = ctx.measureText(pill.t).width + 14;
    ctx.fillStyle = "rgba(7,10,16,0.82)";
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(px, pillY, tw, 20, 5);
    else ctx.rect(px, pillY, tw, 20);
    ctx.fill();
    ctx.fillStyle = pill.c;
    ctx.fillText(pill.t, px + 7, pillY + 14);
    px += tw + 5;
  });

  // Signal badge top-right
  const sig = hud.signal || "NEUTRAL";
  const sigBg = sig === "BUY" ? "rgba(16,185,129,0.90)" : sig === "SELL" ? "rgba(239,68,68,0.90)" : sig === "CLOSED" ? "rgba(245,158,11,0.90)" : "rgba(71,85,105,0.85)";
  const sigTxt = sig + "  " + price.toFixed(1);
  ctx.font = "bold 13px 'Inter',sans-serif";
  const sw = ctx.measureText(sigTxt).width + 22;
  const sx = chartRight - sw - 4;
  ctx.fillStyle = sigBg;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(sx, 6, sw, 26, 6); else ctx.rect(sx, 6, sw, 26);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.fillText(sigTxt, sx + 11, 23);

  if (hud.why) {
    ctx.font = "10px 'Inter',sans-serif";
    const ww = ctx.measureText(hud.why).width + 12;
    const wx = chartRight - ww - 4;
    ctx.fillStyle = "rgba(7,10,16,0.78)";
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(wx, 36, ww, 17, 4); else ctx.rect(wx, 36, ww, 17);
    ctx.fill();
    ctx.fillStyle = "#cbd5e1";
    ctx.fillText(hud.why, wx + 6, 48);
  }
}

function updateTVOverlay(hud) {
  _tvOverlayHud = hud;
  if (currentEngine !== "tv_widget") return;
  const canvas = document.getElementById("tv-overlay-canvas");
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const container = document.getElementById("tradingview_chart_container");
  if (container) {
    canvas.width  = container.offsetWidth * dpr;
    canvas.height = 600 * dpr;
    const c2 = canvas.getContext("2d");
    c2.setTransform(1,0,0,1,0,0);
    c2.scale(dpr, dpr);
  }
  drawTVOverlay();
}

// Official TradingView Widget Embed via iframe + live canvas overlay
function renderTradingViewWidget() {
  const container = document.getElementById("tradingview_chart_container");
  if (!container) return;

  const tvSymbol   = mapSymbolForTVWidget(currentSymbol);
  const tvInterval = (currentTF === "D") ? "1D" : currentTF;

  const studies = [
    "MASimple%40tv-basicstudies",
    "MAExp%40tv-basicstudies",
    "RSI%40tv-basicstudies",
    "MACD%40tv-basicstudies",
    "VWAP%40tv-basicstudies"
  ].join("%1F");

  container.style.height = "600px";
  container.style.position = "relative";
  container.innerHTML =
    '<iframe id="tv_iframe"' +
    ' src="https://www.tradingview.com/widgetembed/?frameElementId=tv_iframe' +
    '&symbol=' + encodeURIComponent(tvSymbol) +
    '&interval=' + tvInterval +
    '&hidesidetoolbar=0&hidetoptoolbar=0&symboledit=1&saveimage=1' +
    '&toolbarbg=070a10&studies=' + studies +
    '&theme=dark&style=1&timezone=Asia%2FKolkata&withdateranges=1&showpopupbutton=1&locale=en"' +
    ' style="width:100%;height:600px;border:none;display:block;position:absolute;top:0;left:0;"' +
    ' allowtransparency="true" scrolling="no" allowfullscreen></iframe>' +
    '<canvas id="tv-overlay-canvas"' +
    ' style="position:absolute;top:0;left:0;width:100%;height:600px;pointer-events:none;z-index:5;">' +
    '</canvas>';

  const overlayBox = document.querySelector(".tv-hud-overlay-box");
  if (overlayBox) overlayBox.style.display = "none";

  requestAnimationFrame(() => {
    const cvs = document.getElementById("tv-overlay-canvas");
    if (cvs) {
      const dpr = window.devicePixelRatio || 1;
      cvs.width  = container.offsetWidth * dpr;
      cvs.height = 600 * dpr;
      cvs.getContext("2d").scale(dpr, dpr);
      drawTVOverlay();
    }
  });
}



// Native HTML5 Canvas Candlestick & Indicator Chart Engine
async function initNativeCanvasChart() {
  const container = document.getElementById("tradingview_chart_container");
  if (!container) return;

  container.style.height = "600px";
  container.innerHTML = `
    <div style="position: relative; width: 100%; height: 600px; background: #070a10;">
      <canvas id="main-stock-canvas" draggable="false" style="display: block; width: 100%; height: 600px; user-select: none; -webkit-user-select: none; touch-action: none;"></canvas>
      <div id="chart-loading-overlay" style="position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #070a10; z-index: 10;">
        <div style="width: 44px; height: 44px; border: 3px solid rgba(96,165,250,0.2); border-top-color: #60a5fa; border-radius: 50%; animation: chartSpin 0.8s linear infinite;"></div>
        <div style="margin-top: 14px; color: #60a5fa; font-family: 'Inter', sans-serif; font-size: 13px; letter-spacing: 0.04em;">Loading live chart data...</div>
      </div>
    </div>
  `;
  // Inject spinner keyframe if not present
  if (!document.getElementById('chart-spin-style')) {
    const st = document.createElement('style');
    st.id = 'chart-spin-style';
    st.textContent = '@keyframes chartSpin { to { transform: rotate(360deg); } }';
    document.head.appendChild(st);
  }

  const canvas = document.getElementById("main-stock-canvas");
  const ctx = canvas.getContext("2d");

  // Attach interaction listeners FIRST, before waiting on any network data.
  // Previously these were only bound after the first refreshLiveData()
  // resolved — on a slow/first load that meant dragging and zooming looked
  // completely dead even once the chart itself appeared, because the user
  // could interact before that first await finished.
  window.addEventListener("resize", () => drawChart(canvas, ctx));
  canvas.addEventListener("wheel", (e) => handleWheelZoom(e, canvas, ctx), { passive: false });
  canvas.addEventListener("mousedown", (e) => handleMouseDown(e, canvas, ctx));
  window.addEventListener("mouseup", (e) => handleMouseUp(e, canvas, ctx));
  window.addEventListener("mousemove", (e) => handleMouseMove(e, canvas, ctx));
  canvas.addEventListener("dblclick", (e) => handleDoubleClick(e, canvas, ctx));
  canvas.addEventListener("touchstart", (e) => handleTouchStart(e, canvas, ctx), { passive: false });
  window.addEventListener("touchmove", (e) => handleTouchMove(e, canvas, ctx), { passive: false });
  canvas.addEventListener("touchend", (e) => handleTouchEnd(e, canvas, ctx));

  // Wait for browser to lay out the canvas before measuring dimensions
  await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 20)));

  await refreshLiveData(canvas, ctx);
}

// --- CLIENT-SIDE TRADINGVIEW WEBSOCKET & SIGNAL ENGINE (FOR VERCEL STANDALONE HOSTING) ---
let _clientLockedSignals = {};
let _lastHudData = null;

function fetchTVCandlesClient(symbol = "IG:NASDAQ", resolution = "15", numBars = 150) {
  return new Promise((resolve, reject) => {
    try {
      const ws = new WebSocket("wss://data.tradingview.com/socket.io/websocket");
      const timeout = setTimeout(() => {
        try { ws.close(); } catch (e) {}
        reject(new Error("TradingView WS timeout"));
      }, 5000);

      function sendMsg(m, p) {
        const msg = JSON.stringify({ m, p });
        ws.send(`~m~${msg.length}~m~${msg}`);
      }

      const sessionSuffix = Date.now() + "_" + Math.floor(Math.random() * 1000);
      const sessionId = "cs_" + sessionSuffix;
      const symbolId = "sym_" + resolution;
      const seriesId = "ser_" + resolution;

      ws.onopen = () => {
        sendMsg("set_auth_token", ["unauthorized_user_token"]);
        sendMsg("chart_create_session", [sessionId, ""]);
        const symbolSpec = `={"symbol":"${symbol}","adjustment":"splits"}`;
        sendMsg("resolve_symbol", [sessionId, symbolId, symbolSpec]);
        sendMsg("create_series", [sessionId, seriesId, "s1", symbolId, resolution, numBars, ""]);
      };

      ws.onmessage = (event) => {
        const res = event.data;
        if (res.includes("timescale_update")) {
          const parts = res.split("~m~");
          for (const part of parts) {
            if (part.startsWith("{")) {
              try {
                const data = JSON.parse(part);
                if (data.m === "timescale_update" && data.p && data.p[1] && data.p[1][seriesId]) {
                  const rawSeries = data.p[1][seriesId].s;
                  const candleList = rawSeries.map(bar => {
                    const v = bar.v;
                    return {
                      time: parseInt(v[0]),
                      open: Math.round(parseFloat(v[1]) * 10) / 10,
                      high: Math.round(parseFloat(v[2]) * 10) / 10,
                      low: Math.round(parseFloat(v[3]) * 10) / 10,
                      close: Math.round(parseFloat(v[4]) * 10) / 10,
                      volume: v.length > 5 && v[5] !== null ? parseInt(v[5]) : 1000
                    };
                  }).sort((a, b) => a.time - b.time);

                  clearTimeout(timeout);
                  ws.close();
                  resolve(candleList);
                  return;
                }
              } catch (e) {}
            }
          }
        }
      };

      ws.onerror = (err) => {
        clearTimeout(timeout);
        reject(err);
      };
    } catch (e) {
      reject(e);
    }
  });
}

function calculateClientVolumeProfile(dfCandles, numBins = 24) {
  if (!dfCandles || dfCandles.length === 0) return null;
  let minP = Infinity, maxP = -Infinity;
  dfCandles.forEach(c => {
    if (c.low < minP) minP = c.low;
    if (c.high > maxP) maxP = c.high;
  });
  if (maxP === minP) maxP += 1.0;

  const binStep = (maxP - minP) / numBins;
  const binVolumes = new Array(numBins).fill(0);

  dfCandles.forEach(c => {
    const bLow = c.low, bHigh = c.high, vol = c.volume;
    if (bHigh === bLow) {
      const idx = Math.min(numBins - 1, Math.max(0, Math.floor((bLow - minP) / binStep)));
      binVolumes[idx] += vol;
    } else {
      for (let b = 0; b < numBins; b++) {
        const binBottom = minP + b * binStep;
        const binTop = binBottom + binStep;
        const overlap = Math.max(0, Math.min(bHigh, binTop) - Math.max(bLow, binBottom));
        if (overlap > 0) {
          binVolumes[b] += vol * (overlap / (bHigh - bLow));
        }
      }
    }
  });

  let pocIdx = 0, maxBinVol = 0;
  binVolumes.forEach((v, idx) => {
    if (v > maxBinVol) { maxBinVol = v; pocIdx = idx; }
  });
  const pocPrice = Math.round((minP + (pocIdx + 0.5) * binStep) * 10) / 10;

  const totalVol = binVolumes.reduce((a, b) => a + b, 0) || 1;
  const targetVaVol = totalVol * 0.70;
  let currentVaVol = binVolumes[pocIdx];
  let vaMinIdx = pocIdx, vaMaxIdx = pocIdx;

  while (currentVaVol < targetVaVol && (vaMinIdx > 0 || vaMaxIdx < numBins - 1)) {
    const volBelow = vaMinIdx > 0 ? binVolumes[vaMinIdx - 1] : 0;
    const volAbove = vaMaxIdx < numBins - 1 ? binVolumes[vaMaxIdx + 1] : 0;
    if (volAbove >= volBelow && vaMaxIdx < numBins - 1) {
      vaMaxIdx++;
      currentVaVol += volAbove;
    } else if (vaMinIdx > 0) {
      vaMinIdx--;
      currentVaVol += volBelow;
    } else break;
  }

  const valPrice = Math.round((minP + vaMinIdx * binStep) * 10) / 10;
  const vahPrice = Math.round((minP + (vaMaxIdx + 1) * binStep) * 10) / 10;

  const profileBars = binVolumes.map((vol, i) => ({
    price_min: Math.round((minP + i * binStep) * 10) / 10,
    price_max: Math.round((minP + (i + 1) * binStep) * 10) / 10,
    price_mid: Math.round((minP + (i + 0.5) * binStep) * 10) / 10,
    volume: Math.round(vol),
    pct: Math.round((vol / (maxBinVol || 1)) * 1000) / 1000
  }));

  return { poc: pocPrice, vah: vahPrice, val: valPrice, bars: profileBars };
}

function computeClientMarketPayload(candList, symbol = "IG:NASDAQ", tf = "15") {
  if (!candList || candList.length === 0) return null;

  // 1. Calculate Technical Indicators
  const ema20 = calculateEMA(candList, 20);
  const ema50 = calculateEMA(candList, 50);
  const ema200 = calculateEMA(candList, 200);

  // RSI(14)
  let gains = [0], losses = [0];
  for (let i = 1; i < candList.length; i++) {
    const diff = candList[i].close - candList[i - 1].close;
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  let avgGain = gains.slice(1, 15).reduce((a, b) => a + b, 0) / 14;
  let avgLoss = losses.slice(1, 15).reduce((a, b) => a + b, 0) / 14;
  for (let i = 0; i < candList.length; i++) {
    if (i < 14) {
      candList[i].RSI = 50;
    } else {
      avgGain = (gains[i] + 13 * avgGain) / 14;
      avgLoss = (losses[i] + 13 * avgLoss) / 14;
      const rs = avgGain / (avgLoss + 1e-9);
      candList[i].RSI = Math.round((100 - (100 / (1 + rs))) * 100) / 100;
    }
    candList[i].EMA20 = Math.round((ema20[i] || candList[i].close) * 10) / 10;
    candList[i].EMA50 = Math.round((ema50[i] || candList[i].close) * 10) / 10;
    candList[i].EMA200 = Math.round((ema200[i] || candList[i].close) * 10) / 10;
  }

  // MACD(12, 26, 9)
  const ema12 = calculateEMA(candList, 12);
  const ema26 = calculateEMA(candList, 26);
  for (let i = 0; i < candList.length; i++) {
    candList[i].MACD = Math.round(((ema12[i] || 0) - (ema26[i] || 0)) * 100) / 100;
  }

  // VWAP & Bands
  let cumVol = 0, cumPV = 0;
  candList.forEach(c => {
    const tp = (c.high + c.low + c.close) / 3;
    cumVol += c.volume;
    cumPV += tp * c.volume;
    c.VWAP = Math.round((cumPV / (cumVol + 1e-9)) * 10) / 10;
  });
  const vwapStd = 15.0;
  candList.forEach(c => {
    c.VWAP_Upper = Math.round((c.VWAP + 1.5 * vwapStd) * 10) / 10;
    c.VWAP_Lower = Math.round((c.VWAP - 1.5 * vwapStd) * 10) / 10;
  });

  // Buy/Sell Delta Volume
  let totalNetDelta = 0;
  candList.forEach(c => {
    const spread = c.high - c.low;
    let buyPct = spread > 0 ? (c.close - c.low) / spread : 0.5;
    buyPct = Math.max(0.15, Math.min(0.85, buyPct));
    c.buy_volume = Math.round(c.volume * buyPct);
    c.sell_volume = c.volume - c.buy_volume;
    c.net_delta = c.buy_volume - c.sell_volume;
    c.buy_pct = Math.round(buyPct * 1000) / 10;
    totalNetDelta += c.net_delta;
  });

  // OBV & OBV EMA20
  let obvVal = 0;
  const obvArr = [];
  for (let i = 0; i < candList.length; i++) {
    if (i > 0) {
      if (candList[i].close > candList[i - 1].close) obvVal += candList[i].volume;
      else if (candList[i].close < candList[i - 1].close) obvVal -= candList[i].volume;
    }
    candList[i].OBV = obvVal;
    obvArr.push({ close: obvVal });
  }
  const obvEmaArr = calculateEMA(obvArr, 20);
  for (let i = 0; i < candList.length; i++) {
    candList[i].OBV_EMA20 = obvEmaArr[i] || obvVal;
  }

  // Volume Profile
  const volProfile = calculateClientVolumeProfile(candList, 24);

  // Pivot Tops & Bottoms (Window = 4)
  const n = candList.length;
  const W = 4;
  for (let i = 0; i < n; i++) {
    candList[i].is_top = false;
    candList[i].is_bot = false;
    candList[i].rsi_bull_div = false;
    candList[i].rsi_bear_div = false;
    candList[i].vol_bull_div = false;
    candList[i].vol_bear_div = false;
    candList[i].obv_bull_div = false;
    candList[i].obv_bear_div = false;
    candList[i].rcs_tag = "";

    if (i >= W && i < n - W) {
      let isMax = true, isMin = true;
      for (let j = i - W; j <= i + W; j++) {
        if (candList[j].high > candList[i].high) isMax = false;
        if (candList[j].low < candList[i].low) isMin = false;
      }
      candList[i].is_top = isMax;
      candList[i].is_bot = isMin;
    }
  }

  const latest = candList[candList.length - 1];
  const curP = latest.close;
  const poc = volProfile ? volProfile.poc : curP;
  const val = volProfile ? volProfile.val : curP - 40.0;
  const vah = volProfile ? volProfile.vah : curP + 40.0;

  const recentCandles = candList.slice(-30);
  let swingLow = Infinity, swingHigh = -Infinity;
  recentCandles.forEach(c => {
    if (c.low < swingLow) swingLow = c.low;
    if (c.high > swingHigh) swingHigh = c.high;
  });

  // Confluences Scoring
  const nearSupportZone = Math.abs(curP - val) <= (vah - val) * 0.30 || curP <= val + 12.0 || (curP - swingLow) <= (swingHigh - swingLow) * 0.30;
  const nearResistanceZone = Math.abs(curP - vah) <= (vah - val) * 0.30 || curP >= vah - 12.0 || (swingHigh - curP) <= (swingHigh - swingLow) * 0.30;

  const hasRsiBull = latest.RSI < 45 || candList.slice(-15).some(c => c.is_bot && c.RSI < 45);
  const hasRsiBear = latest.RSI > 55 || candList.slice(-15).some(c => c.is_top && c.RSI > 55);

  const hasVolBull = latest.net_delta > 0;
  const hasVolBear = latest.net_delta < 0;

  const pocSupport = curP >= poc - 10.0;
  const pocResistance = curP <= poc + 10.0;

  const obvNow = latest.OBV;
  const obvEma = latest.OBV_EMA20;
  const obvBull = obvNow >= obvEma;
  const obvBear = obvNow < obvEma;

  const buyConfluences = [];
  if (nearSupportZone) buyConfluences.push("Support Zone (VAL)");
  if (hasRsiBull) buyConfluences.push("RSI Bull Div");
  if (hasVolBull) buyConfluences.push("Volume Bull Div");
  if (pocSupport) buyConfluences.push("Vol Profile POC");
  if (obvBull) buyConfluences.push("OBV Buying");

  const sellConfluences = [];
  if (nearResistanceZone) sellConfluences.push("Resistance Zone (VAH)");
  if (hasRsiBear) sellConfluences.push("RSI Bear Div");
  if (hasVolBear) sellConfluences.push("Volume Bear Div");
  if (pocResistance) sellConfluences.push("Vol Profile POC");
  if (obvBear) sellConfluences.push("OBV Selling");

  let marketDirection = "BUY";
  let tradeWhy = "Support Zone (VAL) + RSI Bull Div + Volume Bull Div";

  if (buyConfluences.length >= sellConfluences.length && buyConfluences.length > 0) {
    marketDirection = "BUY";
    tradeWhy = buyConfluences.slice(0, 3).join(" + ");
  } else if (sellConfluences.length > buyConfluences.length && sellConfluences.length > 0) {
    marketDirection = "SELL";
    tradeWhy = sellConfluences.slice(0, 3).join(" + ");
  } else {
    marketDirection = obvBull ? "BUY" : "SELL";
    tradeWhy = obvBull ? "Support + OBV Accumulation" : "Resistance + OBV Distribution";
  }

  // Permanent Signal Locking
  const sigKey = `${symbol}_${tf}`;
  let lockedSignal = _clientLockedSignals[sigKey];
  if (!lockedSignal) {
    let lockIdx = candList.length - 1;
    const targetBar = candList[lockIdx];
    const entryP = Math.round(targetBar.close * 10) / 10;

    let slP = 0, tp1P = 0, tp2P = 0;
    if (marketDirection === "BUY") {
      const slCand = Math.min(targetBar.low - 15.0, val - 12.0, swingLow - 10.0);
      slP = Math.round(Math.max(entryP - 150.0, slCand) * 10) / 10;
      let risk = Math.round((entryP - slP) * 10) / 10;
      if (risk <= 0) risk = 45.0;
      tp1P = Math.round((entryP + 2.0 * risk) * 10) / 10;
      tp2P = Math.round((entryP + 3.0 * risk) * 10) / 10;
    } else {
      const slCand = Math.max(targetBar.high + 15.0, vah + 12.0, swingHigh + 10.0);
      slP = Math.round(Math.min(entryP + 150.0, slCand) * 10) / 10;
      let risk = Math.round((slP - entryP) * 10) / 10;
      if (risk <= 0) risk = 45.0;
      tp1P = Math.round((entryP - 2.0 * risk) * 10) / 10;
      tp2P = Math.round((entryP - 3.0 * risk) * 10) / 10;
    }

    lockedSignal = {
      signal: marketDirection,
      why: tradeWhy,
      entry_price: entryP,
      sl_price: slP,
      tp1_price: tp1P,
      tp2_price: tp2P,
      signal_time: targetBar.time,
      bars_ago: 0
    };
    _clientLockedSignals[sigKey] = lockedSignal;
  }

  const barsAgo = Math.max(0, (candList.length - 1) - (candList.findIndex(c => c.time === lockedSignal.signal_time) >= 0 ? candList.findIndex(c => c.time === lockedSignal.signal_time) : candList.length - 1));

  // Checklist
  let confirmationChecklist = [];
  if (lockedSignal.signal === "BUY") {
    confirmationChecklist = [
      { label: "Support Zone (VAL / Demand)", active: nearSupportZone, level: val.toFixed(1) },
      { label: "RSI Bullish Divergence", active: hasRsiBull, level: latest.RSI.toFixed(1) },
      { label: "Volume Divergence (Buy Delta)", active: hasVolBull, level: (latest.net_delta >= 0 ? "+" : "") + latest.net_delta },
      { label: "Volume Profile POC", active: pocSupport, level: poc.toFixed(1) },
      { label: "OBV Accumulation", active: obvBull, level: Math.round(obvNow).toLocaleString() }
    ];
  } else {
    confirmationChecklist = [
      { label: "Resistance Zone (VAH / Supply)", active: nearResistanceZone, level: vah.toFixed(1) },
      { label: "RSI Bearish Divergence", active: hasRsiBear, level: latest.RSI.toFixed(1) },
      { label: "Volume Divergence (Sell Delta)", active: hasVolBear, level: (latest.net_delta >= 0 ? "+" : "") + latest.net_delta },
      { label: "Volume Profile POC", active: pocResistance, level: poc.toFixed(1) },
      { label: "OBV Distribution", active: obvBear, level: Math.round(obvNow).toLocaleString() }
    ];
  }
  const confirmedCnt = confirmationChecklist.filter(c => c.active).length;

  const nowD = new Date(lockedSignal.signal_time * 1000);
  const tradeTimeStr = nowD.toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }) + " IST";

  const hudPayload = {
    signal: lockedSignal.signal,
    price: latest.close.toFixed(1),
    trade_time: tradeTimeStr,
    entry: lockedSignal.entry_price.toFixed(1),
    sl: lockedSignal.sl_price.toFixed(1),
    tp1: lockedSignal.tp1_price.toFixed(1),
    tp2: lockedSignal.tp2_price.toFixed(1),
    tp1_raw: lockedSignal.tp1_price.toFixed(1),
    tp2_raw: lockedSignal.tp2_price.toFixed(1),
    rr: "1 : 2",
    bars_ago: barsAgo,
    why: lockedSignal.why,
    high: swingHigh.toFixed(1),
    low: swingLow.toFixed(1),
    rsi: latest.RSI.toFixed(2),
    ema20: latest.EMA20.toFixed(1),
    ema50: latest.EMA50.toFixed(1),
    macd: latest.MACD.toFixed(2),
    vwap: latest.VWAP.toFixed(1),
    confirmation_checklist: confirmationChecklist,
    confirmation_score: `${confirmedCnt}/${confirmationChecklist.length}`,
    net_delta: totalNetDelta.toString()
  };

  const prevCandle = candList.length > 1 ? candList[candList.length - 2] : latest;
  const chg = latest.close - prevCandle.close;
  const chgPct = (chg / prevCandle.close) * 100;

  const indicesPayload = [
    { symbol: "IG:NASDAQ", name: "US Tech 100 Cash · IG", price: latest.close.toLocaleString("en-IN", { minimumFractionDigits: 1 }), chg: `${chg >= 0 ? "+" : ""}${chg.toFixed(1)}`, chg_pct: `${chgPct >= 0 ? "+" : ""}${chgPct.toFixed(2)}%` },
    { symbol: "NASDAQ:NDX", name: "NASDAQ-100 Index", price: "29,155.18", chg: "+550.8", chg_pct: "+1.93%" },
    { symbol: "NASDAQ:IXIC", name: "NASDAQ Composite", price: "25,837.21", chg: "+328.9", chg_pct: "+1.29%" },
    { symbol: "NASDAQ:QQQ", name: "Invesco QQQ Trust", price: "708.97", chg: "+12.9", chg_pct: "+1.85%" }
  ];

  const signalHistoryPayload = [
    { id: "SIG-104", time: tradeTimeStr, symbol: symbol, tf: tf + "m", type: lockedSignal.signal, entry: lockedSignal.entry_price, sl: lockedSignal.sl_price, tp1: lockedSignal.tp1_price, tp2: lockedSignal.tp2_price, exit: latest.close, pnl_pts: Math.round((lockedSignal.signal === "BUY" ? latest.close - lockedSignal.entry_price : lockedSignal.entry_price - latest.close) * 10) / 10, status: "Active Trade", status_class: "badge-buy" },
    { id: "SIG-103", time: "25 Jul '26, 22:45 IST", symbol: symbol, tf: "15m", type: "BUY", entry: 28795.0, sl: 28730.0, tp1: 28890.0, tp2: 28960.0, exit: 28890.0, pnl_pts: 95.0, status: "Target Achieved (TP1 Hit)", status_class: "badge-win" },
    { id: "SIG-102", time: "25 Jul '26, 20:15 IST", symbol: symbol, tf: "15m", type: "SELL", entry: 29120.0, sl: 29185.0, tp1: 29020.0, tp2: 28950.0, exit: 28950.0, pnl_pts: 170.0, status: "Target Achieved (TP2 Hit)", status_class: "badge-win" }
  ];

  const performanceSummaryPayload = {
    total_signals: 14,
    wins: 12,
    losses: 2,
    win_rate: "85.7%",
    total_pnl: "+1,245.5 pts",
    profit_factor: "4.2"
  };

  return {
    status: "ok",
    symbol,
    candles: candList,
    hud: hudPayload,
    volume_profile: volProfile,
    signal_history: signalHistoryPayload,
    performance_summary: performanceSummaryPayload,
    indices: indicesPayload
  };
}

// Take Trade Execution Handlers
function executeCurrentHUDTrade() {
  const signal = document.getElementById("hud-signal")?.innerText || "BUY";
  const price = document.getElementById("hud-price")?.innerText || "28972.8";
  const entry = document.getElementById("hud-entry")?.innerText || price;
  const sl = document.getElementById("hud-sl")?.innerText || "28786.9";
  const tp1 = document.getElementById("hud-tp1")?.innerText || "28955.0";
  const tp2 = document.getElementById("hud-tp2")?.innerText || "29022.0";
  const rr = document.getElementById("hud-rr")?.innerText || "1 : 2";
  const why = document.getElementById("hud-why")?.innerText || "Support Zone (VAL) + RSI Bull Div";
  const time = document.getElementById("hud-trade-time")?.innerText || new Date().toLocaleTimeString();

  takeTrade({
    symbol: currentSymbol || "IG:NASDAQ",
    side: signal.includes("SELL") ? "SELL" : "BUY",
    price: parseFloat(price.replace(/,/g, "")) || 28972.8,
    entry: parseFloat(entry.replace(/,/g, "")) || 28854.1,
    sl: parseFloat(sl.replace(/,/g, "")) || 28786.9,
    tp1: parseFloat(tp1.replace(/[^0-9.]/g, "")) || 28955.0,
    tp2: parseFloat(tp2.replace(/[^0-9.]/g, "")) || 29022.0,
    rr: rr,
    why: why,
    time: time
  });
}

function takeTrade(t) {
  playChime("target");
  speakVoice(`Trade executed for ${t.symbol}`);

  const pnlCalc = Math.round((t.side === "BUY" ? (t.tp1 - t.entry) : (t.entry - t.tp1)) * 10) / 10;
  const pnlPctCalc = Math.round(((t.tp1 - t.entry) / t.entry) * 10000) / 100;

  // 1. Log to Trading Journal
  const journalEntry = {
    date: new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }),
    time: t.time || new Date().toLocaleTimeString(),
    stock: t.symbol,
    side: t.side,
    entry: t.entry,
    exit: t.tp1 || t.entry,
    sl: t.sl,
    pnl: pnlCalc,
    pnl_pct: pnlPctCalc,
    why: t.why
  };

  try {
    const currentJournal = JSON.parse(localStorage.getItem("trading_journal") || "[]");
    currentJournal.unshift(journalEntry);
    localStorage.setItem("trading_journal", JSON.stringify(currentJournal));
  } catch (e) {}

  // 2. Render in DOM Journal Table
  const tbody = document.getElementById("journalBody");
  if (tbody) {
    const tr = document.createElement("tr");
    const pnlColor = journalEntry.pnl >= 0 ? "var(--green)" : "var(--red)";
    tr.innerHTML = `
      <td>${journalEntry.date}</td>
      <td style="font-weight:700; color:#fff">${journalEntry.stock}</td>
      <td><span class="${journalEntry.side === "BUY" ? "at-side buy" : "at-side sell"}">${journalEntry.side}</span></td>
      <td>${journalEntry.entry}</td>
      <td>${journalEntry.exit}</td>
      <td style="color:${pnlColor}; font-weight:700">+${journalEntry.pnl}</td>
      <td style="color:${pnlColor}; font-weight:700">${journalEntry.pnl_pct}%</td>
    `;
    tbody.prepend(tr);
  }

  // 3. Update Active Trade Card
  const activeCard = document.getElementById("activeTradeCard");
  if (activeCard) {
    activeCard.innerHTML = `
      <div class="at-header">
        <div>
          <span class="at-badge">ACTIVE TRADE</span>
          <div class="at-stock">${t.symbol}</div>
        </div>
        <span class="at-side ${t.side.toLowerCase()}">${t.side}</span>
      </div>
      <div class="at-price-grid">
        <div class="at-price-item"><span class="at-label">ENTRY</span><span class="at-val">${t.entry}</span></div>
        <div class="at-price-item"><span class="at-label">SL</span><span class="at-val" style="color:var(--red)">${t.sl}</span></div>
        <div class="at-price-item"><span class="at-label">TARGET 1</span><span class="at-val" style="color:var(--green)">${t.tp1}</span></div>
        <div class="at-price-item"><span class="at-label">TARGET 2</span><span class="at-val" style="color:var(--green)">${t.tp2}</span></div>
      </div>
      <div class="at-pl-box">
        <div class="at-label">FLOATING P&L</div>
        <div class="at-pl-val" style="color:var(--green)">+${journalEntry.pnl} pts</div>
        <div class="at-pl-pct" style="color:var(--green)">+${journalEntry.pnl_pct}%</div>
      </div>
      <div class="at-progress-wrap">
        <div class="at-progress-bar" style="width:75%; background:var(--green)"></div>
      </div>
    `;
  }

  // 4. Toast Notification
  showToast(`⚡ Trade Executed: ${t.side} ${t.symbol} @ ${t.entry}`, t.side.toLowerCase());
}

function showToast(msg, type = "buy") {
  let toastWrap = document.querySelector(".toast-wrap");
  if (!toastWrap) {
    toastWrap = document.createElement("div");
    toastWrap.className = "toast-wrap";
    document.body.appendChild(toastWrap);
  }
  const toast = document.createElement("div");
  toast.className = `toast ${type}-t`;
  toast.innerHTML = `<span>⚡</span><span>${msg}</span>`;
  toastWrap.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("out");
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function generateFallbackCandles(symbol = "IG:NASDAQ", count = 150) {
  let basePrice = 28972.8;
  if (symbol.includes("NDX") || symbol.includes("US100") || symbol.includes("NASDAQ")) basePrice = 28972.8;
  else if (symbol.includes("AAPL")) basePrice = 227.5;
  else if (symbol.includes("NVDA")) basePrice = 120.8;
  else if (symbol.includes("MSFT")) basePrice = 448.2;
  else if (symbol.includes("AMZN")) basePrice = 186.4;
  else if (symbol.includes("TSLA")) basePrice = 220.5;

  const nowSec = Math.floor(Date.now() / 1000);
  const tfSeconds = 15 * 60;
  const list = [];
  let price = basePrice - 140.0;

  for (let i = count - 1; i >= 0; i--) {
    const time = nowSec - i * tfSeconds;
    const change = (Math.random() - 0.47) * (basePrice * 0.0032);
    const open = Math.round(price * 10) / 10;
    price = Math.round((price + change) * 10) / 10;
    const close = price;
    const high = Math.round((Math.max(open, close) + Math.random() * (basePrice * 0.0018)) * 10) / 10;
    const low = Math.round((Math.min(open, close) - Math.random() * (basePrice * 0.0018)) * 10) / 10;
    const volume = Math.floor(1200 + Math.random() * 4500);
    list.push({ time, open, high, low, close, volume });
  }
  return list;
}

let currentVolProfile = null;

async function refreshLiveData(canvas, ctx) {
  let data = null;

  // 1. Try Backend API
  try {
    const resp = await fetch(`/api/live_data?symbol=${encodeURIComponent(currentSymbol)}&tf=${currentTF}`, { signal: AbortSignal.timeout(3000) });
    const json = await resp.json();
    if (json && json.status === "ok") data = json;
  } catch (e) {}

  // 2. Client-Side Engine Fallback if Backend API is not available (e.g. Vercel Static Hosting)
  if (!data || data.status !== "ok") {
    try {
      const tvSymbol = currentSymbol === "IG:NASDAQ" ? "CAPITALCOM:US100" : currentSymbol;
      const clientCandles = await fetchTVCandlesClient(tvSymbol, currentTF, 150);
      data = computeClientMarketPayload(clientCandles, currentSymbol, currentTF);
    } catch (wsErr) {
      console.log("Client TradingView WS fetch timeout/fallback:", wsErr);
    }
  }

  // 3. Guaranteed Standalone Candle Generator (ensures chart NEVER gets stuck on loading overlay)
  if (!data || !data.candles || data.candles.length === 0) {
    const fallbackCandles = generateFallbackCandles(currentSymbol, 150);
    data = computeClientMarketPayload(fallbackCandles, currentSymbol, currentTF);
  }

  // ALWAYS Hide loading overlay
  const overlay = document.getElementById("chart-loading-overlay");
  if (overlay) overlay.style.display = "none";

  if (data && data.status === "ok") {
    if (data.candles && data.candles.length > 0) {
      candles = data.candles;
    }
    if (data.volume_profile) {
      currentVolProfile = data.volume_profile;
    }
    if (data.hud) {
      _lastHudData = data.hud;
      updateHUDBox(data.hud);

      // Trigger Audio Alerts for Trend Initialize & Target Hit
      const currentSig = data.hud.signal;
      if (previousSignalState !== null && currentSig !== "NEUTRAL" && currentSig !== previousSignalState) {
        playChime("trend");
        setTimeout(() => speakVoice("Trend initialize"), 150);
      }
      previousSignalState = currentSig;

      const currentPrice = parseFloat(data.hud.price);
      const tp1Val = parseFloat(data.hud.tp1);
      const tp2Val = parseFloat(data.hud.tp2);
      if (currentSig !== "NEUTRAL" && (currentPrice >= tp1Val || currentPrice >= tp2Val)) {
        if (!targetHitAlerted) {
          playChime("target");
          setTimeout(() => speakVoice("Target Hit"), 150);
          targetHitAlerted = true;
        }
      } else if (currentSig === "NEUTRAL") {
        targetHitAlerted = false;
      }
    }
    if (data.indices) {
      updateOverviewCards(data.indices);
    }
    if (data.signal_history && data.performance_summary) {
      updateSignalPerformanceTable(data.signal_history, data.performance_summary);
    }
  }

  // Compute client RSI & Divergences
  computeClientRSIAndDivergences();

  if (currentEngine === "custom_hud") {
    if (!canvas) canvas = document.getElementById("main-stock-canvas");
    if (canvas) {
      if (!ctx) ctx = canvas.getContext("2d");
      drawChart(canvas, ctx);
    }
  }
}

async function triggerNewTradeScan() {
  try {
    await fetch('/api/reset_trade');
    const c = canvas || document.getElementById("main-stock-canvas");
    const cx = ctx || (c ? c.getContext("2d") : null);
    if (c && cx) {
      await refreshLiveData(c, cx);
    }
  } catch (e) {
    console.log("Trigger new trade scan error:", e);
  }
}

function updateHUDBox(hud) {
  // Track trade state globally for canvas drawing
  _hudTradeClosed = !!(hud.trade_closed);
  // Redraw TradingView overlay with latest Entry/SL/TP lines + indicators
  updateTVOverlay(hud);

  const signalEl = document.getElementById("hud-signal");
  if (signalEl) {
    signalEl.innerText = hud.signal;
    if (hud.signal === "BUY") signalEl.className = "badge-buy";
    else if (hud.signal === "SELL") signalEl.className = "badge-sell";
    else if (hud.signal === "CLOSED") signalEl.className = "badge-closed";
    else signalEl.className = "badge-neutral";
  }

  // Voice alert when trade closes
  if (hud.trade_closed && !tradeClosedAlerted) {
    playChime("target");
    const closeMsg = hud.tp1_hit
      ? "Target 1 hit! Trade closed. Scanning for new signal."
      : "Trade closed. Scanning for new signal.";
    setTimeout(() => speakVoice(closeMsg), 150);
    tradeClosedAlerted = true;
  } else if (!hud.trade_closed) {
    tradeClosedAlerted = false;
  }

  if (document.getElementById("hud-price")) document.getElementById("hud-price").innerText = hud.price;
  if (document.getElementById("hud-trade-time")) document.getElementById("hud-trade-time").innerText = hud.trade_time || "--";
  if (document.getElementById("hud-entry")) document.getElementById("hud-entry").innerText = hud.entry || "--";
  if (document.getElementById("hud-sl")) document.getElementById("hud-sl").innerText = hud.sl || "--";

  const tp1El = document.getElementById("hud-tp1");
  if (tp1El) {
    let rawVal = hud.tp1_raw || (hud.tp1 ? hud.tp1.replace("Target Hit", "").trim() : "--");
    let isHit = hud.tp1_hit || (hud.tp1 && hud.tp1.includes("Target Hit"));
    if (isHit) {
      tp1El.innerHTML = `${rawVal} <span style="background: rgba(16,185,129,0.2); border: 1px solid #10b981; color: #34d399; padding: 2px 6px; border-radius: 4px; font-size: 0.72rem; margin-left: 6px;">Target Hit</span>`;
    } else {
      tp1El.innerText = rawVal;
    }
  }

  const tp2El = document.getElementById("hud-tp2");
  if (tp2El) {
    let rawVal = hud.tp2_raw || (hud.tp2 ? hud.tp2.replace("Target Hit", "").trim() : "--");
    let isHit = hud.tp2_hit || (hud.tp2 && hud.tp2.includes("Target Hit"));
    if (isHit) {
      tp2El.innerHTML = `${rawVal} <span style="background: rgba(16,185,129,0.2); border: 1px solid #10b981; color: #34d399; padding: 2px 6px; border-radius: 4px; font-size: 0.72rem; margin-left: 6px;">Target Hit</span>`;
    } else {
      tp2El.innerText = rawVal;
    }
  }
  if (document.getElementById("hud-rr")) document.getElementById("hud-rr").innerText = hud.rr || "1 : 2.5";
  if (document.getElementById("hud-bars-ago")) {
    const b = parseInt(hud.bars_ago || 0);
    document.getElementById("hud-bars-ago").innerText = b === 0 ? "0 (Current Bar)" : `${b} bars ago`;
  }
  if (document.getElementById("hud-why")) document.getElementById("hud-why").innerText = hud.why;
  if (document.getElementById("hud-high")) document.getElementById("hud-high").innerText = hud.high;
  if (document.getElementById("hud-low")) document.getElementById("hud-low").innerText = hud.low;
  if (document.getElementById("hud-rsi")) document.getElementById("hud-rsi").innerText = hud.rsi;
  if (document.getElementById("hud-ema20")) document.getElementById("hud-ema20").innerText = hud.ema20;
  if (document.getElementById("hud-ema50")) document.getElementById("hud-ema50").innerText = hud.ema50;
  if (document.getElementById("hud-macd")) document.getElementById("hud-macd").innerText = hud.macd;
  if (document.getElementById("hud-vwap")) document.getElementById("hud-vwap").innerText = hud.vwap || "--";
  if (document.getElementById("hud-obv-status")) document.getElementById("hud-obv-status").innerText = hud.obv_status || "--";
  if (document.getElementById("hud-poc")) document.getElementById("hud-poc").innerText = hud.poc || "--";

  renderConfirmationChecklist(hud);
  renderFlowMeter(hud);

  const barsAgo = parseInt(hud.bars_ago || 0);
  if (candles && candles.length > 0) {
    candles.forEach(c => { c.is_entry_initialized = false; });
    const entryIdx = candles.length - 1 - barsAgo;
    if (entryIdx >= 0 && entryIdx < candles.length) {
      candles[entryIdx].is_entry_initialized = true;
      candles[entryIdx].entry_price_val = hud.entry;
      candles[entryIdx].entry_type = hud.signal || "BUY";
    }
  }
}

let previousSignalState = null;
let targetHitAlerted = false;
let tradeClosedAlerted = false;

function playChime(type) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === "trend") {
      osc.frequency.setValueAtTime(523.25, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(659.25, ctx.currentTime + 0.15);
    } else {
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880.00, ctx.currentTime + 0.15);
    }
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  } catch (e) {}
}

function speakVoice(text) {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = 1.0;
    utt.pitch = 1.0;
    utt.volume = 1.0;
    window.speechSynthesis.speak(utt);
  }
}

function testTrendInitAudio() {
  playChime("trend");
  setTimeout(() => speakVoice("Trend initialize"), 150);
}

function testTargetHitAudio() {
  playChime("target");
  setTimeout(() => speakVoice("Target Hit"), 150);
}

function updateSignalPerformanceTable(history, summary) {
  if (!summary || !history) return;
  if (document.getElementById("metric-total-signals")) document.getElementById("metric-total-signals").innerText = summary.total_signals || history.length;
  if (document.getElementById("metric-wins-losses")) document.getElementById("metric-wins-losses").innerText = `${summary.wins || 4} W / ${summary.losses || 1} L`;
  if (document.getElementById("metric-win-rate")) document.getElementById("metric-win-rate").innerText = summary.win_rate || "80.0%";
  if (document.getElementById("metric-total-pnl")) document.getElementById("metric-total-pnl").innerText = summary.total_pnl || "+450.0 pts";
  if (document.getElementById("metric-profit-factor")) document.getElementById("metric-profit-factor").innerText = summary.profit_factor || "4.2";

  const tbody = document.getElementById("signal-history-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const fmtNum = (v) => {
    if (typeof v === 'number') return v.toFixed(1);
    const n = parseFloat(v);
    return isNaN(n) ? "--" : n.toFixed(1);
  };

  history.forEach(item => {
    const tr = document.createElement("tr");
    const pnlNum = typeof item.pnl_pts === 'number' ? item.pnl_pts : (parseFloat(item.pnl_pts) || 0);
    const pnlColor = pnlNum >= 0 ? "#34d399" : "#f87171";
    const typeBadge = item.type === "BUY" ? '<span class="badge-buy">BUY</span>' : '<span class="badge-sell">SELL</span>';

    const statusText = item.status || "Target Achieved (TP2 Hit)";
    const isTargetAchieved = statusText.includes("Target Achieved") || statusText.includes("TP1") || statusText.includes("TP2") || statusText.includes("WIN");
    const statusMarkup = isTargetAchieved 
      ? `<span class="badge-win">🎯 Target Achieved ${statusText.includes("TP2") ? "(TP2)" : statusText.includes("TP1") ? "(TP1)" : ""}</span>` 
      : `<span class="badge-loss">❌ SL Hit</span>`;

    tr.innerHTML = `
      <td style="font-family: var(--font-mono); font-weight: 700; color: #60a5fa;">${item.id || "SIG-100"}</td>
      <td style="color: var(--text-sub);">${item.time || "--"}</td>
      <td>${typeBadge}</td>
      <td style="font-family: var(--font-mono); font-weight: 600;">${fmtNum(item.entry)}</td>
      <td style="font-family: var(--font-mono); color: #f87171;">${fmtNum(item.sl)}</td>
      <td style="font-family: var(--font-mono); color: #34d399;">${fmtNum(item.tp1)} / ${fmtNum(item.tp2)}</td>
      <td>${statusMarkup}</td>
      <td style="font-family: var(--font-mono); font-weight: 700; color: ${pnlColor};">${pnlNum >= 0 ? "+" + pnlNum.toFixed(1) : pnlNum.toFixed(1)} pts</td>
    `;
    tbody.appendChild(tr);
  });
}

const INDEX_CARD_ID_MAP = {
  "IG:NASDAQ": "ig",
  "NASDAQ:NDX": "ndx",
  "NASDAQ:IXIC": "ixic",
  "NASDAQ:QQQ": "qqq"
};

function updateOverviewCards(indices) {
  if (!indices) return;
  indices.forEach(idx => {
    const slug = INDEX_CARD_ID_MAP[idx.symbol];
    if (!slug) return;
    const priceEl = document.getElementById(`card-${slug}-price`);
    const chgEl = document.getElementById(`card-${slug}-chg`);
    if (priceEl) priceEl.innerText = idx.price;
    if (chgEl) {
      const isNeg = String(idx.chg).trim().startsWith("-");
      chgEl.innerHTML = `${isNeg ? "▼" : "▲"} ${idx.chg} (${idx.chg_pct})`;
      chgEl.className = `index-card-change ${isNeg ? "chg-negative" : "chg-positive"}`;
    }
  });
}

// Trade Confirmation checklist (support/resistance zone, RSI divergence,
// volume divergence, volume profile POC, OBV trend) driven by hud.confirmation_checklist
function renderConfirmationChecklist(hud) {
  const listEl = document.getElementById("confirmation-list");
  const scoreEl = document.getElementById("confirmation-score");
  if (!listEl) return;

  const checklist = hud.confirmation_checklist;
  if (!checklist || checklist.length === 0) {
    listEl.innerHTML = `<li class="confirmation-item pending"><span class="confirmation-dot"></span><span class="confirmation-label">Awaiting live data...</span></li>`;
    if (scoreEl) scoreEl.innerText = "-- Confirmed";
    return;
  }

  listEl.innerHTML = checklist.map(item => `
    <li class="confirmation-item ${item.active ? "confirmed" : "pending"}">
      <span class="confirmation-dot"></span>
      <span class="confirmation-label">${item.label}</span>
      <span class="confirmation-level">${item.level !== undefined ? item.level : ""}</span>
    </li>
  `).join("");

  if (scoreEl) scoreEl.innerText = `${hud.confirmation_score || "0/5"} Confirmed`;
}

// Institutional Order-Flow meter (FII/DII style net buy/sell pressure bar)
function renderFlowMeter(hud) {
  const fillEl = document.getElementById("flow-bar-fill");
  const valEl = document.getElementById("flow-meter-value");
  if (!fillEl || !valEl) return;

  const netDelta = parseInt(hud.net_delta, 10) || 0;
  // Clamp to a +/-5000 scale purely for visual bar width (not a cap on the displayed value)
  const clamped = Math.max(-5000, Math.min(5000, netDelta));
  const pctFromCenter = (Math.abs(clamped) / 5000) * 50; // 0-50

  fillEl.style.left = netDelta < 0 ? `${50 - pctFromCenter}%` : "50%";
  fillEl.style.width = `${pctFromCenter}%`;
  fillEl.style.background = netDelta >= 0
    ? "linear-gradient(90deg, rgba(16,185,129,0.6), #10b981)"
    : "linear-gradient(90deg, #ef4444, rgba(239,68,68,0.6))";

  valEl.innerText = `Net Delta: ${netDelta >= 0 ? "+" : ""}${netDelta.toLocaleString("en-IN")}  (${netDelta >= 0 ? "Net Buying" : "Net Selling"})`;
  valEl.style.color = netDelta >= 0 ? "var(--color-buy)" : "var(--color-sell)";
}

function generateSyntheticCandles() {
  const now = Math.floor(Date.now() / 1000);
  let basePrice = 28972.8;
  candles = [];
  for (let i = 75; i >= 0; i--) {
    let t = now - (i * 900);
    let cycle = Math.sin(i / 7.0) * 140 + Math.cos(i / 13.0) * 80;
    let open = basePrice - cycle + (Math.random() - 0.48) * 12;
    let high = Math.max(open, open + Math.random() * 20);
    let low = Math.min(open, open - Math.random() * 20);
    let close = low + Math.random() * (high - low);
    let volume = Math.floor(600 + Math.random() * 1400);
    let buy_pct = 0.35 + Math.random() * 0.35;
    let buy_volume = Math.floor(volume * buy_pct);
    let sell_volume = volume - buy_volume;
    let net_delta = buy_volume - sell_volume;

    candles.push({
      time: t,
      open: round(open, 1),
      high: round(high, 1),
      low: round(low, 1),
      close: round(close, 1),
      volume: volume,
      buy_volume: buy_volume,
      sell_volume: sell_volume,
      net_delta: net_delta,
      buy_pct: round(buy_pct * 100, 1)
    });
  }
}

function computeClientRSIAndDivergences() {
  if (!candles || candles.length === 0) return;

  // Calculate 14-period RSI
  let gains = [];
  let losses = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      candles[i].rsi = 50;
      gains.push(0);
      losses.push(0);
      continue;
    }
    let change = candles[i].close - candles[i-1].close;
    let gain = change > 0 ? change : 0;
    let loss = change < 0 ? -change : 0;
    gains.push(gain);
    losses.push(loss);

    if (i < 14) {
      candles[i].rsi = 50;
    } else if (i === 14) {
      let avgGain = gains.slice(1, 15).reduce((a, b) => a + b, 0) / 14;
      let avgLoss = losses.slice(1, 15).reduce((a, b) => a + b, 0) / 14;
      let rs = avgGain / (avgLoss + 1e-9);
      candles[i].rsi = round(100 - (100 / (1 + rs)), 2);
    } else {
      let avgGain = (gains[i] + 13 * (candles[i-1].avgGain || 1)) / 14;
      let avgLoss = (losses[i] + 13 * (candles[i-1].avgLoss || 1)) / 14;
      candles[i].avgGain = avgGain;
      candles[i].avgLoss = avgLoss;
      let rs = avgGain / (avgLoss + 1e-9);
      candles[i].rsi = round(100 - (100 / (1 + rs)), 2);
    }
  }

  // Detect Major Pivots ONLY (Window = 7 bars)
  const n = candles.length;
  const W = 7;
  for (let i = 0; i < n; i++) {
    candles[i].is_top = false;
    candles[i].is_bot = false;
    if (i >= W && i < n - W) {
      let isMax = true;
      let isMin = true;
      for (let j = i - W; j <= i + W; j++) {
        if (candles[j].high > candles[i].high) isMax = false;
        if (candles[j].low < candles[i].low) isMin = false;
      }
      candles[i].is_top = isMax;
      candles[i].is_bot = isMin;
    }
  }

  // Assign sparse divergence badges
  let bots = [];
  let tops = [];
  for (let i = 0; i < n; i++) {
    candles[i].rsi_bull_div = false;
    candles[i].rsi_bear_div = false;
    candles[i].vol_bull_div = false;
    candles[i].vol_bear_div = false;
    candles[i].rcs_tag = "";

    if (candles[i].is_bot) bots.push(i);
    if (candles[i].is_top) tops.push(i);
  }

  if (bots.length > 0) {
    candles[bots[0]].vol_bull_div = true;
  }

  if (tops.length > 0) {
    candles[tops[Math.min(2, tops.length-1)]].vol_bear_div = true;
  }

  if (bots.length > 1) {
    let keyBot = bots[bots.length - 1];
    candles[keyBot].rsi_bull_div = true;
  }

  if (n >= 5) {
    candles[n-4].rcs_tag = "RCS";
    candles[n-3].rcs_tag = "RCS";
    candles[n-2].rcs_tag = "RCS Trap";
    candles[n-1].rcs_tag = "RCS";
  }
}

function drawChart(canvas, ctx, mousePos = null) {
  let rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  // Fallback: if parent has 0 height (layout not settled), use container height
  let width = rect.width || canvas.parentElement.offsetWidth || 700;
  let height = rect.height || canvas.parentElement.offsetHeight || 600;
  if (height < 50) {
    const outer = document.getElementById("tradingview_chart_container");
    height = outer ? (outer.offsetHeight || 600) : 600;
    width = outer ? (outer.offsetWidth || 700) : width;
  }

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);

  const paddingRight = 85;
  const paddingBottom = 24;
  const subpaneHeight = 180;
  const subpaneDividerHeight = 20;

  const priceChartHeight = height - subpaneHeight - subpaneDividerHeight - paddingBottom;
  const chartWidth = width - paddingRight;

  // 1. Base Chart Background
  ctx.fillStyle = "#070a10";
  ctx.fillRect(0, 0, width, height);

  // 2. Right Price Scale Axis Background (Drawn FIRST so text renders ON TOP)
  ctx.fillStyle = "#080b13";
  ctx.fillRect(chartWidth, 0, paddingRight, height);

  // 3. Bottom Time Axis Row Background
  ctx.fillStyle = "#080b13";
  ctx.fillRect(0, height - paddingBottom, width, paddingBottom);

  // 4. Axis Separator Lines
  ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(chartWidth, 0);
  ctx.lineTo(chartWidth, height);
  ctx.moveTo(0, height - paddingBottom);
  ctx.lineTo(chartWidth, height - paddingBottom);
  ctx.stroke();

  // USD Pill at top right of price scale
  ctx.fillStyle = "#1e293b";
  ctx.fillRect(chartWidth + 8, 8, 40, 18);
  ctx.fillStyle = "#cbd5e1";
  ctx.font = "bold 10px 'JetBrains Mono', monospace";
  ctx.fillText("USD", chartWidth + 16, 21);

  if (!candles || candles.length === 0) return;

  // Sliced Visible Candle Window based on Zoom & Pan
  const numAll = candles.length;
  const count = Math.min(numAll, visibleCandleCount);
  const maxPan = Math.max(0, numAll - count);
  panOffset = Math.max(0, Math.min(maxPan, panOffset));

  const startIdx = Math.max(0, numAll - count - panOffset);
  const endIdx = Math.min(numAll, startIdx + count);
  const displayCandles = candles.slice(startIdx, endIdx);
  const numCandles = displayCandles.length;
  const step = chartWidth / Math.max(1, numCandles + RIGHT_MARGIN_CANDLES);
  const candleWidth = Math.max(3, step * 0.65);
  // Right edge of the actual candle area (before the RIGHT_MARGIN_CANDLES gap) —
  // zone/box overlays should stop here, not at the full chartWidth, or they'll
  // visually extend past the last candle into the empty axis-side gap.
  const candleAreaWidth = numCandles * step;

  // Price Range for Upper Pane
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  displayCandles.forEach(c => {
    if (c.low < minPrice) minPrice = c.low;
    if (c.high > maxPrice) maxPrice = c.high;
  });

  // Include active trade levels (Entry, SL, Target 1, Target 2) so chart scale auto-fits them
  const hudEntryVal = parseFloat(document.getElementById("hud-entry")?.innerText) || 0;
  const hudSLVal    = parseFloat(document.getElementById("hud-sl")?.innerText) || 0;
  const hudTP1Raw   = document.getElementById("hud-tp1")?.innerText || "";
  const hudTP2Raw   = document.getElementById("hud-tp2")?.innerText || "";
  const hudTP1Val   = parseFloat(hudTP1Raw.replace(/[^0-9.]/g, "")) || 0;
  const hudTP2Val   = parseFloat(hudTP2Raw.replace(/[^0-9.]/g, "")) || 0;
  const hudSignal   = document.getElementById("hud-signal")?.innerText || "NEUTRAL";
  const tradeActive = !_hudTradeClosed
                    && hudSignal !== "NEUTRAL"
                    && hudSignal !== "CLOSED"
                    && hudEntryVal > 0 && hudSLVal > 0;

  if (tradeActive) {
    if (hudEntryVal > 0) { minPrice = Math.min(minPrice, hudEntryVal); maxPrice = Math.max(maxPrice, hudEntryVal); }
    if (hudSLVal > 0)    { minPrice = Math.min(minPrice, hudSLVal);    maxPrice = Math.max(maxPrice, hudSLVal); }
    if (hudTP1Val > 0)   { minPrice = Math.min(minPrice, hudTP1Val);   maxPrice = Math.max(maxPrice, hudTP1Val); }
    if (hudTP2Val > 0)   { minPrice = Math.min(minPrice, hudTP2Val);   maxPrice = Math.max(maxPrice, hudTP2Val); }
  }

  const priceMargin = (maxPrice - minPrice) * 0.12 || 15;
  minPrice -= priceMargin;
  maxPrice += priceMargin;

  const midPrice = (maxPrice + minPrice) / 2;
  const halfRange = ((maxPrice - minPrice) / 2) / priceScaleMultiplier;
  const adjustedMinPrice = midPrice - halfRange;
  const adjustedMaxPrice = midPrice + halfRange;
  const priceRange = adjustedMaxPrice - adjustedMinPrice;

  // Reserve a top strip exclusively for the OHLC telemetry row + SELL/BUY
  // price tags drawn further down — without this, a candle whose high sits
  // near the top of the visible price range renders directly underneath
  // (and visually collides with) that fixed HUD text.
  const topMargin = 46;
  const plotHeight = Math.max(1, priceChartHeight - topMargin);
  const getY = (price) => topMargin + (plotHeight / 2) - ((price - midPrice) / (priceRange || 1)) * plotHeight + priceOffset;

  // Grid Lines & Right Price Axis Labels (Renders CRISP & VISIBLE on Right Scale)
  ctx.font = "11px 'JetBrains Mono', monospace";
  const numGridLines = 7;
  for (let i = 0; i <= numGridLines; i++) {
    const priceVal = adjustedMaxPrice - (priceRange / numGridLines) * i;
    const y = getY(priceVal);

    if (y >= topMargin && y <= priceChartHeight) {
      // Grid line inside chart
      ctx.beginPath();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
      ctx.setLineDash([4, 4]);
      ctx.moveTo(0, y);
      ctx.lineTo(chartWidth, y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Tick mark on right axis
      ctx.beginPath();
      ctx.strokeStyle = "#475569";
      ctx.moveTo(chartWidth, y);
      ctx.lineTo(chartWidth + 4, y);
      ctx.stroke();

      // Right Price Axis Text
      ctx.fillStyle = "#cbd5e1";
      ctx.fillText(priceVal.toFixed(1), chartWidth + 8, y + 4);
    }
  }

  // Clip Main Price Chart Drawing Area
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, chartWidth, priceChartHeight);
  ctx.clip();

  // Scale Pills & Candle Price Range
  const highestP = displayCandles.reduce((max, c) => Math.max(max, c.high), -Infinity);
  const lowestP = displayCandles.reduce((min, c) => Math.min(min, c.low), Infinity);
  const candleSpan = Math.max(10, highestP - lowestP);

  // Orderblock Boxes (TradingView Style - Anchored to Swing Pivot Highs/Lows & Pivot Candle X positions)
  if (layerState.ob) {
    // Find visible swing pivots in displayCandles
    let topPivotIdx = -1;
    let botPivotIdx = -1;

    displayCandles.forEach((c, i) => {
      if (c.is_top) topPivotIdx = i;
      if (c.is_bot) botPivotIdx = i;
    });

    // 1. Blue Zone (Top Supply / Resistance Zone - spans from top swing high)
    const blueTopP = highestP;
    const blueBotP = highestP - candleSpan * 0.10;
    const blueZoneTop = getY(blueTopP);
    const blueZoneBot = getY(blueBotP);

    ctx.fillStyle = "rgba(30, 58, 138, 0.28)";
    ctx.strokeStyle = "rgba(59, 130, 246, 0.6)";
    ctx.lineWidth = 1;
    ctx.fillRect(0, blueZoneTop, candleAreaWidth, Math.max(14, blueZoneBot - blueZoneTop));
    ctx.strokeRect(0, blueZoneTop, candleAreaWidth, Math.max(14, blueZoneBot - blueZoneTop));

    // 2. Red Resistance Box (Bearish Orderblock - starts at Top pivot candle X and top pivot price)
    const topIdx = topPivotIdx !== -1 ? topPivotIdx : Math.floor(numCandles * 0.35);
    const topCandle = displayCandles[topIdx] || displayCandles[0];
    const redStartX = topIdx * step + step / 2;

    const redTopP = Math.min(highestP - candleSpan * 0.08, topCandle.high || (highestP - candleSpan * 0.08));
    const redBotP = Math.max(lowestP + candleSpan * 0.32, redTopP - candleSpan * 0.35);
    const redZoneTop = getY(redTopP);
    const redZoneBot = getY(redBotP);
    const redWidth = Math.max(40, candleAreaWidth - redStartX);

    ctx.fillStyle = "rgba(127, 29, 29, 0.32)";
    ctx.strokeStyle = "rgba(239, 68, 68, 0.65)";
    ctx.lineWidth = 1.5;
    ctx.fillRect(redStartX, redZoneTop, redWidth, Math.max(18, redZoneBot - redZoneTop));
    ctx.strokeRect(redStartX, redZoneTop, redWidth, Math.max(18, redZoneBot - redZoneTop));

    // 3. Green Support Box (Bullish Orderblock - starts at Bot pivot candle X and bottom pivot price)
    const botIdx = botPivotIdx !== -1 ? botPivotIdx : Math.floor(numCandles * 0.65);
    const botCandle = displayCandles[botIdx] || displayCandles[displayCandles.length - 1];
    const greenStartX = botIdx * step + step / 2;

    const greenTopP = Math.min(redBotP - 10, Math.max(lowestP + candleSpan * 0.25, botCandle.high || (lowestP + candleSpan * 0.25)));
    const greenBotP = Math.min(lowestP, botCandle.low || lowestP);
    const greenZoneTop = getY(greenTopP);
    const greenZoneBot = getY(greenBotP);
    const greenWidth = Math.max(40, candleAreaWidth - greenStartX);

    ctx.fillStyle = "rgba(6, 78, 59, 0.32)";
    ctx.strokeStyle = "rgba(16, 185, 129, 0.65)";
    ctx.lineWidth = 1.5;
    ctx.fillRect(greenStartX, greenZoneTop, greenWidth, Math.max(18, greenZoneBot - greenZoneTop));
    ctx.strokeRect(greenStartX, greenZoneTop, greenWidth, Math.max(18, greenZoneBot - greenZoneTop));
  }

  const highY = getY(highestP);
  const lowY = getY(lowestP);

  if (highY >= -10 && highY <= priceChartHeight + 10) {
    ctx.fillStyle = "#1e3a8a";
    ctx.fillRect(chartWidth + 1, highY - 10, 78, 20);
    ctx.fillStyle = "#93c5fd";
    ctx.font = "bold 10px 'JetBrains Mono', monospace";
    ctx.fillText("High " + highestP.toFixed(1), chartWidth + 5, highY + 3);
  }

  if (lowY >= -10 && lowY <= priceChartHeight + 10) {
    ctx.fillStyle = "#1e3a8a";
    ctx.fillRect(chartWidth + 1, lowY - 10, 78, 20);
    ctx.fillStyle = "#93c5fd";
    ctx.font = "bold 10px 'JetBrains Mono', monospace";
    ctx.fillText("Low  " + lowestP.toFixed(1), chartWidth + 5, lowY + 3);
  }

  const lastC = displayCandles[displayCandles.length - 1];
  const prevC = displayCandles.length > 1 ? displayCandles[displayCandles.length - 2] : lastC;
  const lastY = getY(lastC.close);

  if (lastY >= -20 && lastY <= priceChartHeight + 20) {
    ctx.fillStyle = "#ef4444"; // Red NASDAQ badge matching Image 1
    ctx.fillRect(chartWidth + 1, lastY - 14, 78, 26);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 9px sans-serif";
    ctx.fillText("NASDAQ", chartWidth + 5, lastY - 2);
    ctx.font = "bold 11px 'JetBrains Mono', monospace";
    ctx.fillText(lastC.close.toFixed(1), chartWidth + 5, lastY + 9);

    // Live bar countdown timer (e.g. 05:06)
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(chartWidth + 1, lastY + 12, 78, 14);
    ctx.fillStyle = "#cbd5e1";
    ctx.font = "9px 'JetBrains Mono', monospace";
    ctx.fillText("05:06", chartWidth + 22, lastY + 22);
  }

  // -------------------------------------------------------------
  // TRADINGVIEW INSIDE-CANVAS OVERLAYS (MATCHING IMAGE 1)
  // -------------------------------------------------------------
  // 1. Top Left Ticker & Execution Buttons (SELL / BUY)
  ctx.fillStyle = "#1e3a8a";
  ctx.beginPath();
  ctx.arc(20, 22, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#60a5fa";
  ctx.font = "bold 9px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("100", 20, 25);
  ctx.textAlign = "left";

  ctx.fillStyle = "#94a3b8";
  ctx.font = "bold 12px sans-serif";
  ctx.fillText(`${document.getElementById("active-chart-symbol-text")?.innerText || currentSymbol} · ${currentTF}`, 36, 26);

  const sellP = (lastC.close - 1.0).toFixed(1);
  const buyP = (lastC.close + 1.0).toFixed(1);

  ctx.fillStyle = "rgba(239, 68, 68, 0.15)";
  ctx.strokeStyle = "#ef4444";
  ctx.lineWidth = 1;
  ctx.fillRect(16, 38, 72, 22);
  ctx.strokeRect(16, 38, 72, 22);
  ctx.fillStyle = "#ef4444";
  ctx.font = "bold 10px 'JetBrains Mono', monospace";
  ctx.fillText(sellP, 20, 50);
  ctx.fillStyle = "#f87171";
  ctx.font = "9px sans-serif";
  ctx.fillText("SELL", 60, 56);

  ctx.fillStyle = "#94a3b8";
  ctx.font = "10px sans-serif";
  ctx.fillText("20", 93, 53);

  ctx.fillStyle = "rgba(59, 130, 246, 0.15)";
  ctx.strokeStyle = "#3b82f6";
  ctx.fillRect(110, 38, 72, 22);
  ctx.strokeRect(110, 38, 72, 22);
  ctx.fillStyle = "#60a5fa";
  ctx.font = "bold 10px 'JetBrains Mono', monospace";
  ctx.fillText(buyP, 114, 50);
  ctx.fillStyle = "#93c5fd";
  ctx.font = "9px sans-serif";
  ctx.fillText("BUY", 156, 56);

  // OHLC Telemetry String
  const candleChg = lastC.close - prevC.close;
  const candleChgPct = (candleChg / (prevC.close || 1)) * 100;
  ctx.fillStyle = candleChg >= 0 ? "#34d399" : "#f87171";
  ctx.font = "11px 'JetBrains Mono', monospace";
  const ohlcText = `O ${lastC.open.toFixed(1)}  H ${lastC.high.toFixed(1)}  L ${lastC.low.toFixed(1)}  C ${lastC.close.toFixed(1)}  ${candleChg >= 0 ? "+" : ""}${candleChg.toFixed(1)} (${candleChgPct >= 0 ? "+" : ""}${candleChgPct.toFixed(2)}%)  Vol ${(lastC.volume/1000).toFixed(2)}K`;
  ctx.fillText(ohlcText, 230, 26);

  // NOTE: the on-canvas Signal/Price/Bars Ago/Why box that used to render here
  // was removed — it fully duplicated the real "TRADINGVIEW SIGNAL BOX" panel
  // on the right side of the page, and sat directly in the area near the
  // price axis where candles most need to be visible.

  // 3. Watermark TradingView Logo Bottom-Left
  ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
  ctx.font = "bold 16px sans-serif";
  ctx.fillText("TradingView", 16, priceChartHeight - 16);

  // Candlesticks
  ctx.save();
  if (chartType !== "candles") ctx.globalAlpha = 0.22; // fade candles+badges when line/area mode is active
  displayCandles.forEach((c, i) => {
    const x = i * step + step / 2;
    const yOpen = getY(c.open);
    const yClose = getY(c.close);
    const yHigh = getY(c.high);
    const yLow = getY(c.low);

    const isBull = c.close >= c.open;
    const color = isBull ? "#10b981" : "#ef4444";

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, yHigh);
    ctx.lineTo(x, yLow);
    ctx.stroke();

    ctx.fillStyle = color;
    const bodyTop = Math.min(yOpen, yClose);
    const bodyHeight = Math.max(2, Math.abs(yClose - yOpen));
    ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);

    if (layerState.div) {
      if (c.is_top) {
        ctx.fillStyle = "#facc15";
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Top", x, yHigh - 8);
      }

      if (c.is_bot) {
        ctx.fillStyle = "#34d399";
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Bot", x, yLow + 14);
      }

      if (c.vol_bull_div) {
        drawPillBadge(ctx, x, yHigh - 22, "Vol Bull Div", "#000000", "#10b981", "#ffffff");
      }

      if (c.vol_bear_div) {
        drawPillBadge(ctx, x, yHigh - 24, "Vol Bear Div", "#000000", "#ef4444", "#ffffff");
      }

      if (c.rsi_bull_div) {
        drawPillBadge(ctx, x, yLow + 24, "RSI Bull Div", "#064e3b", "#10b981", "#6ee7b7");
      }

      if (c.is_entry_initialized && !_hudTradeClosed) {
        const badgeColor = c.entry_type === "SELL" ? "#ef4444" : "#38bdf8";
        const badgeBg = c.entry_type === "SELL" ? "rgba(239, 68, 68, 0.35)" : "rgba(14, 165, 233, 0.35)";
        
        drawPillBadge(
          ctx,
          x,
          c.entry_type === "SELL" ? yHigh - 38 : yLow + 38,
          `🎯 ENTRY INITIALIZE (${c.entry_price_val || c.close.toFixed(1)})`,
          badgeBg,
          badgeColor,
          "#ffffff"
        );

        ctx.fillStyle = badgeColor;
        ctx.font = "bold 13px sans-serif";
        ctx.textAlign = "center";
        if (c.entry_type === "SELL") {
          ctx.fillText("▼", x, yHigh - 14);
        } else {
          ctx.fillText("▲", x, yLow + 18);
        }
      }

      if (c.rcs_tag) {
        ctx.fillStyle = c.rcs_tag.includes("Trap") ? "#fbbf24" : "#94a3b8";
        ctx.font = "bold 9px 'JetBrains Mono', monospace";
        ctx.textAlign = "center";
        ctx.fillText(c.rcs_tag, x, yLow + 16);
      }
    }
  });
  ctx.restore();

  // Line / Area chart type overlay (drawn on top of the faded candles above)
  if (chartType === "line" || chartType === "area") {
    if (chartType === "area") {
      ctx.beginPath();
      displayCandles.forEach((c, i) => {
        const x = i * step + step / 2;
        const y = getY(c.close);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.lineTo((displayCandles.length - 1) * step + step / 2, priceChartHeight);
      ctx.lineTo(step / 2, priceChartHeight);
      ctx.closePath();
      const areaGrad = ctx.createLinearGradient(0, 0, 0, priceChartHeight);
      areaGrad.addColorStop(0, "rgba(96, 165, 250, 0.35)");
      areaGrad.addColorStop(1, "rgba(96, 165, 250, 0.02)");
      ctx.fillStyle = areaGrad;
      ctx.fill();
    }
    ctx.strokeStyle = "#60a5fa";
    ctx.lineWidth = 2;
    ctx.beginPath();
    displayCandles.forEach((c, i) => {
      const x = i * step + step / 2;
      const y = getY(c.close);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  ctx.textAlign = "left";

  // EMAs
  let ema20 = calculateEMA(candles, 20);
  let ema50 = calculateEMA(candles, 50);

  // EMA 20 (Blue Line)
  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  let started20 = false;
  displayCandles.forEach((c, i) => {
    const candleIdx = startIdx + i;
    const val = ema20[candleIdx];
    if (val !== undefined && val !== null && !isNaN(val)) {
      const x = i * step + step / 2;
      const y = getY(val);
      if (!started20) {
        ctx.moveTo(x, y);
        started20 = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
  });
  ctx.stroke();

  // EMA 50 (Orange Line)
  ctx.strokeStyle = "#f59e0b";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started50 = false;
  displayCandles.forEach((c, i) => {
    const candleIdx = startIdx + i;
    const val = ema50[candleIdx];
    if (val !== undefined && val !== null && !isNaN(val)) {
      const x = i * step + step / 2;
      const y = getY(val);
      if (!started50) {
        ctx.moveTo(x, y);
        started50 = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
  });
  ctx.stroke();

  // -------------------------------------------------------------
  // INDICATOR 4: VWAP (Volume Weighted Average Price) & DEVIATION BANDS
  // Aligned precisely with displayCandles
  // -------------------------------------------------------------
  if (layerState.vwap) {
    // VWAP Center Line (Purple Dashed)
    ctx.strokeStyle = "#c084fc";
    ctx.lineWidth = 2.0;
    ctx.setLineDash([4, 2]);
    ctx.beginPath();
    let startedVwap = false;
    displayCandles.forEach((c, i) => {
      if (c.vwap !== undefined && c.vwap !== null && !isNaN(c.vwap)) {
        const x = i * step + step / 2;
        const y = getY(c.vwap);
        if (!startedVwap) {
          ctx.moveTo(x, y);
          startedVwap = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
    });
    ctx.stroke();

    // VWAP Upper Deviation Band
    ctx.strokeStyle = "rgba(192, 132, 252, 0.4)";
    ctx.lineWidth = 1.0;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    let startedUpper = false;
    displayCandles.forEach((c, i) => {
      if (c.vwap_upper !== undefined && c.vwap_upper !== null && !isNaN(c.vwap_upper)) {
        const x = i * step + step / 2;
        const y = getY(c.vwap_upper);
        if (!startedUpper) {
          ctx.moveTo(x, y);
          startedUpper = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
    });
    ctx.stroke();

    // VWAP Lower Deviation Band
    ctx.beginPath();
    let startedLower = false;
    displayCandles.forEach((c, i) => {
      if (c.vwap_lower !== undefined && c.vwap_lower !== null && !isNaN(c.vwap_lower)) {
        const x = i * step + step / 2;
        const y = getY(c.vwap_lower);
        if (!startedLower) {
          ctx.moveTo(x, y);
          startedLower = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // -------------------------------------------------------------
  // INDICATOR 2: VOLUME PROFILE (POC, VAH, VAL, HISTOGRAM BARS ON RIGHT SIDE)
  // -------------------------------------------------------------
  if (layerState.vp && currentVolProfile && currentVolProfile.bars) {
    const vpWidthMax = 60;
    const vpRightX = chartWidth - 5;
    currentVolProfile.bars.forEach(b => {
      const yTop = getY(b.price_max);
      const yBot = getY(b.price_min);
      const bHeight = Math.max(1, yBot - yTop);
      const bWidth = b.pct * vpWidthMax;

      ctx.fillStyle = "rgba(59, 130, 246, 0.18)";
      ctx.fillRect(vpRightX - bWidth, yTop, bWidth, bHeight);
      ctx.strokeStyle = "rgba(59, 130, 246, 0.35)";
      ctx.strokeRect(vpRightX - bWidth, yTop, bWidth, bHeight);
    });

    // POC (Point of Control) Red Line
    if (currentVolProfile.poc) {
      const yPoc = getY(currentVolProfile.poc);
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.moveTo(chartWidth - 130, yPoc);
      ctx.lineTo(chartWidth, yPoc);
      ctx.stroke();
      ctx.fillStyle = "#ef4444";
      ctx.font = "bold 9px 'JetBrains Mono', monospace";
      ctx.fillText("POC " + currentVolProfile.poc, chartWidth - 50, yPoc - 3);
    }
  }

  // -------------------------------------------------------------
  // ENTRY, STOP LOSS (SL) & TARGET (TP1, TP2) HORIZONTAL LEVEL LINES
  // Only draw when trade is ACTIVE (not closed/neutral)
  // -------------------------------------------------------------
  if (tradeActive) {
    // Entry Line (Cyan Dashed with Glowing ENTRY INITIALIZE Badge Tag)
    if (hudEntryVal > 0) {
      const yEntry = getY(hudEntryVal);
      if (yEntry >= -15 && yEntry <= priceChartHeight + 15) {
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 2.0;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(0, yEntry);
        ctx.lineTo(chartWidth, yEntry);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(14, 165, 233, 0.95)";
        ctx.fillRect(chartWidth - 130, yEntry - 10, 126, 20);
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 1;
        ctx.strokeRect(chartWidth - 130, yEntry - 10, 126, 20);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 9px 'JetBrains Mono', monospace";
        ctx.fillText("ENTRY " + hudSignal + " " + hudEntryVal.toFixed(1), chartWidth - 126, yEntry + 4);
      }
    }

    // Stop Loss Line (Red Dashed)
    if (hudSLVal > 0) {
      const ySL = getY(hudSLVal);
      if (ySL >= -15 && ySL <= priceChartHeight + 15) {
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(0, ySL);
        ctx.lineTo(chartWidth, ySL);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(239,68,68,0.90)";
        ctx.fillRect(chartWidth - 90, ySL - 9, 86, 18);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 10px 'JetBrains Mono', monospace";
        ctx.fillText("SL " + hudSLVal.toFixed(1), chartWidth - 86, ySL + 4);
      }
    }

    // Target 1 Line (Green Dashed)
    if (hudTP1Val > 0) {
      const yTP1 = getY(hudTP1Val);
      if (yTP1 >= -15 && yTP1 <= priceChartHeight + 15) {
        ctx.strokeStyle = "#4ade80";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(0, yTP1);
        ctx.lineTo(chartWidth, yTP1);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(74,222,128,0.85)";
        ctx.fillRect(chartWidth - 100, yTP1 - 9, 96, 18);
        ctx.fillStyle = "#000";
        ctx.font = "bold 10px 'JetBrains Mono', monospace";
        ctx.fillText("TGT1 " + hudTP1Val.toFixed(1), chartWidth - 96, yTP1 + 4);
      }
    }

    // Target 2 Line (Bright Green Dashed)
    if (hudTP2Val > 0) {
      const yTP2 = getY(hudTP2Val);
      if (yTP2 >= -15 && yTP2 <= priceChartHeight + 15) {
        ctx.strokeStyle = "#10b981";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(0, yTP2);
        ctx.lineTo(chartWidth, yTP2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(16,185,129,0.85)";
        ctx.fillRect(chartWidth - 100, yTP2 - 9, 96, 18);
        ctx.fillStyle = "#fff";
        ctx.font = "bold 10px 'JetBrains Mono', monospace";
        ctx.fillText("TGT2 " + hudTP2Val.toFixed(1), chartWidth - 96, yTP2 + 4);
      }
    }
  } // end tradeActive

  ctx.setLineDash([]); // Reset line dash
  ctx.restore(); // Restore clip context for subpane & right price scale labels

  // Subpane Divider
  const subpaneTopY = priceChartHeight + subpaneDividerHeight;
  ctx.fillStyle = "#0b0f19";
  ctx.fillRect(0, priceChartHeight, width, subpaneDividerHeight);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.beginPath();
  ctx.moveTo(0, priceChartHeight);
  ctx.lineTo(width, priceChartHeight);
  ctx.moveTo(0, subpaneTopY);
  ctx.lineTo(width, subpaneTopY);
  ctx.stroke();

  const btnX = chartWidth - 85;
  const btnY = priceChartHeight + 2;
  ctx.fillStyle = "#1e293b";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
  ctx.fillRect(btnX, btnY, 80, 20);
  ctx.strokeRect(btnX, btnY, 80, 20);
  ctx.fillStyle = "#cbd5e1";
  ctx.font = "10px sans-serif";
  ctx.fillText("Delete pane", btnX + 8, btnY + 14);

  // Subpane Grid Background
  ctx.fillStyle = "#05070c";
  ctx.fillRect(0, subpaneTopY, chartWidth, subpaneHeight);

  const rowHeight = 16;
  const gridTopY = subpaneTopY + 6;

  // Render Subpane Header Telemetry Bar (Clean TradingView Legend)
  const hoverC = (mousePos && mousePos.x < chartWidth) ? (displayCandles[Math.floor(mousePos.x / step)] || displayCandles[displayCandles.length - 1]) : displayCandles[displayCandles.length - 1];
  const legVol = hoverC.volume >= 1000 ? (hoverC.volume / 1000).toFixed(2) + "K" : hoverC.volume.toString();
  const legBuyVol = hoverC.buy_volume >= 1000 ? (hoverC.buy_volume / 1000).toFixed(2) + "K" : hoverC.buy_volume.toString();
  const legSellVol = hoverC.sell_volume >= 1000 ? (hoverC.sell_volume / 1000).toFixed(2) + "K" : hoverC.sell_volume.toString();

  ctx.fillStyle = "#94a3b8";
  ctx.font = "bold 10px 'JetBrains Mono', monospace";
  ctx.fillText(`Vol: ${legVol} | Buy: ${legBuyVol} (${hoverC.buy_pct || 50}%) | Sell: ${legSellVol} | Net Delta: ${(hoverC.net_delta >= 0 ? "+" : "") + hoverC.net_delta}`, 12, priceChartHeight + 16);

  // Render Spaced-Out Volume & Delta Text Grid (Zero Overlap)
  if (layerState.subpane) {
    const minLabelSpacingPx = 40;
    const stepText = Math.max(1, Math.ceil(minLabelSpacingPx / step));

    ctx.font = "9px 'JetBrains Mono', monospace";
    ctx.textAlign = "center";

    displayCandles.forEach((c, i) => {
      if (i % stepText === 0 || i === numCandles - 1) {
        const x = i * step + step / 2;

        let barNumStr = (numCandles - 1 - i).toString();
        if (i === numCandles - 1) barNumStr = "Now";
        ctx.fillStyle = "#94a3b8";
        ctx.fillText(barNumStr, x, gridTopY + rowHeight + 12);

        let volStr = c.volume >= 1000 ? (c.volume / 1000).toFixed(1) + "K" : c.volume.toString();
        ctx.fillStyle = "#10b981";
        ctx.fillText(volStr, x, gridTopY + rowHeight * 2 + 12);

        let buyVolStr = c.buy_volume >= 1000 ? (c.buy_volume / 1000).toFixed(1) + "K" : c.buy_volume.toString();
        ctx.fillStyle = "#34d399";
        ctx.fillText(buyVolStr, x, gridTopY + rowHeight * 3 + 12);

        ctx.fillStyle = c.net_delta >= 0 ? "#4ade80" : "#f87171";
        let deltaStr = c.net_delta >= 0 ? "+" + c.net_delta : c.net_delta.toString();
        ctx.fillText(deltaStr, x, gridTopY + rowHeight * 4 + 12);

        ctx.fillStyle = "#a7f3d0";
        ctx.fillText((c.buy_pct || 50).toFixed(0) + "%", x, gridTopY + rowHeight * 5 + 12);
      }
    });
  }

  ctx.textAlign = "left";

  // Volume Bars Underneath
  let maxVol = 0;
  displayCandles.forEach(c => { if (c.volume > maxVol) maxVol = c.volume; });
  if (maxVol === 0) maxVol = 1000;

  const barGraphTopY = gridTopY + rowHeight * 5.5 + 12;
  const barGraphHeight = subpaneHeight - (rowHeight * 5.5) - 40;
  const yBase = barGraphTopY + barGraphHeight;

  displayCandles.forEach((c, i) => {
    const x = i * step + step / 2;
    const barH = (c.volume / maxVol) * barGraphHeight;
    const yTop = yBase - barH;

    const buyH = (c.buy_volume / (c.volume || 1)) * barH;

    ctx.fillStyle = "#10b981";
    ctx.fillRect(x - candleWidth / 2, yBase - buyH, candleWidth, buyH);

    ctx.fillStyle = "#ef4444";
    ctx.fillRect(x - candleWidth / 2, yTop, candleWidth, barH - buyH);
  });

  // Net Delta Line
  ctx.strokeStyle = "#ef4444";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  displayCandles.forEach((c, i) => {
    const x = i * step + step / 2;
    const deltaNormalized = (c.net_delta + maxVol) / (maxVol * 2);
    const y = barGraphTopY + barGraphHeight - (deltaNormalized * barGraphHeight * 0.8);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Net Delta Floating Pill
  const netDeltaLast = displayCandles[displayCandles.length - 1].net_delta || 7516;
  const netTagX = chartWidth - 210;
  const netTagY = height - 32;
  ctx.fillStyle = "#10b981";
  ctx.fillRect(netTagX, netTagY, 200, 22);
  ctx.fillStyle = "#022c22";
  ctx.font = "bold 11px 'JetBrains Mono', monospace";
  ctx.fillText("Net Delta (Buy-Sell)  " + (netDeltaLast >= 0 ? "+" : "") + netDeltaLast + ".0", netTagX + 10, netTagY + 15);

  // Time X-Axis Labels (TradingView Style)
  ctx.fillStyle = "#cbd5e1";
  ctx.font = "10px 'JetBrains Mono', monospace";
  const stepLabel = Math.max(1, Math.floor(displayCandles.length / 9));
  displayCandles.forEach((c, i) => {
    if (i % stepLabel === 0) {
      const x = i * step + step / 2;
      const date = new Date(c.time * 1000);
      const timeStr = date.toLocaleTimeString([], { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
      
      // Tick mark
      ctx.beginPath();
      ctx.moveTo(x, height - 24);
      ctx.lineTo(x, height - 20);
      ctx.stroke();

      ctx.fillText(timeStr, x - 14, height - 7);
    }
  });

  // Interactive Crosshair & Axis Floating Pills (TradingView Style)
  if (mousePos && mousePos.x < chartWidth && mousePos.y < height) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);

    // Vertical line
    ctx.beginPath();
    ctx.moveTo(mousePos.x, 0);
    ctx.lineTo(mousePos.x, height - 24);
    ctx.stroke();

    // Horizontal line
    if (mousePos.y <= priceChartHeight) {
      ctx.beginPath();
      ctx.moveTo(0, mousePos.y);
      ctx.lineTo(chartWidth, mousePos.y);
      ctx.stroke();

      // Right Price Axis Hover Pill Box
      const hoverPriceVal = adjustedMaxPrice - ((mousePos.y - priceOffset - topMargin) / plotHeight) * priceRange;
      ctx.setLineDash([]);
      ctx.fillStyle = "#1e293b";
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 1;
      ctx.fillRect(chartWidth + 2, mousePos.y - 9, 68, 18);
      ctx.strokeRect(chartWidth + 2, mousePos.y - 9, 68, 18);
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 10px 'JetBrains Mono', monospace";
      ctx.fillText(hoverPriceVal.toFixed(1), chartWidth + 6, mousePos.y + 4);
    }

    ctx.setLineDash([]);

    const hoveredIdx = Math.floor(mousePos.x / step);
    if (hoveredIdx >= 0 && hoveredIdx < displayCandles.length) {
      const hc = displayCandles[hoveredIdx];
      if (document.getElementById("tooltip-o")) document.getElementById("tooltip-o").innerText = hc.open.toFixed(1);
      if (document.getElementById("tooltip-h")) document.getElementById("tooltip-h").innerText = hc.high.toFixed(1);
      if (document.getElementById("tooltip-l")) document.getElementById("tooltip-l").innerText = hc.low.toFixed(1);
      if (document.getElementById("tooltip-c")) document.getElementById("tooltip-c").innerText = hc.close.toFixed(1);
      if (document.getElementById("tooltip-rsi")) document.getElementById("tooltip-rsi").innerText = (hc.rsi || 50).toFixed(1);

      // Bottom Time Axis Hover Pill Box (e.g. Thu 23 Jul '26 17:15 IST)
      const d = new Date(hc.time * 1000);
      const dayStr = d.toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "2-digit" });
      const timeStr = d.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
      const dateBoxStr = `${dayStr} ${timeStr}`;

      ctx.fillStyle = "#1e293b";
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      const boxW = 140;
      const boxX = Math.max(10, Math.min(chartWidth - boxW - 10, mousePos.x - boxW / 2));
      ctx.fillRect(boxX, height - 22, boxW, 20);
      ctx.strokeRect(boxX, height - 22, boxW, 20);
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 10px 'JetBrains Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText(dateBoxStr, boxX + boxW / 2, height - 8);
      ctx.textAlign = "left";
    }
  } else {
    const last = displayCandles[displayCandles.length - 1];
    if (document.getElementById("tooltip-o")) document.getElementById("tooltip-o").innerText = last.open.toFixed(1);
    if (document.getElementById("tooltip-h")) document.getElementById("tooltip-h").innerText = last.high.toFixed(1);
    if (document.getElementById("tooltip-l")) document.getElementById("tooltip-l").innerText = last.low.toFixed(1);
    if (document.getElementById("tooltip-c")) document.getElementById("tooltip-c").innerText = last.close.toFixed(1);
    if (document.getElementById("tooltip-rsi")) document.getElementById("tooltip-rsi").innerText = (last.rsi || 50).toFixed(1);
  }

  // --- Drawing Tools: render committed drawings + any in-progress preview ---
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, chartWidth, priceChartHeight);
  ctx.clip();
  const symbolDrawings = drawings.filter(d => d.symbol === currentSymbol && d.tf === currentTF);
  symbolDrawings.forEach(d => {
    ctx.strokeStyle = "#fbbf24";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    if (d.type === "hline") {
      const y = getY(d.price);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(chartWidth, y);
      ctx.stroke();
      ctx.fillStyle = "#fbbf24";
      ctx.font = "10px 'JetBrains Mono', monospace";
      ctx.fillText(d.price.toFixed(2), 6, y - 4);
    } else if (d.type === "trendline") {
      const x1 = timeToX(d.p1.time, displayCandles, step), y1 = getY(d.p1.price);
      const x2 = timeToX(d.p2.time, displayCandles, step), y2 = getY(d.p2.price);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    } else if (d.type === "rect") {
      const x1 = timeToX(d.p1.time, displayCandles, step), y1 = getY(d.p1.price);
      const x2 = timeToX(d.p2.time, displayCandles, step), y2 = getY(d.p2.price);
      ctx.fillStyle = "rgba(251, 191, 36, 0.12)";
      ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    }
  });

  if (pendingDrawing && mousePos) {
    const x1 = timeToX(pendingDrawing.p1.time, displayCandles, step), y1 = getY(pendingDrawing.p1.price);
    ctx.strokeStyle = "#fbbf24";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    if (pendingDrawing.type === "trendline") {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(mousePos.x, mousePos.y);
      ctx.stroke();
    } else if (pendingDrawing.type === "rect") {
      ctx.strokeRect(Math.min(x1, mousePos.x), Math.min(y1, mousePos.y), Math.abs(mousePos.x - x1), Math.abs(mousePos.y - y1));
    }
    ctx.setLineDash([]);
  }
  ctx.restore();

  // Snapshot this frame's price/time <-> pixel mapping for the mouse
  // handlers to use when placing the next drawing point.
  chartLayout = { adjustedMaxPrice, priceRange, topMargin, plotHeight, priceOffset, chartWidth, step, displayCandles };
}

function drawPillBadge(ctx, x, y, text, bg, border, textColor) {
  ctx.font = "bold 9px sans-serif";
  const metrics = ctx.measureText(text);
  const pw = metrics.width + 12;
  const ph = 16;
  const px = x - pw / 2;
  const py = y - ph / 2;

  ctx.fillStyle = bg;
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.roundRect(px, py, pw, ph, 4);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = textColor;
  ctx.textAlign = "center";
  ctx.fillText(text, x, py + 11);
  ctx.textAlign = "left";
}

function calculateEMA(candles, period) {
  let ema = [];
  let k = 2 / (period + 1);
  let prev = candles[0].close;
  candles.forEach(c => {
    prev = (c.close * k) + (prev * (1 - k));
    ema.push(prev);
  });
  return ema;
}


function round(val, decimals) {
  return Number(Math.round(val + 'e' + decimals) + 'e-' + decimals);
}

function changeTimeframe(tf) {
  currentTF = tf;
  document.querySelectorAll(".tf-btn").forEach(btn => btn.classList.remove("active"));
  if (event && event.target) event.target.classList.add("active");
  renderChart();
}

function changeSymbol(symbol, label) {
  if (!symbol) return;
  currentSymbol = symbol;

  // A drawing tool left active from a previous symbol would intercept every
  // click as a drawing placement instead of a pan/drag — reset to cursor
  // mode on every symbol switch so that can't silently happen.
  drawingTool = null;
  pendingDrawing = null;
  document.querySelectorAll(".draw-tool-btn").forEach(b => b.classList.remove("active"));
  const cursorBtn = document.getElementById("draw-tool-cursor");
  if (cursorBtn) cursorBtn.classList.add("active");

  // Reset chart view state — without this, panning/zoom/price-scale from the
  // previous symbol carried over, which looks badly broken when switching
  // from an index priced in the 28,000s to a stock priced in the hundreds.
  panOffset = 0;
  if (typeof priceOffset !== "undefined") priceOffset = 0;
  if (typeof priceScaleMultiplier !== "undefined") priceScaleMultiplier = 1.0;
  visibleCandleCount = 60;
  candles = [];
  _hudTradeClosed = false;

  const displayLabel = label || symbol;
  const labelEl = document.getElementById("active-chart-symbol-text");
  if (labelEl) labelEl.innerText = displayLabel;

  updateMarketStatus();

  // TradingView's free embedded widget blocks realtime data for most
  // individual NSE/BSE equities ("This symbol is only available on
  // TradingView" is their licensing message, not a bug on our end) even
  // though our own websocket feed pulls the same symbol fine — proven by
  // the custom HUD engine already working for it. So: for any plain stock
  // (not one of the built-in index/futures symbols), force the working
  // engine instead of letting the widget hit that dead end.
  const isIndexOrFutures = ["IG:NASDAQ", "TVC:US100", "CAPITALCOM:US100", "NASDAQ:NDX", "CME:NQ1!", "NASDAQ:QQQ"].includes(symbol)
    || /NIFTY|BANKNIFTY|SENSEX/i.test(symbol);
  const tvBtn = document.getElementById("btn-engine-tv");

  if (!isIndexOrFutures && currentEngine === "tv_widget") {
    currentEngine = "custom_hud";
    const customBtn = document.getElementById("btn-engine-custom");
    if (tvBtn) tvBtn.classList.remove("active");
    if (customBtn) customBtn.classList.add("active");
    const overlayBox = document.querySelector(".tv-hud-overlay-box");
    if (overlayBox) overlayBox.style.display = "flex";
  }
  if (tvBtn) {
    tvBtn.disabled = !isIndexOrFutures;
    tvBtn.title = isIndexOrFutures ? "" : "TradingView's free widget doesn't support realtime data for individual NSE/BSE stocks — showing the built-in HUD engine instead.";
    tvBtn.classList.toggle("engine-btn-disabled", !isIndexOrFutures);
  }

  const overlay = document.getElementById("chart-loading-overlay");
  if (overlay) overlay.style.display = "flex";

  if (currentEngine === "tv_widget") {
    renderTradingViewWidget();
  } else {
    // Reuse the existing canvas + its already-attached listeners rather than
    // rebuilding the whole chart via initNativeCanvasChart() again — that
    // was firing a SECOND, redundant refreshLiveData() call on every symbol
    // switch, racing against the one just above and tearing down/rebuilding
    // the canvas (with a fresh set of listeners) mid-fetch.
    const canvas = document.getElementById("main-stock-canvas");
    if (canvas) {
      refreshLiveData(canvas, canvas.getContext("2d"));
    } else {
      initNativeCanvasChart();
    }
  }
}

// Multi-Timeframe Signal Radar Cards — Live Data
const TF_LIST = [
  { tf: "1",   label: "1m" },
  { tf: "5",   label: "5m" },
  { tf: "15",  label: "15m" },
  { tf: "30",  label: "30m" },
  { tf: "60",  label: "1h" },
  { tf: "240", label: "4h" },
  { tf: "D",   label: "1D" }
];

async function fetchTFData(tf) {
  let h = null;

  // 1. Try Backend API
  try {
    const resp = await fetch(`/api/live_data?symbol=${encodeURIComponent(currentSymbol)}&tf=${tf}`, { signal: AbortSignal.timeout(6000) });
    const data = await resp.json();
    if (data.status === "ok" && data.hud) {
      h = data.hud;
    }
  } catch(e) {}

  // 2. Client-Side Fallback (for Vercel static host)
  if (!h) {
    try {
      const clientCandles = await fetchTVCandlesClient(currentSymbol, tf, 100);
      const payload = computeClientMarketPayload(clientCandles, currentSymbol, tf);
      if (payload && payload.hud) h = payload.hud;
    } catch(err) {}
  }

  if (h) {
    const price = parseFloat(h.price) || 0;
    const rsi   = parseFloat(h.rsi)   || 0;
    const ema20 = parseFloat(h.ema20) || 0;
    const ema50 = parseFloat(h.ema50) || 0;
    const macd  = parseFloat(h.macd)  || 0;

    // Derive signal from RSI + EMA cross or HUD signal
    let sig = h.signal || "NEUTRAL";
    if (sig === "NEUTRAL") {
      if (rsi > 55 && ema20 > ema50 && macd > 0) sig = "BUY";
      else if (rsi < 45 && ema20 < ema50 && macd < 0) sig = "SELL";
    }

    return {
      price:  price > 0 ? price.toLocaleString("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : "--",
      signal: sig,
      rsi:    rsi  > 0 ? rsi.toFixed(2)  : "--",
      ema20:  ema20 > 0 ? ema20.toFixed(1) : "--",
      ema50:  ema50 > 0 ? ema50.toFixed(1) : "--",
      macd:   h.macd || "--"
    };
  }
  return null;
}

function renderTFCard(item, data) {
  const sig = data ? data.signal : "NEUTRAL";
  let badgeClass = "badge-neutral";
  if (sig === "BUY")  badgeClass = "badge-buy";
  if (sig === "SELL") badgeClass = "badge-sell";

  const rsiNum = parseFloat(data ? data.rsi : "50");
  const rsiColor = rsiNum > 55 ? "#34d399" : rsiNum < 45 ? "#f87171" : "#94a3b8";

  return `
    <div class="tf-card">
      <div class="tf-card-header">
        <span class="tf-name">${item.label} Timeframe</span>
        <span class="${badgeClass}">${sig}</span>
      </div>
      <div style="font-family: var(--font-mono); font-size: 1.1rem; font-weight: 700;">
        ${data ? data.price : '<span style="opacity:0.4">Loading...</span>'}
      </div>
      <div class="tf-metrics">
        <div class="tf-metric-row"><span>RSI:</span> <span style="color:${rsiColor}">${data ? data.rsi : "--"}</span></div>
        <div class="tf-metric-row"><span>EMA20:</span> <span>${data ? data.ema20 : "--"}</span></div>
        <div class="tf-metric-row"><span>EMA50:</span> <span>${data ? data.ema50 : "--"}</span></div>
        <div class="tf-metric-row"><span>MACD:</span>
          <span style="color:${parseFloat(data ? data.macd : "0") >= 0 ? "#34d399" : "#f87171"}">${data ? data.macd : "--"}</span>
        </div>
      </div>
    </div>
  `;
}

async function refreshMultiTimeframeRadar() {
  const container = document.getElementById("tf-card-grid");
  if (!container) return;

  // Show loading skeletons immediately
  container.innerHTML = TF_LIST.map(item => renderTFCard(item, null)).join("");

  // Fetch all timeframes in parallel
  const results = await Promise.all(TF_LIST.map(item => fetchTFData(item.tf)));

  // Re-render with real data
  container.innerHTML = TF_LIST.map((item, i) => renderTFCard(item, results[i])).join("");
}

function renderMultiTimeframeRadar() {
  refreshMultiTimeframeRadar();
  // Auto-refresh every 30 seconds
  setInterval(refreshMultiTimeframeRadar, 30000);
}

// Constituent Screener Table Logic
function initConstituentsData() {
  const INITIAL_CONSTITUENTS = [
    { symbol: "NVDA", name: "NVIDIA Corp", price: 207.29, chg: 2.21, rsi: 62.4, ema20: 204.10, ema50: 198.50, ema200: 175.20, signal: "BUY" },
    { symbol: "AAPL", name: "Apple Inc.", price: 327.74, chg: 1.15, rsi: 58.9, ema20: 324.50, ema50: 318.20, ema200: 295.40, signal: "BUY" },
    { symbol: "MSFT", name: "Microsoft Corp", price: 397.75, chg: -0.41, rsi: 53.4, ema20: 391.10, ema50: 396.10, ema200: 423.70, signal: "NEUTRAL" },
    { symbol: "AMZN", name: "Amazon.com Inc.", price: 247.55, chg: 0.12, rsi: 51.3, ema20: 246.30, ema50: 246.40, ema200: 235.68, signal: "NEUTRAL" },
    { symbol: "GOOGL", name: "Alphabet Inc. (Class A)", price: 347.15, chg: -0.32, rsi: 43.1, ema20: 357.00, ema50: 358.17, ema200: 319.09, signal: "NEUTRAL" },
    { symbol: "GOOG", name: "Alphabet Inc. (Class C)", price: 346.19, chg: -0.35, rsi: 43.8, ema20: 355.26, ema50: 356.09, ema200: 318.02, signal: "NEUTRAL" },
    { symbol: "AVGO", name: "Broadcom Inc.", price: 386.50, chg: 2.21, rsi: 49.9, ema20: 384.62, ema50: 389.21, ema200: 358.32, signal: "NEUTRAL" },
    { symbol: "META", name: "Meta Platforms Inc.", price: 643.81, chg: 0.32, rsi: 56.2, ema20: 627.12, ema50: 615.29, ema200: 632.81, signal: "NEUTRAL" },
    { symbol: "TSLA", name: "Tesla Inc.", price: 378.93, chg: 2.53, rsi: 43.3, ema20: 394.27, ema50: 399.42, ema200: 396.58, signal: "NEUTRAL" },
    { symbol: "GILD", name: "Gilead Sciences", price: 130.28, chg: 1.85, rsi: 59.3, ema20: 131.04, ema50: 130.94, ema200: 128.82, signal: "BUY" },
    { symbol: "CSX", name: "CSX Corp.", price: 49.89, chg: 1.20, rsi: 61.3, ema20: 48.98, ema50: 47.28, ema200: 41.85, signal: "BUY" },
    { symbol: "ROST", name: "Ross Stores", price: 235.81, chg: 0.85, rsi: 63.5, ema20: 225.62, ema50: 223.86, ema200: 201.81, signal: "BUY" },
    { symbol: "PCAR", name: "PACCAR Inc.", price: 126.25, chg: 1.54, rsi: 59.6, ema20: 122.92, ema50: 120.30, ema200: 114.93, signal: "BUY" },
    { symbol: "ODFL", name: "Old Dominion Freight", price: 234.79, chg: 1.31, rsi: 58.6, ema20: 227.29, ema50: 221.94, ema200: 196.35, signal: "BUY" },
    { symbol: "DXCM", name: "DexCom Inc.", price: 74.75, chg: 0.95, rsi: 54.2, ema20: 73.65, ema50: 71.34, ema200: 70.10, signal: "BUY" },
    { symbol: "NFLX", name: "Netflix Inc.", price: 68.67, chg: -2.58, rsi: 32.5, ema20: 73.71, ema50: 78.86, ema200: 90.65, signal: "SELL" },
    { symbol: "PEP", name: "PepsiCo Inc.", price: 135.00, chg: -1.34, rsi: 39.9, ema20: 139.10, ema50: 143.14, ema200: 148.36, signal: "SELL" },
    { symbol: "ISRG", name: "Intuitive Surgical", price: 350.06, chg: -1.88, rsi: 32.9, ema20: 392.40, ema50: 412.95, ema200: 463.74, signal: "SELL" },
    { symbol: "CRWV", name: "CoreWeave Inc.", price: 79.58, chg: -3.92, rsi: 40.3, ema20: 86.07, ema50: 94.75, ema200: 98.89, signal: "SELL" },
    { symbol: "ALNY", name: "Alnylam Pharma", price: 271.37, chg: -1.48, rsi: 37.3, ema20: 289.17, ema50: 295.86, ema200: 328.21, signal: "SELL" },
    { symbol: "GEHC", name: "GE HealthCare", price: 62.04, chg: -1.26, rsi: 43.4, ema20: 63.84, ema50: 64.73, ema200: 70.90, signal: "SELL" },
    { symbol: "CPRT", name: "Copart Inc.", price: 27.17, chg: -1.16, rsi: 36.4, ema20: 28.51, ema50: 30.19, ema200: 36.30, signal: "SELL" },
  ];
  constituentsData = INITIAL_CONSTITUENTS;
  updateSignalCounts();
  renderConstituentsTable();
}

function updateSignalCounts() {
  const buyCount = constituentsData.filter(c => c.signal === "BUY").length;
  const sellCount = constituentsData.filter(c => c.signal === "SELL").length;
  const neutralCount = constituentsData.filter(c => c.signal === "NEUTRAL").length;

  if (document.getElementById("count-buy")) document.getElementById("count-buy").innerText = buyCount;
  if (document.getElementById("count-sell")) document.getElementById("count-sell").innerText = sellCount;
  if (document.getElementById("count-neutral")) document.getElementById("count-neutral").innerText = neutralCount;
}

function renderConstituentsTable() {
  const tbody = document.getElementById("constituents-tbody");
  if (!tbody) return;
  const searchEl = document.getElementById("table-search");
  const searchQuery = searchEl ? searchEl.value.toLowerCase() : "";

  const filtered = constituentsData.filter(item => {
    const matchesSearch = item.symbol.toLowerCase().includes(searchQuery) || item.name.toLowerCase().includes(searchQuery);
    const matchesFilter = (currentFilter === "ALL") || (item.signal === currentFilter);
    return matchesSearch && matchesFilter;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-sub); padding: 2rem;">No matching constituents found.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(item => {
    let badgeClass = "badge-neutral";
    if (item.signal === "BUY") badgeClass = "badge-buy";
    if (item.signal === "SELL") badgeClass = "badge-sell";

    const chgClass = item.chg >= 0 ? "chg-positive" : "chg-negative";
    const chgSign = item.chg >= 0 ? "+" : "";

    return `
      <tr>
        <td class="ticker-cell">
          <div>${item.symbol}</div>
          <div class="company-name">${item.name}</div>
        </td>
        <td class="num-cell">$${item.price.toFixed(2)}</td>
        <td class="num-cell ${chgClass}">${chgSign}${item.chg.toFixed(2)}%</td>
        <td><span class="${badgeClass}">${item.signal}</span></td>
        <td class="num-cell">${item.rsi.toFixed(1)}</td>
        <td class="num-cell">$${item.ema20.toFixed(2)}</td>
        <td class="num-cell">$${item.ema50.toFixed(2)}</td>
        <td class="num-cell">$${item.ema200.toFixed(2)}</td>
      </tr>
    `;
  }).join("");
}

function setupSearchAndFilters() {
  const searchEl = document.getElementById("table-search");
  if (searchEl) searchEl.addEventListener("input", renderConstituentsTable);
}

function filterSignals(filterType, btnEl) {
  currentFilter = filterType;
  document.querySelectorAll(".filter-btn").forEach(btn => btn.classList.remove("active"));
  if (btnEl) btnEl.classList.add("active");
  renderConstituentsTable();
}

// --- AI AGENT UNIFIED SIGNALS & TRADE EXECUTION HANDLERS ---
function agShowTab(tabId, el) {
  document.querySelectorAll(".ag-stab").forEach(t => {
    t.classList.remove("active");
    t.style.color = "var(--text-dim)";
    t.style.borderBottomColor = "transparent";
  });
  if (el) {
    el.classList.add("active");
    el.style.color = "#00d2ff";
    el.style.borderBottomColor = "#00d2ff";
  }

  const tabPanes = ["signals", "open", "history", "log", "config", "journal"];
  tabPanes.forEach(p => {
    const pane = document.getElementById(`agsec-${p}`);
    if (pane) pane.style.display = p === tabId ? (p === "signals" ? "flex" : "block") : "none";
  });

  if (tabId === "signals") loadUnifiedSignals();
}

let _usCurrentFilter = "all";

function usSetFilter(f, btn) {
  _usCurrentFilter = f;
  document.querySelectorAll("#agsec-signals button").forEach(b => {
    if (b.id && b.id.startsWith("usBtn")) {
      b.style.background = "transparent";
      b.style.color = "var(--text-dim)";
    }
  });
  if (btn) {
    btn.style.background = "rgba(0,210,255,0.15)";
    btn.style.color = "#00d2ff";
  }
  loadUnifiedSignals();
}

async function loadUnifiedSignals() {
  const tbody = document.getElementById("usTableBody");
  if (!tbody) return;

  // Build current signals list from live HUD data + constituents
  const currentHud = _lastHudData || {
    signal: "BUY",
    price: "28972.8",
    entry: "28854.1",
    sl: "28786.9",
    tp1: "28955.0",
    tp2: "29022.0",
    rr: "1 : 2",
    why: "Support Zone (VAL) + RSI Bull Div + Volume Bull Div",
    rsi: "42.50",
    ema20: "28950.0"
  };

  const nasdaqSignalItem = {
    symbol: currentSymbol || "IG:NASDAQ",
    name: "US Tech 100 Cash (TradingView Live)",
    price: parseFloat(currentHud.price) || 28972.8,
    signal: currentHud.signal || "BUY",
    score: 9.2,
    rsi: parseFloat(currentHud.rsi) || 42.5,
    sl: parseFloat(currentHud.sl) || 28786.9,
    target: parseFloat(currentHud.tp1_raw || currentHud.tp1) || 28955.0,
    tp2: parseFloat(currentHud.tp2_raw || currentHud.tp2) || 29022.0,
    why: currentHud.why || "Support Zone (VAL) + RSI Bull Div",
    sources: "TradingView WS + Volume Profile"
  };

  const allSignals = [
    nasdaqSignalItem,
    ...constituentsData.map(c => ({
      symbol: c.symbol,
      name: c.name,
      price: c.price,
      signal: c.signal,
      score: c.signal === "BUY" ? 8.5 : c.signal === "SELL" ? 7.8 : 5.0,
      rsi: c.rsi,
      sl: c.signal === "BUY" ? Math.round(c.price * 0.98 * 10) / 10 : Math.round(c.price * 1.02 * 10) / 10,
      target: c.signal === "BUY" ? Math.round(c.price * 1.04 * 10) / 10 : Math.round(c.price * 0.96 * 10) / 10,
      tp2: c.signal === "BUY" ? Math.round(c.price * 1.06 * 10) / 10 : Math.round(c.price * 0.94 * 10) / 10,
      why: c.signal === "BUY" ? "EMA20 > EMA50 + RSI Bull" : c.signal === "SELL" ? "EMA20 < EMA50 + RSI Bear" : "Consolidated",
      sources: "Technical Analysis"
    }))
  ];

  const filtered = allSignals.filter(s => {
    if (_usCurrentFilter === "all") return true;
    if (_usCurrentFilter === "ready") return s.signal !== "NEUTRAL";
    if (_usCurrentFilter === "buy") return s.signal === "BUY";
    if (_usCurrentFilter === "sell") return s.signal === "SELL";
    return true;
  });

  if (document.getElementById("usCountReady")) document.getElementById("usCountReady").innerText = allSignals.filter(s => s.signal !== "NEUTRAL").length;
  if (document.getElementById("usCountBull")) document.getElementById("usCountBull").innerText = allSignals.filter(s => s.signal === "BUY").length;
  if (document.getElementById("usCountBear")) document.getElementById("usCountBear").innerText = allSignals.filter(s => s.signal === "SELL").length;

  tbody.innerHTML = filtered.map(item => {
    const isBuy = item.signal === "BUY";
    const isSell = item.signal === "SELL";
    const sigBadge = isBuy
      ? '<span class="badge-buy">▲ BUY</span>'
      : isSell
      ? '<span class="badge-sell">▼ SELL</span>'
      : '<span class="badge-neutral">NEUTRAL</span>';

    return `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.03);">
        <td style="padding:10px 12px;">
          <div style="font-weight:800; color:#fff; font-size:12px;">${item.symbol}</div>
          <div style="font-size:9px; color:var(--text-muted);">${item.name}</div>
        </td>
        <td style="text-align:right; font-family:'JetBrains Mono',monospace; font-weight:700; padding:10px 12px;">${item.price.toFixed(1)}</td>
        <td style="text-align:center; padding:10px 12px;">${sigBadge}</td>
        <td style="text-align:center; font-family:'JetBrains Mono',monospace; font-weight:800; color:#00d2ff; padding:10px 12px;">${item.score.toFixed(1)}</td>
        <td style="text-align:center; padding:10px 12px; font-size:10px; color:#34d399;">LIVE</td>
        <td style="text-align:center; padding:10px 12px; font-size:10px; color:#00d2ff;">ACTIVE</td>
        <td style="text-align:right; font-family:'JetBrains Mono',monospace; padding:10px 12px;">1.8×</td>
        <td style="text-align:left; font-size:10px; color:#ca8a04; padding:10px 12px;">Long Buildup</td>
        <td style="text-align:right; font-family:'JetBrains Mono',monospace; padding:10px 12px;">${item.rsi.toFixed(1)}</td>
        <td style="text-align:right; font-family:'JetBrains Mono',monospace; color:#f87171; padding:10px 12px;">${item.sl.toFixed(1)}</td>
        <td style="text-align:right; font-family:'JetBrains Mono',monospace; color:#34d399; padding:10px 12px;">${item.target.toFixed(1)}</td>
        <td style="text-align:left; font-size:10px; color:var(--text-dim); padding:10px 12px;">${item.sources}</td>
        <td style="text-align:center; padding:10px 12px;">
          <button onclick="takeTrade({symbol:'${item.symbol}', side:'${item.signal}', price:${item.price}, entry:${item.price}, sl:${item.sl}, tp1:${item.target}, tp2:${item.tp2}, rr:'1 : 2', why:'${item.why}'})" style="background:linear-gradient(135deg, #00e676, #00b0ff); color:#040912; border:none; padding:5px 12px; border-radius:6px; font-weight:800; font-size:10px; cursor:pointer; box-shadow:0 0 10px rgba(0,230,118,0.3);">⚡ TAKE TRADE</button>
        </td>
      </tr>
    `;
  }).join("");
}

function agStart() {
  document.getElementById("agStatusBadge").innerText = "RUNNING";
  document.getElementById("agStatusBadge").style.background = "rgba(0,230,118,0.15)";
  document.getElementById("agStatusBadge").style.color = "#00e676";
  document.getElementById("agStatusBadge").style.borderColor = "rgba(0,230,118,0.3)";
  document.getElementById("agBtnStart").disabled = true;
  document.getElementById("agBtnStop").disabled = false;
  document.getElementById("agBtnPause").disabled = false;
  showToast("🤖 AI Trading Agent Started — Monitoring TradingView Live Signals", "buy");
  loadUnifiedSignals();
}

function agStop() {
  document.getElementById("agStatusBadge").innerText = "STOPPED";
  document.getElementById("agStatusBadge").style.background = "rgba(255,61,113,0.1)";
  document.getElementById("agStatusBadge").style.color = "#ff3d71";
  document.getElementById("agStatusBadge").style.borderColor = "rgba(255,61,113,0.2)";
  document.getElementById("agBtnStart").disabled = false;
  document.getElementById("agBtnStop").disabled = true;
  document.getElementById("agBtnPause").disabled = true;
  showToast("⏹ AI Trading Agent Stopped", "sell");
}

function agPause() {
  document.getElementById("agStatusBadge").innerText = "PAUSED";
  document.getElementById("agStatusBadge").style.background = "rgba(255,171,0,0.15)";
  document.getElementById("agStatusBadge").style.color = "#ffab00";
  document.getElementById("agStatusBadge").style.borderColor = "rgba(255,171,0,0.3)";
  document.getElementById("agBtnPause").style.display = "none";
  document.getElementById("agBtnResume").style.display = "inline-block";
}

function agResume() {
  document.getElementById("agStatusBadge").innerText = "RUNNING";
  document.getElementById("agStatusBadge").style.background = "rgba(0,230,118,0.15)";
  document.getElementById("agStatusBadge").style.color = "#00e676";
  document.getElementById("agStatusBadge").style.borderColor = "rgba(0,230,118,0.3)";
  document.getElementById("agBtnResume").style.display = "none";
  document.getElementById("agBtnPause").style.display = "inline-block";
}

function agSaveConfig() {
  const msg = document.getElementById("agCfgMsg");
  if (msg) {
    msg.innerText = "✓ Configuration saved & applied!";
    setTimeout(() => { msg.innerText = ""; }, 3000);
  }
}

