#!/usr/bin/env python3
"""Hassfest-like checks of both integrations that need no Home Assistant (stdlib only, for CI and by hand):

  * manifest.json: the keys HACS and Home Assistant expect, domain = folder name, valid JSON
  * services.yaml = services in strings.json = services in every translations/*.json = services registered in code
  * translations/*.json have the same keys as strings.json
  * every websocket command is registered, and every Python file compiles

Usage: python3 tools/check-integrations.py   (exit code 1 on a problem)
"""

from __future__ import annotations

import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
INTEGRATIONS = [ROOT / "custom_components" / "floorplan_card", ROOT / "hausregeln" / "custom_components" / "house_rules"]
MANIFEST_KEYS = ("domain", "name", "codeowners", "config_flow", "dependencies", "documentation", "integration_type", "iot_class", "issue_tracker", "requirements", "version")

problems: list[str] = []


def keys(d: object, prefix: str = "") -> set[str]:
    if not isinstance(d, dict):
        return {prefix}
    out: set[str] = set()
    for k, v in d.items():
        out |= keys(v, f"{prefix}.{k}" if prefix else k)
    return out


def yaml_top_keys(text: str) -> set[str]:
    """Top-level keys of a simple YAML file (services.yaml has no anchors or flow style at the top)."""
    return {m.group(1) for m in re.finditer(r"^([a-z0-9_]+):", text, re.M)}


for comp in INTEGRATIONS:
    name = comp.name
    try:
        manifest = json.loads((comp / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        problems.append(f"{name}: manifest.json unreadable: {err}")
        continue
    for k in MANIFEST_KEYS:
        if k not in manifest:
            problems.append(f"{name}: manifest.json lacks '{k}'")
    if manifest.get("domain") != name:
        problems.append(f"{name}: manifest domain '{manifest.get('domain')}' differs from the folder name")
    for k in ("documentation", "issue_tracker"):
        if not re.match(r"^https://github\.com/[^/]+/[^/]+", str(manifest.get(k, ""))):
            problems.append(f"{name}: manifest '{k}' is not a repository URL")
    if not manifest.get("codeowners"):
        problems.append(f"{name}: manifest has no codeowners")
    if not isinstance(manifest.get("requirements"), list) or any("==" not in r for r in manifest.get("requirements", [])):
        problems.append(f"{name}: requirements must be a list of pinned packages (name==version)")

    strings = json.loads((comp / "strings.json").read_text(encoding="utf-8"))
    for tr in sorted((comp / "translations").glob("*.json")):
        t = json.loads(tr.read_text(encoding="utf-8"))
        if keys(t) != keys(strings):
            problems.append(f"{name}: {tr.name} keys differ from strings.json: {sorted(keys(t) ^ keys(strings))[:8]}")

    code = "\n".join(p.read_text(encoding="utf-8") for p in sorted(comp.glob("*.py")))
    registered = set(re.findall(r'services\.async_register\(\s*DOMAIN,\s*"([a-z0-9_]+)"', code))
    registered |= set(re.findall(r'async_register_admin_service\(\s*hass,\s*DOMAIN,\s*"([a-z0-9_]+)"', code))
    yaml_file = comp / "services.yaml"
    in_yaml = yaml_top_keys(yaml_file.read_text(encoding="utf-8")) if yaml_file.exists() else set()
    in_strings = set(strings.get("services", {}))
    if not registered == in_yaml == in_strings:
        problems.append(f"{name}: services differ – code {sorted(registered)}, services.yaml {sorted(in_yaml)}, strings.json {sorted(in_strings)}")

    # websocket commands: every decorated handler is named again where the commands are registered
    for h in sorted(set(re.findall(r"@websocket_api\.websocket_command\(.*?\n(?:async )?def (\w+)\(", code, re.S))):
        if len(re.findall(rf"\b{h}\b", code)) < 2:
            problems.append(f"{name}: websocket handler {h} is never registered")

    for p in sorted(comp.rglob("*.py")):
        try:
            compile(p.read_text(encoding="utf-8"), str(p), "exec")
        except SyntaxError as err:
            problems.append(f"{p.relative_to(ROOT)}: {err}")

for p in problems:
    print("• FAIL:", p)
print("integrations ok" if not problems else f"{len(problems)} problem(s)")
sys.exit(1 if problems else 0)
