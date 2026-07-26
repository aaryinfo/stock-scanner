import websocket
import json
import time

ws = websocket.create_connection(
    "wss://data.tradingview.com/socket.io/websocket",
    headers={"Origin": "https://in.tradingview.com"},
    timeout=5
)

def send_msg(m, p):
    msg = json.dumps({"m": m, "p": p})
    ws.send(f"~m~{len(msg)}~m~{msg}")

session_id = f"cs_{int(time.time()*1000)}"
send_msg("set_auth_token", ["unauthorized_user_token"])
send_msg("chart_create_session", [session_id, ""])

symbol_spec = '={"symbol":"IG:NASDAQ","adjustment":"splits"}'
send_msg("resolve_symbol", [session_id, "sym_1", symbol_spec])
send_msg("create_series", [session_id, "ser_1", "s1", "sym_1", "15", 20, ""])

start = time.time()
while time.time() - start < 5:
    res = ws.recv()
    if "timescale_update" in res:
        parts = res.split("~m~")
        for part in parts:
            if part.startswith("{"):
                try:
                    d = json.loads(part)
                    if d.get("m") == "timescale_update":
                        series = d["p"][1]["ser_1"]["s"]
                        last_bar = series[-1]["v"]
                        print("EXACT REAL LIVE IG:NASDAQ PRICE:", last_bar[4])
                        ws.close()
                        exit(0)
                except Exception as e:
                    pass
ws.close()
print("Timed out")
