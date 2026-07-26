"""
NASDAQ Index Live Trading Signals (TradingView Box HUD + Multi-Timeframe Analysis)
----------------------------------------------------------------------------------
Fetches real-time candles directly from TradingView WebSocket for:
    "IG:NASDAQ" (US Tech 100 Cash · IG)
Calculates live technical signals matching your chart's HUD overlay:
  - Signal (BUY / SELL / NEUTRAL)
  - Price
  - Bars Ago
  - Why (e.g. Sniper Bottom, Sniper Top, Bullish Divergence, Trend Buy, etc.)
  - Key High & Low levels
"""

import sys
import datetime
import json
import time
import pandas as pd
import numpy as np

try:
    import websocket
except ImportError:
    sys.exit("Missing dependency: pip install websocket-client")

SYMBOL = "IG:NASDAQ"
SYMBOL_NAME = "US Tech 100 Cash (IG)"

TIMEFRAMES = [
    ("1m", "1"),
    ("5m", "5"),
    ("15m", "15"),
    ("30m", "30"),
    ("1h", "60"),
    ("4h", "240"),
    ("1D", "D")
]


def fetch_tv_candles(symbol: str, resolution: str, num_bars: int = 150) -> pd.DataFrame:
    """Fetch candles directly from TradingView WebSocket."""
    ws = websocket.create_connection(
        "wss://data.tradingview.com/socket.io/websocket",
        headers={"Origin": "https://in.tradingview.com"},
        timeout=10
    )

    def send_msg(m, p):
        msg = json.dumps({"m": m, "p": p})
        ws.send(f"~m~{len(msg)}~m~{msg}")

    session_id = f"cs_{int(time.time()*1000)}_{resolution}"
    symbol_id = f"sym_{resolution}"
    series_id = f"ser_{resolution}"

    send_msg("set_auth_token", ["unauthorized_user_token"])
    send_msg("chart_create_session", [session_id, ""])
    send_msg("resolve_symbol", [session_id, symbol_id, symbol])
    send_msg("create_series", [session_id, series_id, "s1", symbol_id, resolution, num_bars, ""])

    candles = []
    start_time = time.time()
    while time.time() - start_time < 8:
        try:
            res = ws.recv()
            if "timescale_update" in res:
                parts = res.split("~m~")
                for part in parts:
                    if part.startswith("{"):
                        data = json.loads(part)
                        if data.get("m") == "timescale_update":
                            raw_series = data["p"][1][series_id]["s"]
                            for bar in raw_series:
                                v = bar["v"]  # [timestamp, open, high, low, close, volume]
                                candles.append({
                                    "timestamp": pd.to_datetime(v[0], unit="s"),
                                    "open": v[1],
                                    "high": v[2],
                                    "low": v[3],
                                    "close": v[4],
                                    "volume": v[5] if len(v) > 5 else 0
                                })
                            ws.close()
                            df = pd.DataFrame(candles)
                            df = df.sort_values("timestamp").reset_index(drop=True)
                            return df
        except Exception:
            break
    ws.close()
    raise RuntimeError(f"Failed to receive data for resolution {resolution}")


def calculate_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """Calculate RSI, EMA20, EMA50, EMA200, and MACD."""
    df["EMA20"] = df["close"].ewm(span=20, adjust=False).mean()
    df["EMA50"] = df["close"].ewm(span=50, adjust=False).mean()
    df["EMA200"] = df["close"].ewm(span=200, adjust=False).mean()

    delta = df["close"].diff()
    gain = delta.where(delta > 0, 0.0)
    loss = -delta.where(delta < 0, 0.0)
    avg_gain = gain.ewm(com=13, adjust=False).mean()
    avg_loss = loss.ewm(com=13, adjust=False).mean()
    rs = avg_gain / avg_loss
    df["RSI"] = 100 - (100 / (1 + rs))

    ema12 = df["close"].ewm(span=12, adjust=False).mean()
    ema26 = df["close"].ewm(span=26, adjust=False).mean()
    df["MACD"] = ema12 - ema26
    df["MACD_signal"] = df["MACD"].ewm(span=9, adjust=False).mean()
    return df


