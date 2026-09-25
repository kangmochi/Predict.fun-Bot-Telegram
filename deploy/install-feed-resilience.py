#!/usr/bin/env python3
"""Timeout + extra Binance hosts + 90s cache + Bybit fallback + BSC RPC failover."""
from __future__ import annotations

import base64
from pathlib import Path

ROOT = Path.home() / "labs/predict-fun-bot"
FEED = ROOT / "bot/predictfun/pricefeed.mjs"
CFG = ROOT / "bot/predictfun/config.mjs"
EXE = ROOT / "bot/predictfun/executor.mjs"
BOT = ROOT / "bot/predict-fun-bot.mjs"

# Filled at generation time; also accepts a sibling copy from this repo.
PRICEFEED_B64 = """
LyoqCiAqIExpdmUgcHJpY2UgY29udGV4dCBmb3IgQ3J5cHRvIFVwL0Rvd24gbWFya2V0cy4KICoK
ICogUHJpbWFyeTogQmluYW5jZSBwdWJsaWMgbWFya2V0IGRhdGEgKG5vIEFQSSBrZXkpLiBIb3N0
cyBhcmUgcmFjZWQgd2l0aCBhCiAqIHNob3J0IHRpbWVvdXQgYmVjYXVzZSBhIGh1bmcgYXBpLmJp
bmFuY2UuY29tIHVzZWQgdG8gYWJvcnQgdGhlIHdob2xlIGN5Y2xlCiAqICgiQWxsIEJpbmFuY2Ug
aG9zdHMgZmFpbGVkIikgYW5kIHNraXAgYSB0cmFkYWJsZSB0aWNrZXQuCiAqCiAqIERlcHRoIC8g
Ym9va1RpY2tlciBhcmUgb3B0aW9uYWw6IGtsaW5lcyBhbG9uZSBhcmUgZW5vdWdoIGZvciBFTUEv
UlNJL01BQ0QuCiAqIElmIGV2ZXJ5IGxpdmUgaG9zdCBmYWlscywgYSBzbmFwc2hvdCB5b3VuZ2Vy
IHRoYW4gOTBzIGlzIHJldXNlZC4gQWZ0ZXIgdGhhdAogKiBCeWJpdCBwdWJsaWMgc3BvdCBpcyB0
aGUgbGFzdCByZXNvcnQuIE5ldmVyIGludmVudCBjYW5kbGVzLgogKi8KCmltcG9ydCB7IHNuYXBz
aG90RnJvbUtsaW5lcyB9IGZyb20gIi4vaW5kaWNhdG9ycy5tanMiOwoKZXhwb3J0IGNvbnN0IEJJ
TkFOQ0VfSE9TVFMgPSBbCiAgImh0dHBzOi8vZGF0YS1hcGkuYmluYW5jZS52aXNpb24iLAogICJo
dHRwczovL2FwaS5iaW5hbmNlLmNvbSIsCiAgImh0dHBzOi8vYXBpMS5iaW5hbmNlLmNvbSIsCiAg
Imh0dHBzOi8vYXBpMi5iaW5hbmNlLmNvbSIsCiAgImh0dHBzOi8vYXBpMy5iaW5hbmNlLmNvbSIs
CiAgImh0dHBzOi8vYXBpNC5iaW5hbmNlLmNvbSIsCl07Cgpjb25zdCBCWUJJVF9CQVNFID0gImh0
dHBzOi8vYXBpLmJ5Yml0LmNvbSI7CmNvbnN0IEZFVENIX1RJTUVPVVRfTVMgPSA0MDAwOwpjb25z
dCBDQUNIRV9NUyA9IDkwXzAwMDsKY29uc3QgSEVBREVSUyA9IHsKICBBY2NlcHQ6ICJhcHBsaWNh
dGlvbi9qc29uIiwKICAiVXNlci1BZ2VudCI6ICJwcmVkaWN0LWZ1bi1ib3QvMS4xIiwKfTsKCmxl
dCBsYXN0R29vZEhvc3QgPSBCSU5BTkNFX0hPU1RTWzBdOwpjb25zdCBjYWNoZSA9IG5ldyBNYXAo
KTsKCmV4cG9ydCBmdW5jdGlvbiByZXNldFByaWNlZmVlZEZvclRlc3RzKCkgewogIGxhc3RHb29k
SG9zdCA9IEJJTkFOQ0VfSE9TVFNbMF07CiAgY2FjaGUuY2xlYXIoKTsKfQoKZXhwb3J0IGZ1bmN0
aW9uIGNhY2hlU2V0Rm9yVGVzdHMoc3ltYm9sLCBjdHgsIGF0ID0gRGF0ZS5ub3coKSkgewogIGNh
Y2hlLnNldChzeW1ib2wsIHsgY3R4LCBhdCB9KTsKfQoKZnVuY3Rpb24gb3JkZXJlZEhvc3RzKCkg
ewogIGNvbnN0IHJlc3QgPSBCSU5BTkNFX0hPU1RTLmZpbHRlcigoaCkgPT4gaCAhPT0gbGFzdEdv
b2RIb3N0KTsKICByZXR1cm4gbGFzdEdvb2RIb3N0ID8gW2xhc3RHb29kSG9zdCwgLi4ucmVzdF0g
OiBbLi4uQklOQU5DRV9IT1NUU107Cn0KCmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaEpzb24o
dXJsLCB7IHRpbWVvdXRNcyA9IEZFVENIX1RJTUVPVVRfTVMgfSA9IHt9KSB7CiAgY29uc3QgY3Ry
bCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTsKICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkg
PT4gY3RybC5hYm9ydCgpLCB0aW1lb3V0TXMpOwogIHRyeSB7CiAgICBjb25zdCByZXMgPSBhd2Fp
dCBmZXRjaCh1cmwsIHsgc2lnbmFsOiBjdHJsLnNpZ25hbCwgaGVhZGVyczogSEVBREVSUyB9KTsK
ICAgIGlmICghcmVzLm9rKSB0aHJvdyBuZXcgRXJyb3IoYEhUVFAgJHtyZXMuc3RhdHVzfWApOwog
ICAgcmV0dXJuIGF3YWl0IHJlcy5qc29uKCk7CiAgfSBjYXRjaCAoZXJyKSB7CiAgICBpZiAoZXJy
Py5uYW1lID09PSAiQWJvcnRFcnJvciIpIHRocm93IG5ldyBFcnJvcihgdGltZW91dCAke3RpbWVv
dXRNc31tc2ApOwogICAgdGhyb3cgbmV3IEVycm9yKGVycj8ubWVzc2FnZSB8fCAiZmV0Y2ggZmFp
bGVkIik7CiAgfSBmaW5hbGx5IHsKICAgIGNsZWFyVGltZW91dCh0aW1lcik7CiAgfQp9CgpmdW5j
dGlvbiBkZXB0aE5vdGlvbmFsKGxldmVscykgewogIGlmICghQXJyYXkuaXNBcnJheShsZXZlbHMp
KSByZXR1cm4gMDsKICBsZXQgc3VtID0gMDsKICBmb3IgKGNvbnN0IHJvdyBvZiBsZXZlbHMpIHsK
ICAgIGNvbnN0IHByaWNlID0gTnVtYmVyKEFycmF5LmlzQXJyYXkocm93KSA/IHJvd1swXSA6IHJv
dy5wcmljZSk7CiAgICBjb25zdCBxdHkgPSBOdW1iZXIoQXJyYXkuaXNBcnJheShyb3cpID8gcm93
WzFdIDogcm93LnF0eSA/PyByb3cucXVhbnRpdHkpOwogICAgaWYgKE51bWJlci5pc0Zpbml0ZShw
cmljZSkgJiYgTnVtYmVyLmlzRmluaXRlKHF0eSkpIHN1bSArPSBwcmljZSAqIHF0eTsKICB9CiAg
cmV0dXJuIHN1bTsKfQoKZnVuY3Rpb24gYXNLbGluZXMocm93cykgewogIGlmICghQXJyYXkuaXNB
cnJheShyb3dzKSB8fCByb3dzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7CiAgcmV0dXJuIHJv
d3M7Cn0KCmV4cG9ydCBmdW5jdGlvbiBhc3NlbWJsZVByaWNlQ29udGV4dChzeW1ib2wsIGtsaW5l
cywgdGlja2VyLCBkZXB0aCwgZXh0cmEgPSB7fSkgewogIGlmICghQXJyYXkuaXNBcnJheShrbGlu
ZXMpIHx8IGtsaW5lcy5sZW5ndGggPT09IDApIHRocm93IG5ldyBFcnJvcihgTm8ga2xpbmVzIGZv
ciAke3N5bWJvbH1gKTsKCiAgY29uc3Qgc25hcHNob3QgPSBzbmFwc2hvdEZyb21LbGluZXMoa2xp
bmVzLCB7CiAgICBiaWQ6IHRpY2tlcj8uYmlkUHJpY2UgPz8gdGlja2VyPy5iaWQxUHJpY2UsCiAg
ICBhc2s6IHRpY2tlcj8uYXNrUHJpY2UgPz8gdGlja2VyPy5hc2sxUHJpY2UsCiAgICBiaWRWb2w6
IGRlcHRoTm90aW9uYWwoZGVwdGg/LmJpZHMgPz8gZGVwdGg/LmIpLAogICAgYXNrVm9sOiBkZXB0
aE5vdGlvbmFsKGRlcHRoPy5hc2tzID8/IGRlcHRoPy5hKSwKICB9KTsKCiAgY29uc3QgY2xvc2Vz
ID0gc25hcHNob3QuY2xvc2VzOwogIGNvbnN0IGN1cnJlbnRQcmljZSA9IHNuYXBzaG90LmNsb3Nl
OwoKICBjb25zdCBwY3RDaGFuZ2UgPSAobWludXRlc0FnbykgPT4gewogICAgY29uc3QgaWR4ID0g
Y2xvc2VzLmxlbmd0aCAtIDEgLSBtaW51dGVzQWdvOwogICAgaWYgKGlkeCA8IDApIHJldHVybiBu
dWxsOwogICAgcmV0dXJuICgoY3VycmVudFByaWNlIC0gY2xvc2VzW2lkeF0pIC8gY2xvc2VzW2lk
eF0pICogMTAwOwogIH07CgogIGNvbnN0IHJldHMgPSBbXTsKICBmb3IgKGxldCBpID0gMTsgaSA8
IGNsb3Nlcy5sZW5ndGg7IGkrKykgcmV0cy5wdXNoKChjbG9zZXNbaV0gLSBjbG9zZXNbaSAtIDFd
KSAvIGNsb3Nlc1tpIC0gMV0pOwogIGNvbnN0IG1lYW4gPSByZXRzLmxlbmd0aCA/IHJldHMucmVk
dWNlKChhLCBiKSA9PiBhICsgYiwgMCkgLyByZXRzLmxlbmd0aCA6IDA7CiAgY29uc3Qgdm9sMW1Q
Y3QgPSByZXRzLmxlbmd0aAogICAgPyBNYXRoLnNxcnQocmV0cy5yZWR1Y2UoKGEsIHIpID0+IGEg
KyAociAtIG1lYW4pICoqIDIsIDApIC8gcmV0cy5sZW5ndGgpICogMTAwCiAgICA6IDA7CgogIGNv
bnN0IGNhbmRsZUxpbmVzID0ga2xpbmVzLnNsaWNlKC0yMCkubWFwKChrKSA9PiB7CiAgICBjb25z
dCB0ID0gbmV3IERhdGUoTnVtYmVyKGtbMF0pKS50b0lTT1N0cmluZygpLnNsaWNlKDExLCAxNik7
CiAgICByZXR1cm4gYCR7dH0gTzoke051bWJlcihrWzFdKX0gSDoke051bWJlcihrWzJdKX0gTDok
e051bWJlcihrWzNdKX0gQzoke051bWJlcihrWzRdKX0gVjoke051bWJlcihrWzVdKS50b0ZpeGVk
KDApfWA7CiAgfSk7CgogIHJldHVybiB7CiAgICBzeW1ib2wsCiAgICBjdXJyZW50UHJpY2UsCiAg
ICBjaGFuZ2U1bVBjdDogcGN0Q2hhbmdlKDUpLAogICAgY2hhbmdlMTVtUGN0OiBwY3RDaGFuZ2Uo
MTUpLAogICAgY2hhbmdlMzBtUGN0OiBwY3RDaGFuZ2UoTWF0aC5taW4oMjksIGNsb3Nlcy5sZW5n
dGggLSAxKSksCiAgICB2b2wxbVBjdCwKICAgIGNhbmRsZUxpbmVzLAogICAgc25hcHNob3QsCiAg
ICB2ZW51ZTogZXh0cmEudmVudWUgfHwgImJpbmFuY2UiLAogICAgZnJvbUNhY2hlOiBCb29sZWFu
KGV4dHJhLmZyb21DYWNoZSksCiAgICBjYWNoZUFnZVNlYzogZXh0cmEuY2FjaGVBZ2VTZWMgPz8g
bnVsbCwKICB9Owp9Cgphc3luYyBmdW5jdGlvbiBrbGluZXNGcm9tSG9zdChob3N0LCBzeW1ib2ws
IGNhbmRsZXMpIHsKICBjb25zdCBkYXRhID0gYXdhaXQgZmV0Y2hKc29uKGAke2hvc3R9L2FwaS92
My9rbGluZXM/c3ltYm9sPSR7c3ltYm9sfSZpbnRlcnZhbD0xbSZsaW1pdD0ke2NhbmRsZXN9YCk7
CiAgY29uc3Qga2xpbmVzID0gYXNLbGluZXMoZGF0YSk7CiAgaWYgKCFrbGluZXMpIHRocm93IG5l
dyBFcnJvcigiZW1wdHkga2xpbmVzIik7CiAgcmV0dXJuIGtsaW5lczsKfQoKYXN5bmMgZnVuY3Rp
b24gYm9va0Zyb21Ib3N0KGhvc3QsIHN5bWJvbCkgewogIGNvbnN0IFt0aWNrZXIsIGRlcHRoXSA9
IGF3YWl0IFByb21pc2UuYWxsKFsKICAgIGZldGNoSnNvbihgJHtob3N0fS9hcGkvdjMvdGlja2Vy
L2Jvb2tUaWNrZXI/c3ltYm9sPSR7c3ltYm9sfWApLmNhdGNoKCgpID0+IG51bGwpLAogICAgZmV0
Y2hKc29uKGAke2hvc3R9L2FwaS92My9kZXB0aD9zeW1ib2w9JHtzeW1ib2x9JmxpbWl0PTIwYCku
Y2F0Y2goKCkgPT4gbnVsbCksCiAgXSk7CiAgcmV0dXJuIHsgdGlja2VyLCBkZXB0aCB9Owp9Cgph
c3luYyBmdW5jdGlvbiBmaXJzdEhvc3RLbGluZXMoc3ltYm9sLCBjYW5kbGVzKSB7CiAgY29uc3Qg
aG9zdHMgPSBvcmRlcmVkSG9zdHMoKTsKICBjb25zdCBlcnJvcnMgPSBbXTsKICBmb3IgKGxldCBp
ID0gMDsgaSA8IGhvc3RzLmxlbmd0aDsgaSArPSAzKSB7CiAgICBjb25zdCBiYXRjaCA9IGhvc3Rz
LnNsaWNlKGksIGkgKyAzKTsKICAgIGNvbnN0IHNldHRsZWQgPSBhd2FpdCBQcm9taXNlLmFsbFNl
dHRsZWQoYmF0Y2gubWFwKChob3N0KSA9PiBrbGluZXNGcm9tSG9zdChob3N0LCBzeW1ib2wsIGNh
bmRsZXMpLnRoZW4oKGtsaW5lcykgPT4gKHsgaG9zdCwga2xpbmVzIH0pKSkpOwogICAgY29uc3Qg
b2sgPSBzZXR0bGVkLmZpbmQoKHIpID0+IHIuc3RhdHVzID09PSAiZnVsZmlsbGVkIik7CiAgICBp
ZiAob2spIHsKICAgICAgbGFzdEdvb2RIb3N0ID0gb2sudmFsdWUuaG9zdDsKICAgICAgcmV0dXJu
IG9rLnZhbHVlOwogICAgfQogICAgZm9yIChjb25zdCByIG9mIHNldHRsZWQpIHsKICAgICAgaWYg
KHIuc3RhdHVzID09PSAicmVqZWN0ZWQiKSBlcnJvcnMucHVzaChyLnJlYXNvbj8ubWVzc2FnZSB8
fCBTdHJpbmcoci5yZWFzb24pKTsKICAgIH0KICB9CiAgdGhyb3cgbmV3IEVycm9yKGVycm9yc1sw
XSB8fCAiYWxsIGhvc3RzIHJlamVjdGVkIik7Cn0KCmZ1bmN0aW9uIGJ5Yml0VG9CaW5hbmNlS2xp
bmVzKGxpc3QpIHsKICAvLyBCeWJpdCBzcG90IGtsaW5lOiBbc3RhcnQsIG9wZW4sIGhpZ2gsIGxv
dywgY2xvc2UsIHZvbHVtZSwgdHVybm92ZXJdLCBuZXdlc3QgZmlyc3QuCiAgY29uc3Qgcm93cyA9
IChsaXN0IHx8IFtdKQogICAgLm1hcCgoaykgPT4gW051bWJlcihrWzBdKSwga1sxXSwga1syXSwg
a1szXSwga1s0XSwga1s1XSwgTnVtYmVyKGtbMF0pICsgNTlfOTk5XSkKICAgIC5zb3J0KChhLCBi
KSA9PiBhWzBdIC0gYlswXSk7CiAgcmV0dXJuIGFzS2xpbmVzKHJvd3MpOwp9Cgphc3luYyBmdW5j
dGlvbiBmcm9tQnliaXQoc3ltYm9sLCBjYW5kbGVzKSB7CiAgY29uc3Qga2xpbmVKc29uID0gYXdh
aXQgZmV0Y2hKc29uKAogICAgYCR7QllCSVRfQkFTRX0vdjUvbWFya2V0L2tsaW5lP2NhdGVnb3J5
PXNwb3Qmc3ltYm9sPSR7c3ltYm9sfSZpbnRlcnZhbD0xJmxpbWl0PSR7Y2FuZGxlc31gLAogICk7
CiAgY29uc3Qga2xpbmVzID0gYnliaXRUb0JpbmFuY2VLbGluZXMoa2xpbmVKc29uPy5yZXN1bHQ/
Lmxpc3QpOwogIGlmICgha2xpbmVzKSB0aHJvdyBuZXcgRXJyb3IoIkJ5Yml0IGVtcHR5IGtsaW5l
cyIpOwoKICBsZXQgdGlja2VyID0gbnVsbDsKICBsZXQgZGVwdGggPSBudWxsOwogIHRyeSB7CiAg
ICBjb25zdCB0ID0gYXdhaXQgZmV0Y2hKc29uKGAke0JZQklUX0JBU0V9L3Y1L21hcmtldC90aWNr
ZXJzP2NhdGVnb3J5PXNwb3Qmc3ltYm9sPSR7c3ltYm9sfWApOwogICAgY29uc3Qgcm93ID0gdD8u
cmVzdWx0Py5saXN0Py5bMF07CiAgICBpZiAocm93KSB0aWNrZXIgPSB7IGJpZFByaWNlOiByb3cu
YmlkMVByaWNlLCBhc2tQcmljZTogcm93LmFzazFQcmljZSB9OwogIH0gY2F0Y2ggewogICAgLyog
b3B0aW9uYWwgKi8KICB9CiAgdHJ5IHsKICAgIGNvbnN0IGQgPSBhd2FpdCBmZXRjaEpzb24oYCR7
QllCSVRfQkFTRX0vdjUvbWFya2V0L29yZGVyYm9vaz9jYXRlZ29yeT1zcG90JnN5bWJvbD0ke3N5
bWJvbH0mbGltaXQ9MjBgKTsKICAgIGRlcHRoID0geyBiaWRzOiBkPy5yZXN1bHQ/LmIsIGFza3M6
IGQ/LnJlc3VsdD8uYSB9OwogIH0gY2F0Y2ggewogICAgLyogb3B0aW9uYWwgKi8KICB9CiAgcmV0
dXJuIGFzc2VtYmxlUHJpY2VDb250ZXh0KHN5bWJvbCwga2xpbmVzLCB0aWNrZXIsIGRlcHRoLCB7
IHZlbnVlOiAiYnliaXQiIH0pOwp9CgpmdW5jdGlvbiBjYWNoZWQoc3ltYm9sKSB7CiAgY29uc3Qg
aGl0ID0gY2FjaGUuZ2V0KHN5bWJvbCk7CiAgaWYgKCFoaXQpIHJldHVybiBudWxsOwogIGNvbnN0
IGFnZSA9IERhdGUubm93KCkgLSBoaXQuYXQ7CiAgaWYgKGFnZSA+IENBQ0hFX01TKSByZXR1cm4g
bnVsbDsKICByZXR1cm4gewogICAgLi4uaGl0LmN0eCwKICAgIGZyb21DYWNoZTogdHJ1ZSwKICAg
IGNhY2hlQWdlU2VjOiBOdW1iZXIoKGFnZSAvIDEwMDApLnRvRml4ZWQoMSkpLAogIH07Cn0KCi8q
KgogKiBTbmFwc2hvdCBvZiB0aGUgbWFya2V0IGNvbnRleHQgZm9yIGBzeW1ib2xgIChlLmcuICJC
VENVU0RUIik6CiAqIGN1cnJlbnQgcHJpY2UsIGluZGljYXRvcnMsIHNwcmVhZCwgYW5kIGJvb2sg
aW1iYWxhbmNlLgogKi8KZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldFByaWNlQ29udGV4dChzeW1i
b2wsIHsgY2FuZGxlcyA9IDgwIH0gPSB7fSkgewogIGxldCBsaXZlRXJyOwogIHRyeSB7CiAgICBj
b25zdCB7IGhvc3QsIGtsaW5lcyB9ID0gYXdhaXQgZmlyc3RIb3N0S2xpbmVzKHN5bWJvbCwgY2Fu
ZGxlcyk7CiAgICBjb25zdCB7IHRpY2tlciwgZGVwdGggfSA9IGF3YWl0IGJvb2tGcm9tSG9zdCho
b3N0LCBzeW1ib2wpOwogICAgY29uc3QgY3R4ID0gYXNzZW1ibGVQcmljZUNvbnRleHQoc3ltYm9s
LCBrbGluZXMsIHRpY2tlciwgZGVwdGgsIHsgdmVudWU6ICJiaW5hbmNlIiB9KTsKICAgIGNhY2hl
LnNldChzeW1ib2wsIHsgY3R4LCBhdDogRGF0ZS5ub3coKSB9KTsKICAgIHJldHVybiBjdHg7CiAg
fSBjYXRjaCAoZXJyKSB7CiAgICBsaXZlRXJyID0gZXJyOwogIH0KCiAgY29uc3Qgd2FybSA9IGNh
Y2hlZChzeW1ib2wpOwogIGlmICh3YXJtKSByZXR1cm4gd2FybTsKCiAgdHJ5IHsKICAgIGNvbnN0
IGN0eCA9IGF3YWl0IGZyb21CeWJpdChzeW1ib2wsIGNhbmRsZXMpOwogICAgY2FjaGUuc2V0KHN5
bWJvbCwgeyBjdHgsIGF0OiBEYXRlLm5vdygpIH0pOwogICAgcmV0dXJuIGN0eDsKICB9IGNhdGNo
IChlcnIpIHsKICAgIHRocm93IG5ldyBFcnJvcihgQWxsIEJpbmFuY2UgaG9zdHMgZmFpbGVkOiAk
e2xpdmVFcnI/Lm1lc3NhZ2V9OyBCeWJpdDogJHtlcnIubWVzc2FnZX1gKTsKICB9Cn0KCi8qKiBQ
cm9iZSB1c2VkIGJ5IC0tY2hlY2suICovCmV4cG9ydCBhc3luYyBmdW5jdGlvbiBwcm9iZUJpbmFu
Y2UoKSB7CiAgdHJ5IHsKICAgIGNvbnN0IGN0eCA9IGF3YWl0IGdldFByaWNlQ29udGV4dCgiQlRD
VVNEVCIsIHsgY2FuZGxlczogODAgfSk7CiAgICBjb25zdCBzcHIgPSBjdHguc25hcHNob3Quc3By
ZWFkQnBzOwogICAgY29uc3QgdmlhID0gY3R4LmZyb21DYWNoZSA/IGBjYWNoZSAke2N0eC5jYWNo
ZUFnZVNlY31zYCA6IGN0eC52ZW51ZTsKICAgIHJldHVybiB7CiAgICAgIG9rOiB0cnVlLAogICAg
ICBkZXRhaWw6IGBCVENVU0RUIEAgJHtjdHguY3VycmVudFByaWNlfSDCtyAke3ZpYX0gwrcgc3By
ZWFkICR7c3ByID09IG51bGwgPyAiPyIgOiBzcHIudG9GaXhlZCgxKX1icHMgwrcgUlNJICR7Y3R4
LnNuYXBzaG90LnJzaT8udG9GaXhlZCgwKX1gLAogICAgfTsKICB9IGNhdGNoIChlcnIpIHsKICAg
IHJldHVybiB7IG9rOiBmYWxzZSwgZGV0YWlsOiBlcnIubWVzc2FnZSB9OwogIH0KfQo=
"""


