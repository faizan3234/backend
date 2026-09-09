import asyncio
import json
import time

from websockets.asyncio.server import serve

dropped_once = False

def now():
    return f"{time.time():.3f}"

async def handler(ws):
    global dropped_once

    print(f"[{now()}] CONNECTED")

    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                print(f"[{now()}] BAD JSON: {raw}")
                continue

            msg_type = msg.get("type")

            print(f"[{now()}] {msg_type}: {msg}")

            if msg_type == "CLIENT_HELLO":
                client_id = msg.get("clientId")

                await ws.send(json.dumps({
                    "type": "CONTROLLER_ACTIVE",
                    "clientId": client_id
                }))

                print(
                    f"[{now()}] CONTROLLER_ACTIVE -> {client_id}"
                )

                # Deliberately kill ONLY the first connection.
                # This lets us measure frontend recovery time.
                if not dropped_once:
                    dropped_once = True

                    async def force_drop():
                        await asyncio.sleep(3)
                        print(f"[{now()}] FORCED TEST DISCONNECT")
                        await ws.close(
                            code=1012,
                            reason="RELIV reconnect test"
                        )

                    asyncio.create_task(force_drop())

    except Exception as exc:
        print(f"[{now()}] DISCONNECTED: {exc}")

async def main():
    print("RELIV mock voice server")
    print("ws://127.0.0.1:5100")

    async with serve(
        handler,
        "127.0.0.1",
        5100,
        ping_interval=10,
        ping_timeout=30
    ):
        await asyncio.Future()

asyncio.run(main())
