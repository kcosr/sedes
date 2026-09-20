#!/usr/bin/python3
"""Sedes v3 stdin hook -> Assistant notification with optional response speech.

Sedes settings: absolute script path, no arguments, timeout 30 seconds.
Use --dry-run to print the outgoing fields without contacting Assistant.
The Sedes executor owns the timeout and process group; exec preserves both.
"""

import json
import os
from pathlib import Path
import sys
import unicodedata

NODE = str(Path.home() / ".local/bin/node")
CLI = str(Path.home() / ".local/bin/assistant-notifications-cli")
ASSISTANT_URL = "https://assistant"
EVENT_LABELS = {
    "turn.completed": "Agent finished",
    "turn.failed": "Agent turn failed",
    "turn.interrupted": "Agent turn interrupted",
    "thread.woke": "Snoozed thread woke",
    "automation.started": "Automation started",
    "automation.failed": "Automation failed",
    "approval.requested": "Approval requested",
    "input.requested": "Input requested",
    "notification.test": "Test notification",
}


def text(value, limit=240):
    if not isinstance(value, str):
        raise ValueError("Expected a text field")
    value = "".join(" " if unicodedata.category(c).startswith("C") else c for c in value)
    value = " ".join(value.split())
    if limit is not None and len(value) > limit:
        value = value[:limit - 1].rsplit(" ", 1)[0] + "…"
    return value


def main():
    if sys.argv[1:] not in ([], ["--dry-run"]):
        raise ValueError("Usage: sedes-notify-assistant [--dry-run] < payload.json")
    raw = sys.stdin.buffer.read(1_048_577)
    if len(raw) > 1_048_576:
        raise ValueError("Notification payload exceeds 1 MiB")
    payload = json.loads(raw)
    if not isinstance(payload, dict) or type(payload.get("schemaVersion")) is not int or payload["schemaVersion"] != 3:
        raise ValueError("Expected Sedes notification schemaVersion 3")
    event = payload.get("event")
    if not isinstance(event, str) or event not in EVENT_LABELS:
        raise ValueError("Unsupported notification event")
    notification_id = payload.get("notificationId")
    if not isinstance(notification_id, str) or not notification_id or len(notification_id) > 128 or any(ord(c) < 32 for c in notification_id):
        raise ValueError("Invalid notificationId")
    # Validate the documented display fields, but derive speech from event kind.
    text(payload["title"])
    message = text(payload["message"], 400)
    subject = ""
    if event.startswith("automation."):
        subject = text(payload["automation"]["name"])
    elif event != "notification.test":
        subject = text(payload["thread"]["title"])
    label = EVENT_LABELS[event]
    body_parts = [subject] if subject else []
    if message and message != subject:
        body_parts.append(message)
    workspace = text(payload["workspace"]["name"], None) if "workspace" in payload else ""
    if workspace:
        body_parts.append("Project: " + workspace)
    if event == "automation.failed" and payload["automation"].get("diagnostic"):
        body_parts.append(text(payload["automation"]["diagnostic"]))
    speech_subject = text(payload["thread"]["title"]) if "thread" in payload else subject
    short_subject = text(" ".join(speech_subject.split()[:12]), 80).rstrip(".?!…")
    context = ": ".join(part for part in (workspace, short_subject) if part)
    speech = label + "." + (" " + context + "." if context else "")
    if event == "turn.completed" and "assistantResult" in payload:
        result = payload["assistantResult"]
        if not isinstance(result, dict):
            raise ValueError("Expected an assistantResult object")
        if not set(result).issubset({"provisional", "final", "unclassified"}):
            raise ValueError("Expected selected assistantResult sections")
        # UI selection determines what arrives; finish speech with the final answer.
        for phase in ("provisional", "unclassified", "final"):
            section = result.get(phase)
            if section is None:
                continue
            if not isinstance(section, dict):
                raise ValueError("Expected a text object or null")
            response = text(section["text"], limit=None)
            if response:
                speech += " " + response
    fields = {
        "title": "Sedes: " + label,
        "body": "\n".join(body_parts) or label,
        "tts": True,
        "voiceMode": "speak",
        "ttsText": speech,
        "kind": "notification",
        "source": "cli",
        "sourceEventId": "sedes:" + notification_id,
    }
    if sys.argv[1:] == ["--dry-run"]:
        print(json.dumps(fields, ensure_ascii=False, indent=2))
        return
    # Equals-form arguments keep titles beginning with '-' as literal values.
    args = [NODE, CLI, "create"] + [
        "--" + key + "=" + ("true" if value is True else value)
        for key, value in fields.items()
    ]
    environment = {
        key: value for key, value in os.environ.items()
        if key in {"HOME", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "USER", "LOGNAME", "TMPDIR"}
    }
    environment["ASSISTANT_URL"] = ASSISTANT_URL
    # Explicit home-network policy, scoped to this notification CLI process.
    environment["NODE_TLS_REJECT_UNAUTHORIZED"] = "0"
    # Do not map Sedes thread IDs onto unrelated Assistant session IDs.
    os.execve(NODE, args, environment)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError):
        print("sedes-notify-assistant: invalid input or unavailable notification CLI", file=sys.stderr)
        sys.exit(1)
