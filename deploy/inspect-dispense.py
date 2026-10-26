#!/usr/bin/env python3
"""Read-only local job evidence; never publishes MQTT or changes stock/payment."""
import argparse
import json
import sqlite3
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("job_id")
parser.add_argument("--db", type=Path, default=Path(__file__).resolve().parents[1] / "data/kiosk.db")
args = parser.parse_args()
try:
    db = sqlite3.connect(args.db.resolve().as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    row = db.execute("""SELECT job_id, kit_id, motor_id, quantity, state,
        mqtt_published_at, esp32_ack_received_at, esp32_ack_payload, error_message
        FROM fulfillment_jobs WHERE job_id=?""", (args.job_id,)).fetchone()
    if row is None:
        raise SystemExit("Job not found in this database. No changes made.")
    print(json.dumps(dict(row), indent=2))
    print("Motor telemetry is not proof of medicine dropping. No changes made.")
    db.close()
except sqlite3.Error as error:
    raise SystemExit(f"Read-only inspection failed: {error}")
