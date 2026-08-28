"""Scan running Chrome instances for aistudio-pool CDP profiles and persist a registry.
Run anytime (esp. after launching browsers) so other sessions/models can find + relaunch them."""
import json, re, subprocess, time, os, urllib.request

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "profiles.json")

def scan():
    out = subprocess.run(["wmic","process","where","name='chrome.exe'","get","processid,commandline","/format:csv"],
                         capture_output=True, text=True).stdout
    found = {}
    for line in out.splitlines():
        if "remote-debugging-port" not in line or "user-data-dir" not in line:
            continue
        parts = line.strip().split(",")
        # CSV: Node,CommandLine,ProcessId — but CommandLine itself contains commas,
        # so rejoin everything between the node and the trailing pid.
        cmd = ",".join(parts[1:-1])
        pid = parts[-1]
        m_port = re.search(r"--remote-debugging-port=(\d+)", cmd)
        m_dir  = re.search(r'--user-data-dir="?([^"\s,]+)', cmd)
        if not (m_port and m_dir):
            continue
        prof = m_dir.group(1)
        if "aistudio-chrome-profile" in prof: name = "main"
        elif "acc2-profile" in prof: name = "acc2"
        else:
            base = os.path.basename(prof.rstrip("\\/"))
            name = base if base != "profile" else os.path.basename(os.path.dirname(prof))
        alive = False
        try:
            urllib.request.urlopen(f"http://localhost:{m_port.group(1)}/json/version", timeout=2)
            alive = True
        except Exception:
            pass
        e = found.setdefault(name, {"name": name, "profilePath": prof,
                                    "cdpPort": int(m_port.group(1)), "alive": alive,
                                    "launchCmd": cmd, "pid": pid, "updatedAt": int(time.time()*1000)})
        if alive:
            e.update(alive=True, cdpPort=int(m_port.group(1)), pid=pid, updatedAt=int(time.time()*1000))
    return found

def main():
    os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
    reg = {}
    if os.path.exists(OUT):
        try:
            for e in json.load(open(OUT, encoding="utf-8")):
                reg[e["name"]] = e
        except Exception:
            pass
    for name, e in scan().items():
        reg[name] = e
    entries = sorted(reg.values(), key=lambda x: x["name"])
    json.dump(entries, open(OUT, "w", encoding="utf-8"), indent=1)
    for e in entries:
        print(f"{e['name']:10s} port={e.get('cdpPort','-')!s:5} alive={e.get('alive')} profile={e.get('profilePath','-')}")
    print(f"registry written: {os.path.abspath(OUT)} ({len(entries)} entries)")

if __name__ == "__main__":
    main()