def write_feed() -> None:
    if PRICEFEED_B64.strip():
        FEED.write_text(base64.b64decode(PRICEFEED_B64).decode())
        print("pricefeed.mjs: OK")
        return
    try:
        src = Path(__file__).resolve().parents[1] / "bot/predictfun/pricefeed.mjs"
    except NameError:
        src = None
    if src is not None and src.exists():
        FEED.write_text(src.read_text())
        print("pricefeed.mjs: OK")
        return
    raise SystemExit("GAGAL: sumber pricefeed.mjs tidak ada")


def replace_once(path: Path, old: str, new: str, label: str, already_mark: str) -> None:
    t = path.read_text()
    if already_mark in t:
        print(f"{label}: sudah")
        return
    if old not in t:
        raise SystemExit(f"GAGAL {label} — pola tidak ketemu")
    path.write_text(t.replace(old, new, 1))
    print(f"{label}: OK")


def main() -> None:
    if not FEED.exists() or not CFG.exists() or not EXE.exists() or not BOT.exists():
        raise SystemExit(f"GAGAL: folder bot tidak lengkap di {ROOT}")
    write_feed()

    replace_once(
        CFG,
        """const network = str("PREDICT_ENV", "mainnet").toLowerCase();
if (!["mainnet", "testnet"].includes(network)) {
  throw new Error(`PREDICT_ENV must be "mainnet" or "testnet", got "${network}"`);
}

const vikeyApiKey = str("VIKEY_API_KEY");
""",
        """const network = str("PREDICT_ENV", "mainnet").toLowerCase();
if (!["mainnet", "testnet"].includes(network)) {
  throw new Error(`PREDICT_ENV must be "mainnet" or "testnet", got "${network}"`);
}

const DEFAULT_BSC_RPCS = [
  "https://bsc-dataseed.binance.org",
  "https://bsc-dataseed1.binance.org",
  "https://bsc-dataseed1.defibit.io",
  "https://bsc.publicnode.com",
  "https://binance.llamarpc.com",
];

function rpcList() {
  const primary = str("BSC_RPC_URL", "");
  const extra = str("BSC_RPC_FALLBACKS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const url of [primary, ...extra, ...DEFAULT_BSC_RPCS]) {
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

const bscRpcUrls = rpcList();

const vikeyApiKey = str("VIKEY_API_KEY");
""",
        "config rpc list",
        "const bscRpcUrls = rpcList();",
    )
    replace_once(
        CFG,
        '  bscRpcUrl: str("BSC_RPC_URL", "https://bsc-dataseed.binance.org"),',
        """  bscRpcUrl: bscRpcUrls[0],
  bscRpcUrls,""",
        "config rpc field",
        "bscRpcUrls,",
    )

    replace_once(
        EXE,
        """let builder = null;
let signer = null;
""",
        """let builder = null;
let signer = null;
let activeRpcUrl = null;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function rpcCandidates() {
  const urls = Array.isArray(config.bscRpcUrls) && config.bscRpcUrls.length ? config.bscRpcUrls : [config.bscRpcUrl];
  return urls.filter(Boolean);
}
""",
        "executor helpers",
        "function rpcCandidates()",
    )
    replace_once(
        EXE,
        """export async function initExecutor() {
  if (builder) return builder;
  if (!config.privateKey) throw new Error("PRIVY_WALLET_PRIVATE_KEY is not set");

  const provider = new JsonRpcProvider(config.bscRpcUrl);
  provider.pollingInterval = 300;
  signer = new Wallet(config.privateKey, provider);

  const chainId = config.network === "mainnet" ? ChainId.BnbMainnet : ChainId.BnbTestnet;
  builder = await OrderBuilder.make(
    chainId,
    signer,
    config.predictAccount ? { predictAccount: config.predictAccount } : undefined,
  );
  return builder;
}
""",
        """export async function initExecutor({ force = false } = {}) {
  if (builder && !force) return builder;
  if (!config.privateKey) throw new Error("PRIVY_WALLET_PRIVATE_KEY is not set");

  const urls = rpcCandidates();
  const chainId = config.network === "mainnet" ? ChainId.BnbMainnet : ChainId.BnbTestnet;
  let lastErr;
  for (const url of urls) {
    try {
      const provider = new JsonRpcProvider(url, Number(chainId), { staticNetwork: true });
      provider.pollingInterval = 300;
      await withTimeout(provider.getBlockNumber(), 5000, `rpc ${url}`);
      signer = new Wallet(config.privateKey, provider);
      builder = await OrderBuilder.make(
        chainId,
        signer,
        config.predictAccount ? { predictAccount: config.predictAccount } : undefined,
      );
      activeRpcUrl = url;
      return builder;
    } catch (err) {
      lastErr = err;
      builder = null;
      signer = null;
      activeRpcUrl = null;
    }
  }
  throw new Error(`No BSC RPC reachable: ${lastErr?.message || "unknown"}`);
}
""",
        "executor init",
        "initExecutor({ force = false }",
    )
    replace_once(
        EXE,
        """export async function collateralBalanceUsd() {
  await initExecutor();
  const wei = await builder.balanceOf();
  return Number(formatEther(wei));
}
""",
        """export async function collateralBalanceUsd() {
  await initExecutor();
  try {
    const wei = await withTimeout(builder.balanceOf(), 6000, "bankroll");
    return Number(formatEther(wei));
  } catch (firstErr) {
    builder = null;
    signer = null;
    await initExecutor({ force: true });
    try {
      const wei = await withTimeout(builder.balanceOf(), 6000, "bankroll-retry");
      return Number(formatEther(wei));
    } catch (retryErr) {
      throw new Error(`${firstErr.message}; retry ${retryErr.message}`);
    }
  }
}
""",
        "executor bankroll",
        'withTimeout(builder.balanceOf(), 6000, "bankroll")',
    )

    replace_once(
        BOT,
        """        const priceCtx = await getPriceContext(d.priceFeedSymbol);
        const gapPct = ((priceCtx.currentPrice - d.startPrice) / d.startPrice) * 100;
        extraInfo = `strike ${d.startPrice} · now ${priceCtx.currentPrice} (${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(3)}%) · ${minutesRemaining === null ? "?" : minutesRemaining.toFixed(0)}m left`;
""",
        """        const priceCtx = await getPriceContext(d.priceFeedSymbol);
        const gapPct = ((priceCtx.currentPrice - d.startPrice) / d.startPrice) * 100;
        extraInfo = `strike ${d.startPrice} · now ${priceCtx.currentPrice} (${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(3)}%) · ${minutesRemaining === null ? "?" : minutesRemaining.toFixed(0)}m left`;
        if (priceCtx.fromCache) extraInfo += ` · feed cache ${priceCtx.cacheAgeSec}s`;
        else if (priceCtx.venue && priceCtx.venue !== "binance") extraInfo += ` · feed ${priceCtx.venue}`;
""",
        "bot feed tag",
        "feed cache",
    )
    replace_once(
        BOT,
        "    log(`live bankroll fetch failed (${err.message}) — fallback BANKROLL_USD=$${config.strategy.bankrollUsd}`);\n",
        """    const last = config.strategy.liveBankrollUsd;
    const keep = Number.isFinite(last) ? `keep last live $${Number(last).toFixed(2)}` : `fallback BANKROLL_USD=$${config.strategy.bankrollUsd}`;
    log(`live bankroll fetch failed (${err.message}) — ${keep}`);
""",
        "bot bankroll log",
        "keep last live",
    )

    feed = FEED.read_text()
    print("INSTALL FEED SELESAI")
    print("grep CACHE_MS", feed.count("CACHE_MS"))
    print("grep bybit", feed.count("bybit"))
    print("grep rpcCandidates", EXE.read_text().count("rpcCandidates"))
    print("grep feed cache", BOT.read_text().count("feed cache"))


if __name__ == "__main__":
    main()