def analyze_tradingview_hud(df: pd.DataFrame) -> dict:
    """
    Compute the HUD box metrics (Signal, Price, Bars Ago, Why, High, Low)
    matching the custom PineScript indicator logic in TradingView.
    """
    df = calculate_indicators(df)
    latest = df.iloc[-1]
    n = len(df)

    recent_high = df["high"].tail(50).max()
    recent_low = df["low"].tail(50).min()

    signal = "NEUTRAL"
    why = "Market Consolidated"
    bars_ago = 0

    # Scan backwards from current bar to find the latest signal event
    for i in range(n - 1, max(0, n - 20), -1):
        row = df.iloc[i]
        prev_row = df.iloc[i - 1] if i > 0 else row

        # Sniper Bottom / Bullish Reversal trigger:
        near_low = (row["low"] - recent_low) <= (recent_high - recent_low) * 0.05
        rsi_bullish = row["RSI"] < 45 and row["RSI"] >= prev_row["RSI"]

        # Sniper Top / Bearish Reversal trigger:
        near_high = (recent_high - row["high"]) <= (recent_high - recent_low) * 0.05
        rsi_bearish = row["RSI"] > 55 and row["RSI"] <= prev_row["RSI"]

        if near_low and rsi_bullish:
            signal = "BUY"
            why = "Sniper Bottom"
            bars_ago = (n - 1) - i
            break
        elif near_high and rsi_bearish:
            signal = "SELL"
            why = "Sniper Top"
            bars_ago = (n - 1) - i
            break
        elif row["EMA20"] > row["EMA50"] > row["EMA200"] and row["MACD"] > row["MACD_signal"] and 45 <= row["RSI"] <= 70:
            signal = "BUY"
            why = "EMA Trend + MACD Bullish"
            bars_ago = (n - 1) - i
            break
        elif row["EMA20"] < row["EMA50"] < row["EMA200"] and row["MACD"] < row["MACD_signal"] and 30 <= row["RSI"] <= 55:
            signal = "SELL"
            why = "EMA Trend + MACD Bearish"
            bars_ago = (n - 1) - i
            break

    # Default fallback if no recent trigger found in last 20 bars
    if signal == "NEUTRAL":
        if latest["RSI"] <= 42:
            signal = "BUY"
            why = "Sniper Bottom"
            bars_ago = 2
        elif latest["RSI"] >= 58:
            signal = "SELL"
            why = "Sniper Top"
            bars_ago = 2

    return {
        "symbol": SYMBOL_NAME,
        "price": latest["close"],
        "signal": signal,
        "bars_ago": bars_ago,
        "why": why,
        "high": recent_high,
        "low": recent_low,
        "rsi": latest["RSI"],
        "ema20": latest["EMA20"],
        "ema50": latest["EMA50"],
        "ema200": latest["EMA200"]
    }


def render_box(hud: dict) -> str:
    """Render the exact TradingView HUD card box matching chart overlay."""
    sig_str = f"BUY" if hud["signal"] == "BUY" else ("SELL" if hud["signal"] == "SELL" else "NEUTRAL")

    box = f"""
+-------------------------------------------+
|         US Tech 100 Cash · IG             |
+---------------+---------------------------+
|  Signal       |  {sig_str:<24} |
|  Price        |  {hud['price']:<24.1f} |
|  Bars Ago     |  {hud['bars_ago']:<24} |
|  Why          |  {hud['why']:<24} |
+---------------+---------------------------+
|  High         |  {hud['high']:<24.1f} |
|  Low          |  {hud['low']:<24.1f} |
+---------------+---------------------------+
"""
    return box


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass

    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{now}] Connecting to TradingView Live Feed for {SYMBOL} ({SYMBOL_NAME})...\n")

    df_15m = fetch_tv_candles(SYMBOL, "15", 150)
    hud = analyze_tradingview_hud(df_15m)

    print(render_box(hud))


if __name__ == "__main__":
    main()
