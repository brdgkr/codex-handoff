from __future__ import annotations

import os
import subprocess


def no_window_kwargs() -> dict:
    if os.name != "nt":
        return {}
    payload = {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
    startupinfo_class = getattr(subprocess, "STARTUPINFO", None)
    if startupinfo_class is None:
        return payload
    startupinfo = startupinfo_class()
    startupinfo.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 0)
    startupinfo.wShowWindow = getattr(subprocess, "SW_HIDE", 0)
    payload["startupinfo"] = startupinfo
    return payload
